"""本地测试用的 S3 Vectors / Bedrock 替身：内存实现，按真实接口的上限与规则校验请求，违反就抛 ClientError。

照搬的规则（boto3 1.43 服务模型 + AWS 文档）：
- PutVectors 1~500 条、GetVectors 1~100 个键、DeleteVectors 1~500 个键、ListVectors 每页 ≤ 1000；
- 索引名 3~63 位，只能用小写字母、数字、连字符、点，首尾是字母或数字（不合规的名字建不了索引，
  读写时服务回 ValidationException「Invalid index name」，2026-10-29 在现有桶上用 get-index 实测）；
- 键 1~1024 字符；向量维度必须等于索引维度；
- 每条向量的可过滤元数据 ≤ 2 KB、元数据合计 ≤ 40 KB、键 ≤ 50 个；
- 过滤条件只能引用可过滤的键（引用不可过滤的键按校验错误处理，比真实服务更严）；
- 列表型元数据：$eq 表示「包含该元素」，$in 表示「任一元素在列表里」。
Bedrock 替身按「字符二元组散列」生成确定性的 1536 维向量：共有的二元组越多，余弦相似度越高。
"""
import hashlib
import io
import json
import math
import re
from collections import Counter

from botocore.exceptions import ClientError


INDEX_NAME_RE = re.compile(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]")


def _err(code, msg, op):
    return ClientError({"Error": {"Code": code, "Message": msg}}, op)


