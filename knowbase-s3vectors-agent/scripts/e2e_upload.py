"""经 Nexus Operator 把一个本地文件上传成会话附件（与 knowbase-writer-agent 同一份脚本）：presign → PUT 到预签名地址 → confirm。

签名地址只在内存里用一次，不打印、不落盘。Operator 的 `chat` 不能带附件，所以端到端测试走这条路，
再用 `call POST /api/v2/sessions/{session_id}/stream` 带上 attachment_ids 发消息。

用法：
  NEXUS_OPERATOR=<…/nexus-ai-operator/scripts/nexus.py> NEXUS_PROFILE=<profile> \
  python3 -I e2e_upload.py <session_id> <file>
"""
import json
import os
import subprocess
import sys
import urllib.request

OP = ["python3", "-I", os.environ["NEXUS_OPERATOR"], "--profile", os.environ.get("NEXUS_PROFILE", "default"), "--json"]
CONTENT_TYPES = {".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                 ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                 ".pdf": "application/pdf"}


def op(*args):
    r = subprocess.run(OP + list(args), capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(f"operator rc={r.returncode}: {r.stderr[-400:]}")
    return json.loads(r.stdout)


def main():
    sid, path = sys.argv[1], sys.argv[2]
    ctype = CONTENT_TYPES.get(os.path.splitext(path)[1].lower(), "application/octet-stream")
    size = os.path.getsize(path)
    pre = op("call", "POST", "/api/v2/sessions/{session_id}/attachments/presign-upload", "-p", f"session_id={sid}",
             "--data", json.dumps({"filename": os.path.basename(path), "content_type": ctype, "file_size": size}), "--yes")
    data = pre.get("data") or {}
    aid, url = data.get("attachment_id"), data.get("upload_url")
    print("presign ok:", pre.get("ok"), "attachment_id:", aid, "expires_in:", data.get("expires_in"))
    # 预签名地址签了 Content-Type，PUT 时必须带同一个值
    req = urllib.request.Request(url, data=open(path, "rb").read(), method="PUT", headers={"Content-Type": ctype})
    with urllib.request.urlopen(req, timeout=60) as resp:
        print("PUT status:", resp.status)
    del url
    conf = op("call", "POST", "/api/v2/sessions/{session_id}/attachments", "-p", f"session_id={sid}",
              "--data", json.dumps({"attachment_id": aid}), "--yes")
    c = conf.get("data") or {}
    print("confirm ok:", conf.get("ok"), {k: c.get(k) for k in ("attachment_id", "filename", "status", "file_size")})


if __name__ == "__main__":
    main()
