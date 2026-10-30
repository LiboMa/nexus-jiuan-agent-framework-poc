"""检索回归：用审核 Agent 用的同一个 kb_search，把两套题各问一遍，看标准答案（gold 里的规则编号）排在第几。
换向量模型前跑一次（基线），换完再跑一次，然后 --compare 两个结果。

用法（由 deploy.sh regress 调用；连接经 SSM 端口转发到 127.0.0.1:<port>，以应用用户）:
    python3 -I kb_regression.py --host 127.0.0.1 --port 15432 --db nexus --user nexus --password-file <600 文件> \\
        --questions-dir <题库目录> --label titan [--out ~/Documents/pgkb-regression] [--table approval_rules]
    python3 -I kb_regression.py --questions-dir <目录> --label <名字> [--out <目录>] --check   # 只校验，不连库
    python3 -I kb_regression.py --compare a.json b.json                                         # 只对比

  题库目录里是 questions.json（主题库）和 questions_robust.json（换说法的题），都是 [{id, q, gold, cat, seg, amt}, …]，
  gold 是规则编号（一个或一组，排得最前的那个算名次）。每题调 kb_search(q, 8, NULL, 'kb-regression')，另问 KNOWN 里的已知问题。
  结果写到 <out>/<label>.json（600；目录 700；同名的不覆盖）：
    {label, at, embed_model, sets: {main: {n, hit1, hit5}, robust: {…}},
     known: [{expect: [编号…], rank: {编号: 名次|None}, ok}], items: [{id, set, top8, rank}]}
  --compare a b：b 里哪一套题的 hit5 比 a 低、题数不同，或者 b 的 known 有不过的，退出码 1；打印逐题、逐个已知编号的名次变化。

已知问题（KNOWN，Spec 第 1 节第 3 条）：每项的期望编号是一组，组里每一个都要在前 N 名。--compare 按本文件现在的 KNOWN 判
（口径改过，旧结果也照现在的口径重判，不信文件里记的 ok）：
  - 结果文件里的 known 项按编号认：与 KNOWN 某一题的组有共同编号的那一项就是这一题（各组的编号不重）。
  - 旧格式（10-30 改口径以前写的：expect 是一个编号、rank 是它的名次）当成只有一个编号的组。组里别的编号文件里没有名次，
    记「未记」（不是「不在前 8」，那个记 —），不编名次；这一题按记了的编号判，输出里注明只记了哪几个。
  - 新结果里对不上 KNOWN 某一题 → 不过。
题库由真实制度派生：题库和结果目录在仓库里就拒绝；结果文件、输出里只有题号、规则编号和计数，不含题目文字（已知问题的问句
只在本文件里，不写进结果文件；旧结果文件里的 q 不读出来打印）。kb_search 全库每分钟至多 60 次（与审核 Agent 共用）：这里每分钟
至多 50 次；撞上库里的上限就等一分钟再问同一题，三次都撞上就报 rate_limited 退出，不当成「没查到」。
退出码：0 正常 / 持平，1 对比变差，2 参数、题库、结果文件、连库或检索出错。
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

if __package__:
    from . import kb_store
else:  # python -I kb/lib/kb_regression.py：-I 不把脚本所在目录放进 sys.path
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import kb_store

SETS = (("main", "questions.json"), ("robust", "questions_robust.json"))
# (问题, 期望的编号（一组：每个都要在）, 要在前几名)。C05-3.3 / C05-3.4 两条只差金额档，问题里没有金额，两条都对。
KNOWN = [("30万合同用印", ("C03-1.2",), 3), ("房租 年度框架合同 九安", ("C05-3.3", "C05-3.4"), 2)]
SEARCH_SQL = "SELECT rule_id FROM kb_search(%s, 8, NULL, 'kb-regression')"
PER_MINUTE = 50
RATE_MARK = "每分钟最多"          # kb_search / kb_embed 的每分钟上限报错里都有这几个字
RATE_WAIT, RATE_TRIES = 60, 3
ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
TABLE_RE = re.compile(r"[a-z_][a-z0-9_]*")
DEFAULT_OUT = Path.home() / "Documents" / "pgkb-regression"


class Fail(Exception):
    """参数、题库、连库或检索出错（退出码 2）。消息里不带题目文字。"""


# ─────────────── 题库与计分 ───────────────

def load_sets(qdir):
    """读两套题 → {"main": [{id, q, gold}], "robust": [...]}。报错只说文件和第几题，不带题目文字。"""
    sets = {}
    for name, file in SETS:
        path = Path(qdir) / file
        try:
            items = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise Fail(f"题库里没有 {file}") from None
        except (OSError, UnicodeDecodeError, ValueError) as e:
            raise Fail(f"{file} 读不出来（{type(e).__name__}）") from None
        if not isinstance(items, list):
            raise Fail(f"{file} 要是题目的列表")
        out, seen = [], set()
        for n, item in enumerate(items, 1):
            if not isinstance(item, dict):
                raise Fail(f"{file} 第 {n} 题不是对象")
            qid, q, gold = item.get("id"), item.get("q"), item.get("gold")
            if not isinstance(qid, str) or not ID_RE.fullmatch(qid):
                raise Fail(f"{file} 第 {n} 题的题号不合规：只能是字母、数字、点、横线、下划线（结果文件里只放题号）")
            if qid in seen:
                raise Fail(f"{file} 题号 {qid} 重复")
            seen.add(qid)
            if not isinstance(q, str) or not q.strip():
                raise Fail(f"{file} 题 {qid} 没有题目")
            gold = [gold] if isinstance(gold, str) else gold
            if not isinstance(gold, list) or not gold or not all(isinstance(g, str) and g for g in gold):
                raise Fail(f"{file} 题 {qid} 的 gold 要是规则编号或编号的列表")
            out.append({"id": qid, "q": q, "gold": gold})
        sets[name] = out
    return sets


def rank_of(top, gold):
    """gold 里排得最前的那个编号的名次（从 1 起）；前 8 名里都没有 → None。"""
    ranks = [i for i, rid in enumerate(top, 1) if rid in gold]
    return min(ranks) if ranks else None


def score(items):
    ranks = [i["rank"] for i in items]
    return {"n": len(ranks), "hit1": sum(1 for r in ranks if r == 1), "hit5": sum(1 for r in ranks if r is not None and r <= 5)}


def _within(ranks, within):
    """记了的每个编号都在前 within 名（至少记了一个）。"""
    return bool(ranks) and all(r is not None and r <= within for r in ranks.values())


def known_entry(top, expect, within):
    """一道已知问题的结果：组里每个编号各自的名次（前 8 名里没有 → None），每个都在前 within 名才算过。"""
    rank = {e: rank_of(top, [e]) for e in expect}
    return {"expect": list(expect), "rank": rank, "ok": _within(rank, within)}


# ─────────────── 检索 ───────────────

class Pacer:
    """每分钟至多 per_minute 次：相邻两次 kb_search 至少隔 60 / per_minute 秒。sleep、clock 可注入（测试不真等）。"""

    def __init__(self, per_minute, sleep, clock):
        self.gap, self.sleep, self.clock, self.next_at = 60.0 / per_minute, sleep, clock, None

    def wait(self):
        now = self.clock()
        if self.next_at is not None and now < self.next_at:
            self.sleep(self.next_at - now)
            now = self.clock()
        self.next_at = now + self.gap


def ask(cur, question, pacer, sleep, what):
    """调一次 kb_search，返回前 8 名的 rule_id。撞上每分钟上限：等一分钟再问，至多 RATE_TRIES 次。what 是题号（报错用）。"""
    for attempt in range(1, RATE_TRIES + 1):
        pacer.wait()
        try:
            cur.execute(SEARCH_SQL, (question,))
            return [row[0] for row in cur.fetchall()]
        except Exception as e:  # psycopg 的错误（库里 RAISE 的）；只取第一行，PG 的报错里没有题目文字
            first = (str(e).strip().splitlines() or [type(e).__name__])[0][:300]
            if RATE_MARK not in first:
                raise Fail(f"{what}：kb_search 出错：{first}") from None
            if attempt == RATE_TRIES:
                raise Fail(f"rate_limited：{what} 连续 {RATE_TRIES} 次撞上每分钟上限（{first}）。kb_search 与审核 Agent 共用这个上限，"
                           f"过一会儿再跑；没写结果文件") from None
            print(f"[regress] {what} 撞上每分钟上限，等 {RATE_WAIT} 秒再试（{attempt}/{RATE_TRIES}）", file=sys.stderr)
            sleep(RATE_WAIT)
    raise AssertionError("unreachable")


def embed_model(cur, table):
    """库里登记的向量模型（同 host/pgvector-status.sh）：kb_meta；没登记但表里有向量 = titan-inferred；都没有 = none。"""
    cur.execute("SELECT to_regclass('public.kb_meta') IS NOT NULL")
    if cur.fetchone()[0]:
        cur.execute("SELECT value FROM kb_meta WHERE key = 'embed_model'")
        row = cur.fetchone()
        if row and row[0]:
            return row[0]
    for t in (table, f"{table}_archive"):
        cur.execute("SELECT to_regclass(%s) IS NOT NULL", (f"public.{t}",))
        if cur.fetchone()[0]:
            cur.execute(f"SELECT EXISTS (SELECT 1 FROM {t} WHERE embedding IS NOT NULL)")
            if cur.fetchone()[0]:
                return "titan-inferred"
    return "none"


def run(conn, sets, *, label, table, sleep=time.sleep, clock=time.monotonic):
    """两套题 + KNOWN 各问一遍 → 结果（只有题号、规则编号和计数；known 的 q 是本文件的常量）。"""
    pacer = Pacer(PER_MINUTE, sleep, clock)
    items, known = [], []
    with conn.cursor() as cur:
        try:
            model = embed_model(cur, table)
        except Exception as e:  # 权限、表被换成视图……：只取第一行
            raise Fail(f"读不到库里登记的向量模型：{(str(e).strip().splitlines() or [type(e).__name__])[0][:300]}") from None
        total = sum(len(v) for v in sets.values())
        for name, questions in sets.items():
            for item in questions:
                top = ask(cur, item["q"], pacer, sleep, f"{name} {item['id']}")
                items.append({"id": item["id"], "set": name, "top8": top, "rank": rank_of(top, item["gold"])})
                if len(items) % 10 == 0:
                    print(f"[regress] {len(items)}/{total}", file=sys.stderr)
        for n, (q, expect, within) in enumerate(KNOWN, 1):
            known.append(known_entry(ask(cur, q, pacer, sleep, f"known#{n}"), expect, within))
    return {"label": label, "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "embed_model": model,
            "sets": {name: score([i for i in items if i["set"] == name]) for name in sets}, "known": known, "items": items}


# ─────────────── 对比 ───────────────

UNRECORDED = "未记"
UNRECORDED_NOTE = f"  {UNRECORDED}：结果文件里没有这个编号的名次（10-30 以前的旧格式每题只记一个编号）；— ：不在前 8 名"


def _rank(r):
    return "—" if r is None else str(r)


def _is_rank(r):
    return r is None or (isinstance(r, int) and not isinstance(r, bool) and r >= 1)


def known_ranks(entry):
    """结果文件里的一项 known → {编号: 名次|None}；形态不对 → None。新格式 {expect: [编号…], rank: {编号: 名次|None}}；
    旧格式 {expect: 编号, rank: 名次|None}（10-30 改口径以前写的）当成只有一个编号的组。"""
    if not isinstance(entry, dict) or "rank" not in entry:
        return None
    expect, rank = entry.get("expect"), entry["rank"]
    if isinstance(expect, str):
        expect, rank = [expect], ({expect: rank} if _is_rank(rank) else None)
    if not (isinstance(expect, list) and expect and all(isinstance(e, str) and e for e in expect)
            and isinstance(rank, dict) and set(rank) == set(expect) and all(_is_rank(r) for r in rank.values())):
        return None
    return dict(rank)


def _match(known, group):
    """known 里与这一组有共同编号的第一项 → (这一组里它记了的 {编号: 名次}, 那一项)；没有 → ({}, None)。"""
    for k in known:
        ranks = known_ranks(k)
        if set(ranks) & set(group):
            return {e: ranks[e] for e in group if e in ranks}, k
    return {}, None


def compare_known(a_known, b_known):
    """(有没有不过, 输出行)：KNOWN 逐题，组里逐个编号写 a → b 的名次；按现在的口径判 b（见文件头）。"""
    if not b_known:
        return True, ["✗ known：新结果里没有"]
    lines, bad, unrecorded = [], False, False
    for n, (_, group, within) in enumerate(KNOWN, 1):
        old, _ = _match(a_known, group)
        new, entry = _match(b_known, group)
        need = f"要在前 {within} 名" if len(group) == 1 else f"每个都要在前 {within} 名"
        if entry is None:
            lines.append(f"✗ known#{n} {'、'.join(group)}：新结果里没有这一题（{need}）"); bad = True
            continue
        ok = _within(new, within)
        cells = "，".join(f"{e}：{_rank(old[e]) if e in old else UNRECORDED} → {_rank(new[e]) if e in new else UNRECORDED}" for e in group)
        notes = []
        if len(new) < len(group):
            notes.append(f"新结果只记了 {'、'.join(new)}，按记了的编号判")
        if isinstance(entry.get("ok"), bool) and entry["ok"] != ok:
            notes.append(f"文件里记的是{'过' if entry['ok'] else '不过'}，照现在的口径重判")
        lines.append(f"{'✓' if ok else '✗'} known#{n} {cells}（{need}）" + "".join(f"；{x}" for x in notes))
        bad = bad or not ok
        unrecorded = unrecorded or len(old) < len(group) or len(new) < len(group)
    groups = [set(g) for _, g, _ in KNOWN]
    extra = sum(1 for k in b_known if not any(set(known_ranks(k)) & g for g in groups))
    if extra:
        lines.append(f"  新结果里另有 {extra} 项 known 对不上现在的已知问题，没比")
    if unrecorded:
        lines.append(UNRECORDED_NOTE)
    return bad, lines


def compare(a, b):
    """(退出码, 输出行)。b 的哪一套题 hit5 比 a 低、题数不同，或 b 的 known 有不过的 → 1。行里只有题号、编号和计数。"""
    lines, bad = [f"{a.get('label')}（{a.get('embed_model')}）→ {b.get('label')}（{b.get('embed_model')}）"], False
    for name in [n for n, _ in SETS] + sorted((set(a["sets"]) | set(b["sets"])) - {n for n, _ in SETS}):
        sa, sb = a["sets"].get(name), b["sets"].get(name)
        if sa is None and sb is None:
            continue
        if sa is None or sb is None:
            lines.append(f"✗ {name}：只有一边有这套题"); bad = True
            continue
        lines.append(f"{name}：n {sa['n']} → {sb['n']}，hit1 {sa['hit1']} → {sb['hit1']}，hit5 {sa['hit5']} → {sb['hit5']}")
        if sa["n"] != sb["n"]:
            lines.append(f"✗ {name}：题数不同，不是同一套题"); bad = True
        elif sb["hit5"] < sa["hit5"]:
            lines.append(f"✗ {name}：hit5 变低 {sa['hit5'] - sb['hit5']}"); bad = True
    before = {(i["set"], i["id"]): i["rank"] for i in a["items"]}
    worse = better = 0
    for i in b["items"]:
        key = (i["set"], i["id"])
        if key not in before:
            lines.append(f"  {i['set']} {i['id']}：新题，名次 {_rank(i['rank'])}")
            continue
        old, new = before[key], i["rank"]
        if old == new:
            continue
        down = new is None or (old is not None and new > old)
        worse, better = worse + down, better + (not down)
        lines.append(f"  {'↓' if down else '↑'} {i['set']} {i['id']}：{_rank(old)} → {_rank(new)}")
    lines.append(f"逐题：变好 {better}、变差 {worse}")
    known_bad, known_lines = compare_known(a.get("known", []), b.get("known", []))
    return (1 if bad or known_bad else 0), lines + known_lines


def load_result(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise Fail(f"找不到结果文件 {path}") from None
    except (OSError, UnicodeDecodeError, ValueError) as e:
        raise Fail(f"结果文件 {path} 读不出来（{type(e).__name__}）") from None
    if not isinstance(data, dict) or not all(isinstance(data.get(k), t) for k, t in (("sets", dict), ("items", list), ("known", list))):
        raise Fail(f"{path} 不是 kb_regression 的结果文件")
    for n, k in enumerate(data["known"], 1):
        if known_ranks(k) is None:
            raise Fail(f"{path} 不是 kb_regression 的结果文件：known 第 {n} 项要是 {{expect: [编号…], rank: {{编号: 名次}}}}"
                       "（旧格式 {expect: 编号, rank: 名次}）")
    return data


# ─────────────── 路径 ───────────────

def repo_root():
    """本文件所在的仓库根目录（往上找 .git：目录或 worktree 的文件）；找不到就当 kb/ 的上一级。"""
    here = Path(__file__).resolve()
    for p in here.parents:
        if (p / ".git").exists():
            return p
    return here.parents[2]


def outside_repo(path, what):
    p, root = Path(path).expanduser().resolve(), repo_root()
    if p == root or root in p.parents:
        raise Fail(f"{what} 在仓库里（{p}）：题库和结果由真实制度派生，只能放在仓库外")
    return p


def check(a):
    """--check 与实跑共用：标签、题库、结果目录。返回 (题库, 结果文件)。"""
    if not a.questions_dir or not a.label:
        raise Fail("要给 --questions-dir 和 --label")
    if not ID_RE.fullmatch(a.label):
        raise Fail("--label 只能是字母、数字、点、横线、下划线（用作文件名）")
    qdir = outside_repo(a.questions_dir, "--questions-dir")
    out = outside_repo(a.out, "--out")
    target = out / f"{a.label}.json"
    if target.exists():
        raise Fail(f"{target} 已经有了：换一个 --label，或先把它移走（不覆盖，免得冲掉基线）")
    return load_sets(qdir), target


def write_result(target, res):
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)   # 新建的才是 700；已有的目录不改它的权限
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
        f.write("\n")


def connect(a):
    if not TABLE_RE.fullmatch(a.table):
        raise Fail(f"非法表名 {a.table}")
    if not all((a.host, a.port, a.db, a.user, a.password_file)):
        raise Fail("要给 --host --port --db --user --password-file")
    try:
        password = Path(a.password_file).read_text(encoding="utf-8").strip()
    except OSError as e:
        raise Fail(f"读不到密码文件（{type(e).__name__}）") from None
    try:
        conn = kb_store.connect({"host": a.host, "port": a.port, "database": a.db, "username": a.user, "password": password},
                                application_name="kb-regression", timeout=5)
    except kb_store.KbError as e:
        raise Fail(e.message) from None
    except Exception as e:  # 连不上：不带主机、端口（报错里可能有）
        raise Fail(f"连不上数据库（{type(e).__name__}）：先确认端口转发和应用密码") from None
    conn.autocommit = True   # 每次 kb_search 一个事务：检索日志随之记下，库里的每分钟上限照常数到这些调用
    return conn


def main(argv=None, *, connect=connect, sleep=time.sleep, clock=time.monotonic):
    ap = argparse.ArgumentParser(description="kb_search 检索回归（换向量模型前后对比）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int)
    ap.add_argument("--db")
    ap.add_argument("--user")
    ap.add_argument("--password-file")
    ap.add_argument("--table", default="approval_rules")
    ap.add_argument("--questions-dir")
    ap.add_argument("--label")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--check", action="store_true", help="只校验题库和结果目录，不连库")
    ap.add_argument("--compare", nargs=2, metavar=("A", "B"))
    a = ap.parse_args(argv)
    try:
        if a.compare:
            code, lines = compare(load_result(a.compare[0]), load_result(a.compare[1]))
            print("\n".join(lines))
            print("对比：" + ("有变差（退出码 1）" if code else "持平或变好"))
            return code
        sets, target = check(a)
        counts = "、".join(f"{name} {len(v)} 题" for name, v in sets.items())
        if a.check:
            print(f"题库 {counts}；结果写到 {target}")
            return 0
        conn = connect(a)
        try:
            res = run(conn, sets, label=a.label, table=a.table, sleep=sleep, clock=clock)
        finally:
            conn.close()
        write_result(target, res)
        print(f"{a.label}（{res['embed_model']}）：" + "；".join(f"{n} n={s['n']} hit1={s['hit1']} hit5={s['hit5']}" for n, s in res["sets"].items()))
        print("known：" + "；".join("、".join(f"{e} 第 {_rank(r)} 名" for e, r in k["rank"].items()) + ("" if k["ok"] else "（不过）")
                                     for k in res["known"]))
        print(f"结果：{target}")
        return 0
    except Fail as e:
        print(f"kb_regression：{e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