class FakeS3Vectors:
    def __init__(self, bucket, indexes):
        """indexes: {name: {"dimension": int, "non_filterable": [..]}}"""
        self.bucket = bucket
        bad = [n for n in indexes if not INDEX_NAME_RE.fullmatch(n)]
        if bad:
            raise _err("ValidationException", f"Invalid index name: {bad}", "CreateIndex")
        self.indexes = {n: {"dimension": c["dimension"], "non_filterable": set(c.get("non_filterable", []))}
                        for n, c in indexes.items()}
        self.store = {n: {} for n in indexes}
        self.calls = Counter()
        self.listed_with_metadata = Counter()   # 按索引统计带元数据的 ListVectors 次数
        self.deny = False
        self.fail_put_on = None   # 指定索引名：对该索引的 PutVectors 抛错（模拟写到一半失败）
        self.ann_shortfall = False  # 模拟实测的近似检索：命中数达到 topK 时少回一条（topK=1 时一条都不回）

    # ---- 内部 ----
    def _check(self, op, vectorBucketName, indexName):
        self.calls[op] += 1
        if not INDEX_NAME_RE.fullmatch(str(indexName)):
            raise _err("ValidationException", "Invalid index name", op)
        if self.deny:
            raise _err("AccessDeniedException", "denied", op)
        if vectorBucketName != self.bucket:
            raise _err("NotFoundException", "vector bucket not found", op)
        if indexName not in self.indexes:
            raise _err("NotFoundException", "index not found", op)
        return self.indexes[indexName]

    @staticmethod
    def _size(obj):
        return len(json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    # ---- 接口 ----
    def put_vectors(self, vectorBucketName, indexName, vectors):
        cfg = self._check("PutVectors", vectorBucketName, indexName)
        if self.fail_put_on == indexName:
            raise _err("InternalServerException", "simulated failure", "PutVectors")
        if not 1 <= len(vectors) <= 500:
            raise _err("ValidationException", f"vectors must have 1..500 items, got {len(vectors)}", "PutVectors")
        for v in vectors:
            key = v.get("key", "")
            if not 1 <= len(key) <= 1024:
                raise _err("ValidationException", "bad key length", "PutVectors")
            data = (v.get("data") or {}).get("float32")
            if not isinstance(data, list) or len(data) != cfg["dimension"]:
                raise _err("ValidationException", f"dimension mismatch for {key}", "PutVectors")
            if not any(abs(x) > 0 for x in data):
                raise _err("ValidationException", "zero vector not allowed for cosine", "PutVectors")
            md = v.get("metadata") or {}
            if len(md) > 50:
                raise _err("ValidationException", "too many metadata keys", "PutVectors")
            filterable = {k: x for k, x in md.items() if k not in cfg["non_filterable"]}
            if self._size(filterable) > 2048:
                raise _err("ValidationException", f"filterable metadata over 2KB for {key}", "PutVectors")
            if self._size(md) > 40 * 1024:
                raise _err("ValidationException", f"metadata over 40KB for {key}", "PutVectors")
        for v in vectors:
            self.store[indexName][v["key"]] = {"data": [float(x) for x in v["data"]["float32"]],
                                               "metadata": json.loads(json.dumps(v.get("metadata") or {}))}
        return {}

    def get_vectors(self, vectorBucketName, indexName, keys, returnData=False, returnMetadata=False):
        self._check("GetVectors", vectorBucketName, indexName)
        if not 1 <= len(keys) <= 100:
            raise _err("ValidationException", f"keys must have 1..100 items, got {len(keys)}", "GetVectors")
        out = []
        for k in keys:
            rec = self.store[indexName].get(k)
            if rec is None:
                continue
            item = {"key": k}
            if returnData:
                item["data"] = {"float32": list(rec["data"])}
            if returnMetadata:
                item["metadata"] = json.loads(json.dumps(rec["metadata"]))
            out.append(item)
        return {"vectors": out}

    def list_vectors(self, vectorBucketName, indexName, maxResults=500, nextToken=None,
                     returnMetadata=False, returnData=False, **_):
        self._check("ListVectors", vectorBucketName, indexName)
        if returnMetadata:
            self.listed_with_metadata[indexName] += 1
        if not 1 <= maxResults <= 1000:
            raise _err("ValidationException", "maxResults must be 1..1000", "ListVectors")
        keys = list(self.store[indexName])
        start = int(nextToken or 0)
        page = keys[start:start + maxResults]
        out = []
        for k in page:
            rec = self.store[indexName][k]
            item = {"key": k}
            if returnMetadata:
                item["metadata"] = json.loads(json.dumps(rec["metadata"]))
            if returnData:
                item["data"] = {"float32": list(rec["data"])}
            out.append(item)
        resp = {"vectors": out}
        if start + maxResults < len(keys):
            resp["nextToken"] = str(start + maxResults)
        return resp

    def delete_vectors(self, vectorBucketName, indexName, keys):
        self._check("DeleteVectors", vectorBucketName, indexName)
        if not 1 <= len(keys) <= 500:
            raise _err("ValidationException", f"keys must have 1..500 items, got {len(keys)}", "DeleteVectors")
        for k in keys:
            self.store[indexName].pop(k, None)
        return {}

    def query_vectors(self, vectorBucketName, indexName, topK, queryVector, filter=None,
                      returnMetadata=False, returnDistance=False, **_):
        cfg = self._check("QueryVectors", vectorBucketName, indexName)
        if not 1 <= topK <= 100:
            raise _err("ValidationException", "topK must be 1..100 in this fake", "QueryVectors")
        q = queryVector["float32"]
        if len(q) != cfg["dimension"]:
            raise _err("ValidationException", "query dimension mismatch", "QueryVectors")
        if filter is not None:
            self._validate_filter(filter, cfg["non_filterable"])
        scored = []
        for k, rec in self.store[indexName].items():
            if filter is not None and not _match(filter, rec["metadata"]):
                continue
            scored.append((1.0 - _cos(q, rec["data"]), k, rec))
        scored.sort(key=lambda t: t[0])
        picked = scored[:topK]
        if self.ann_shortfall and len(picked) == topK:
            picked = picked[:-1]
        out = []
        for dist, k, rec in picked:
            item = {"key": k}
            if returnDistance:
                item["distance"] = dist
            if returnMetadata:
                item["metadata"] = json.loads(json.dumps(rec["metadata"]))
            out.append(item)
        return {"vectors": out, "distanceMetric": "cosine"}

    def get_index(self, vectorBucketName, indexName):
        cfg = self._check("GetIndex", vectorBucketName, indexName)
        return {"index": {"vectorBucketName": vectorBucketName, "indexName": indexName, "dimension": cfg["dimension"],
                          "distanceMetric": "cosine", "dataType": "float32", "indexMode": "ENHANCED",
                          "metadataConfiguration": {"nonFilterableMetadataKeys": sorted(cfg["non_filterable"])}}}

    def _validate_filter(self, f, non_filterable):
        if not isinstance(f, dict) or not f:
            raise _err("ValidationException", "filter must be a non-empty object", "QueryVectors")
        for k, v in f.items():
            if k in ("$and", "$or"):
                if not isinstance(v, list) or not v:
                    raise _err("ValidationException", f"{k} needs a non-empty list", "QueryVectors")
                for sub in v:
                    self._validate_filter(sub, non_filterable)
            elif k.startswith("$"):
                raise _err("ValidationException", f"unknown operator {k}", "QueryVectors")
            elif k in non_filterable:
                raise _err("ValidationException", f"key {k} is non-filterable", "QueryVectors")


def _cos(a, b):
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(x * x for x in b)) or 1.0
    return sum(x * y for x, y in zip(a, b)) / (na * nb)


def _match(f, md):
    for k, cond in f.items():
        if k == "$and":
            if not all(_match(s, md) for s in cond):
                return False
        elif k == "$or":
            if not any(_match(s, md) for s in cond):
                return False
        else:
            if not _match_field(md.get(k, _MISSING), cond):
                return False
    return True


_MISSING = object()


def _match_field(value, cond):
    if not isinstance(cond, dict):          # 简写 {"field": value} = $eq
        cond = {"$eq": cond}
    for op, arg in cond.items():
        is_list = isinstance(value, list)
        if op == "$exists":
            ok = (value is not _MISSING) == bool(arg)
        elif value is _MISSING:
            ok = op in ("$ne", "$nin")
        elif op == "$eq":
            ok = (arg in value) if is_list else value == arg
        elif op == "$ne":
            ok = (arg not in value) if is_list else value != arg
        elif op == "$in":
            ok = any(x in arg for x in value) if is_list else value in arg
        elif op == "$nin":
            ok = not any(x in arg for x in value) if is_list else value not in arg
        elif op in ("$gt", "$gte", "$lt", "$lte"):
            if is_list or isinstance(value, bool) or not isinstance(value, (int, float)):
                ok = False
            else:
                ok = {"$gt": value > arg, "$gte": value >= arg, "$lt": value < arg, "$lte": value <= arg}[op]
        else:
            raise _err("ValidationException", f"unknown operator {op}", "QueryVectors")
        if not ok:
            return False
    return True


class FakeBedrock:
    def __init__(self, deny_models=()):
        self.deny_models = set(deny_models)
        self.calls = Counter()
        self.texts_embedded = 0

    def invoke_model(self, modelId, body, contentType=None, accept=None):
        self.calls[modelId] += 1
        if modelId in self.deny_models:
            raise _err("AccessDeniedException", f"not authorized to invoke {modelId}", "InvokeModel")
        b = json.loads(body)
        texts = b.get("texts")
        assert isinstance(texts, list) and 1 <= len(texts) <= 96, "Cohere v4 texts must be 1..96"
        assert b.get("input_type") in ("search_document", "search_query"), b.get("input_type")
        assert b.get("embedding_types") == ["float"]
        dim = b.get("output_dimension")
        assert dim in (256, 512, 1024, 1536), dim
        self.texts_embedded += len(texts)
        vecs = [embed(t, dim) for t in texts]
        return {"body": io.BytesIO(json.dumps({"embeddings": {"float": vecs}}).encode("utf-8"))}


def embed(text, dim=1536):
    vec = [0.0] * dim
    s = "".join(str(text).split())
    # 每个不同的二元组只计一次：否则高度重复的长文本会让少数维度过大，散列碰撞的噪声盖过真实的相似
    grams = {s[i:i + 2] for i in range(max(1, len(s) - 1))}
    for g in sorted(grams):
        h = hashlib.md5(g.encode("utf-8")).digest()
        idx = int.from_bytes(h[:4], "little") % dim
        vec[idx] += 1.0 if h[4] & 1 else -1.0
    n = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / n for x in vec] if any(vec) else [1.0] + [0.0] * (dim - 1)
