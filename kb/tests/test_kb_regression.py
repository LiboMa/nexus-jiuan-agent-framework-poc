"""kb_regression（换向量模型前后的检索回归）不连库的部分：计分、已知问题（一组编号每个都要在前 N 名）、--compare 的退出码
（含 10-30 以前的旧格式结果文件）、限速（每分钟至多 50 次 kb_search，Review Focus 5）、--out 不许在仓库里、结果文件和对比
输出里只有题号、规则编号和计数，不含题目文字（已知问题的问句也不写进结果文件）。

    $KBPY -m unittest kb/tests/test_kb_regression.py -v

题库是测试现生成的虚构题（临时目录里）；真实题库在仓库外，测试不读它。假游标按题目回预设的 rule_id；时钟和 sleep 是假的，
限速的用例不真等。
"""
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE.parent / "lib"))
import kb_regression  # noqa: E402

SEARCH_SQL = "SELECT rule_id FROM kb_search(%s, 8, NULL, 'kb-regression')"
RATE = "kb_search：每分钟最多 60 次，请稍后再查"
MARK = "虚构题干"      # 每道假题都带这四个字：结果文件、输出里出现就是漏了题目文字


class FakeClock:
    def __init__(self):
        self.now = 1000.0
        self.slept = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        assert seconds >= 0, seconds
        self.slept.append(seconds)
        self.now += seconds


class FakeError(Exception):
    pass


class FakeCursor:
    def __init__(self, conn):
        self.conn, self._rows = conn, []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        c = self.conn
        c.executed.append((sql, params))
        if "kb_search(" in sql:
            c.calls.append(c.clock())
            q = params[0]
            if c.rate_limited.get(q, 0) > 0:
                c.rate_limited[q] -= 1
                raise FakeError(RATE)
            self._rows = [(r,) for r in c.answers.get(q, [])]
        elif "to_regclass('public.kb_meta')" in sql:
            self._rows = [(c.model is not None,)]
        elif "FROM kb_meta" in sql:
            self._rows = [(c.model,)] if c.model else []
        elif "to_regclass(" in sql:
            self._rows = [(True,)]
        elif "embedding IS NOT NULL" in sql:
            self._rows = [(True,)]
        else:
            raise AssertionError(f"没预设的 SQL：{sql}")

    def fetchall(self):
        return list(self._rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None


class FakeConn:
    def __init__(self, answers, clock, model="cohere.embed-v4:0"):
        self.answers, self.clock, self.model = answers, clock, model
        self.executed, self.calls, self.rate_limited = [], [], {}
        self.autocommit, self.closed = False, False

    def cursor(self):
        return FakeCursor(self)

    def close(self):
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def question(i, gold, prefix="M"):
    return {"id": f"{prefix}{i:02d}", "q": f"{MARK}{prefix}{i:02d}：差旅报销 {i} 万谁批", "gold": gold, "cat": "虚构类", "seg": "甲板块", "amt": i}


def write_sets(d, main, robust):
    d = Path(d)
    d.mkdir(parents=True, exist_ok=True)
    (d / "questions.json").write_text(json.dumps(main, ensure_ascii=False), encoding="utf-8")
    robust = [dict(x, orig=x["id"].replace("R", "M")) for x in robust]
    (d / "questions_robust.json").write_text(json.dumps(robust, ensure_ascii=False), encoding="utf-8")
    return d


KNOWN_QS = [q for q, _, _ in kb_regression.KNOWN]   # 已知问题的问句：结果文件和输出里都不该有


def known_answers(ok=True):
    """KNOWN 两题：第一题 C03-1.2 要在前 3；第二题 C05-3.3 与 C05-3.4 都要在前 2（不过时 C05-3.4 掉到第 3）。"""
    return {"30万合同用印": ["C03-1.1", "C03-1.2", "C03-1.3"],
            "房租 年度框架合同 九安": ["C05-3.3", "C05-3.4", "C05-3.1"] if ok else ["C05-3.3", "C05-3.1", "C05-3.4"]}


def result(main=(10, 5, 8), robust=(4, 2, 3), known_ok=(True, True), ranks=None, known=None):
    """手搭一个结果文件的内容（--compare 用）。known_ok：每题过不过（过 = 组里依次第 1、2…名，不过 = 都不在前 8）。"""
    sets = {"main": dict(zip(("n", "hit1", "hit5"), main)), "robust": dict(zip(("n", "hit1", "hit5"), robust))}
    if known is None:
        known = [{"expect": list(e), "rank": {x: (i if ok else None) for i, x in enumerate(e, 1)}, "ok": ok}
                 for (_, e, _), ok in zip(kb_regression.KNOWN, known_ok)]
    items = [{"id": f"M{i:02d}", "set": "main", "top8": ["X"], "rank": r} for i, r in enumerate(ranks or [1, 2], 1)]
    return {"label": "x", "at": "2026-10-30T00:00:00Z", "embed_model": "cohere.embed-v4:0", "sets": sets, "known": known, "items": items}


def old_known(r1, r2):
    """10-30 改口径以前的结果文件里的 known：expect 是一个编号、rank 是它的名次，带问句 q（当时的写法）；ok 照当时的口径
    （C03-1.2 前 3、C05-3.4 第 1）。"""
    return [{"q": KNOWN_QS[0], "expect": "C03-1.2", "rank": r1, "ok": r1 is not None and r1 <= 3},
            {"q": KNOWN_QS[1], "expect": "C05-3.4", "rank": r2, "ok": r2 == 1}]


def new_known(r1, r33, r34):
    return [{"expect": ["C03-1.2"], "rank": {"C03-1.2": r1}, "ok": r1 is not None and r1 <= 3},
            {"expect": ["C05-3.3", "C05-3.4"], "rank": {"C05-3.3": r33, "C05-3.4": r34},
             "ok": all(r is not None and r <= 2 for r in (r33, r34))}]


class Scoring(unittest.TestCase):
    def test_rank_hit1_hit5(self):
        top = ["A", "B", "C", "D", "E", "F", "G", "H"]
        self.assertEqual(kb_regression.rank_of(top, ["C"]), 3)
        self.assertEqual(kb_regression.rank_of(top, ["Z", "F", "B"]), 2, "gold 里有几个编号时取排得最前的")
        self.assertIsNone(kb_regression.rank_of(top, ["Z"]))
        self.assertIsNone(kb_regression.rank_of([], ["A"]))
        items = [{"rank": r} for r in (1, 3, 5, 6, None, 1)]
        self.assertEqual(kb_regression.score(items), {"n": 6, "hit1": 2, "hit5": 4})
        self.assertEqual(kb_regression.score([]), {"n": 0, "hit1": 0, "hit5": 0})

    def test_run_scores_sets_and_known(self):
        main = [question(1, ["A1"]), question(2, ["B2", "B3"]), question(3, ["C9"])]
        robust = [question(1, ["A1"], "R"), question(2, ["Z"], "R")]
        answers = {main[0]["q"]: ["A1", "X"], main[1]["q"]: ["X", "Y", "B3", "B2"], main[2]["q"]: ["X"] * 5 + ["C9"],
                   robust[0]["q"]: ["X", "A1"], robust[1]["q"]: [], **known_answers(ok=False)}
        clock = FakeClock()
        conn = FakeConn(answers, clock)
        with tempfile.TemporaryDirectory() as d:
            sets = kb_regression.load_sets(write_sets(d, main, robust))
        with redirect_stderr(io.StringIO()):
            res = kb_regression.run(conn, sets, label="cohere", table="approval_rules", sleep=clock.sleep, clock=clock)
        self.assertEqual(res["label"], "cohere")
        self.assertEqual(res["embed_model"], "cohere.embed-v4:0")
        self.assertRegex(res["at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(res["sets"], {"main": {"n": 3, "hit1": 1, "hit5": 2}, "robust": {"n": 2, "hit1": 0, "hit5": 1}})
        self.assertEqual([(i["set"], i["id"], i["rank"]) for i in res["items"]],
                         [("main", "M01", 1), ("main", "M02", 3), ("main", "M03", 6), ("robust", "R01", 2), ("robust", "R02", None)])
        self.assertEqual(res["items"][0]["top8"], ["A1", "X"])
        self.assertEqual({k for i in res["items"] for k in i}, {"id", "set", "top8", "rank"})
        self.assertEqual(res["known"], [{"expect": ["C03-1.2"], "rank": {"C03-1.2": 2}, "ok": True},
                                        {"expect": ["C05-3.3", "C05-3.4"], "rank": {"C05-3.3": 1, "C05-3.4": 3}, "ok": False}],
                         "C05-3.4 第 3：组里只有一个在前 2，不过；known 里不写问句")
        searches = [(s, p) for s, p in conn.executed if "kb_search(" in s]
        self.assertEqual(len(searches), 7)
        self.assertTrue(all(s == SEARCH_SQL and p == (p[0],) for s, p in searches), searches)
        self.assertTrue(conn.autocommit is False, "run 不改连接的设置（connect 时设 autocommit）")

    def test_embed_model_inferred_without_kb_meta(self):
        clock = FakeClock()
        conn = FakeConn({}, clock, model=None)
        with conn.cursor() as cur:
            self.assertEqual(kb_regression.embed_model(cur, "approval_rules"), "titan-inferred")


class Known(unittest.TestCase):
    """已知问题（Spec 第 1 节第 3 条，10-30 修订）：「30 万合同用印」前 3 名有 C03-1.2；「房租 年度框架合同 九安」前 2 名是
    C05-3.3 与 C05-3.4（两条都要在）。"""

    def test_known_follows_spec(self):
        self.assertEqual(kb_regression.KNOWN, [("30万合同用印", ("C03-1.2",), 3), ("房租 年度框架合同 九安", ("C05-3.3", "C05-3.4"), 2)])
        groups = [set(g) for _, g, _ in kb_regression.KNOWN]
        self.assertFalse(groups[0] & groups[1], "各组的编号不重：对比时按编号认是哪一题")

    def test_group_every_id_within(self):
        entry = kb_regression.known_entry
        group = ("C05-3.3", "C05-3.4")
        self.assertEqual(entry(["C05-3.3", "C05-3.4", "C05-3.1"], group, 2),
                         {"expect": ["C05-3.3", "C05-3.4"], "rank": {"C05-3.3": 1, "C05-3.4": 2}, "ok": True}, "两个都在前 2")
        self.assertTrue(entry(["C05-3.4", "C05-3.3"], group, 2)["ok"], "前 2 名里谁先谁后都行")
        self.assertEqual(entry(["C05-3.3", "C05-3.1", "C05-3.4"], group, 2),
                         {"expect": ["C05-3.3", "C05-3.4"], "rank": {"C05-3.3": 1, "C05-3.4": 3}, "ok": False}, "只有一个在前 2")
        self.assertEqual(entry(["C05-3.4", "X"], group, 2)["rank"], {"C05-3.3": None, "C05-3.4": 1})
        self.assertFalse(entry(["C05-3.4", "X"], group, 2)["ok"], "组里另一个不在前 8")
        self.assertEqual(entry(["C03-1.1", "C03-1.3", "C03-1.2"], ("C03-1.2",), 3),
                         {"expect": ["C03-1.2"], "rank": {"C03-1.2": 3}, "ok": True})
        self.assertFalse(entry(["C03-1.1", "C03-1.3", "X", "C03-1.2"], ("C03-1.2",), 3)["ok"])

    def test_run_known_ok(self):
        clock = FakeClock()
        conn = FakeConn(known_answers(ok=True), clock)
        with redirect_stderr(io.StringIO()):
            res = kb_regression.run(conn, {"main": [], "robust": []}, label="t", table="approval_rules", sleep=clock.sleep, clock=clock)
        self.assertEqual(res["known"], [{"expect": ["C03-1.2"], "rank": {"C03-1.2": 2}, "ok": True},
                                        {"expect": ["C05-3.3", "C05-3.4"], "rank": {"C05-3.3": 1, "C05-3.4": 2}, "ok": True}])


class Compare(unittest.TestCase):
    def check(self, a, b):
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(out):
            code, lines = kb_regression.compare(a, b)
        return code, "\n".join(lines)

    def test_exit_codes(self):
        base = result()
        self.assertEqual(self.check(base, result())[0], 0, "持平")
        self.assertEqual(self.check(base, result(main=(10, 7, 9)))[0], 0, "变好")
        self.assertEqual(self.check(base, result(main=(10, 9, 7)))[0], 1, "main 的 hit5 变低（hit1 变高也不行）")
        self.assertEqual(self.check(base, result(robust=(4, 2, 2)))[0], 1, "robust 的 hit5 变低")
        self.assertEqual(self.check(base, result(known_ok=(True, False)))[0], 1, "known 不过")
        self.assertEqual(self.check(result(known_ok=(True, False)), result())[0], 0, "看的是新结果的 known")
        self.assertEqual(self.check(base, result(main=(11, 5, 8)))[0], 1, "题数不同：不是同一套题，不能比")

    def test_prints_changes_by_id(self):
        code, text = self.check(result(ranks=[1, 2]), result(ranks=[None, 1], main=(10, 5, 7)))
        self.assertEqual(code, 1)
        self.assertIn("M01", text)
        self.assertIn("M02", text)
        self.assertIn("8", text)
        self.assertIn("7", text)

    def test_known_lines_per_id(self):
        code, text = self.check(result(known=new_known(3, 1, 2)), result(known=new_known(2, 2, 1)))
        self.assertEqual(code, 0)
        self.assertIn("✓ known#1 C03-1.2：3 → 2", text)
        self.assertIn("✓ known#2 C05-3.3：1 → 2，C05-3.4：2 → 1", text)
        self.assertNotIn(kb_regression.UNRECORDED, text, "两边都是新格式：每个编号都有名次")
        code, text = self.check(result(known=new_known(2, 1, 2)), result(known=new_known(2, 1, 3)))
        self.assertEqual(code, 1, "C05-3.4 掉到第 3：组里只有一个在前 2")
        self.assertIn("✗ known#2 C05-3.3：1 → 1，C05-3.4：2 → 3", text)
        code, text = self.check(result(), result(known=new_known(2, None, 1)))
        self.assertEqual(code, 1)
        self.assertIn("C05-3.3：1 → —", text, "不在前 8 名记作 —")

    def test_old_format_results(self):
        """10-30 以前写的结果文件（expect 是一个编号、rank 是整数）：当成只有一个编号的组；组里另一个编号没有名次，记「未记」，
        按记了的编号、照现在的口径判，不编名次。"""
        titan, cohere = result(known=old_known(3, 1)), result(known=old_known(2, 2))
        code, text = self.check(titan, cohere)
        self.assertEqual(code, 0, "两份都是旧格式（同今天的两份真实结果）：C05-3.4 第 2，照现在的口径（前 2 名）过\n" + text)
        line = next(x for x in text.splitlines() if "known#2" in x)
        self.assertTrue(line.startswith("✓ known#2 C05-3.3：未记 → 未记，C05-3.4：1 → 2"), line)
        self.assertIn("只记了 C05-3.4", line, "说明只按记了的编号判")
        self.assertIn("重判", line, "文件里记的 ok（旧口径：第 1 名）与现在的判法不同")
        self.assertIn("✓ known#1 C03-1.2：3 → 2", text)
        self.assertIn(kb_regression.UNRECORDED_NOTE, text, "说明「未记」是什么")

        code, text = self.check(titan, result(known=old_known(2, 3)))
        self.assertEqual(code, 1, "旧格式里记了的编号不在前 2：不过")
        self.assertIn("✗ known#2 C05-3.3：未记 → 未记，C05-3.4：1 → 3", text)

        code, text = self.check(titan, result(known=new_known(2, 1, 2)))
        self.assertEqual(code, 0, "旧基线 → 新结果")
        line = next(x for x in text.splitlines() if "known#2" in x)
        self.assertTrue(line.startswith("✓ known#2 C05-3.3：未记 → 1，C05-3.4：1 → 2"), line)
        self.assertNotIn("只记了", line, "新结果是完整的：不用说明")
        code, text = self.check(result(known=new_known(2, 1, 2)), cohere)
        self.assertEqual(code, 0, "新基线 → 旧结果也能比")
        self.assertIn("C05-3.3：1 → 未记，C05-3.4：2 → 2", text)

        for a, b in ((titan, cohere), (titan, result())):
            _, text = self.check(a, b)
            for q in KNOWN_QS:
                self.assertNotIn(q, text, "旧文件里的问句不打印")

    def test_known_missing_or_malformed(self):
        code, text = self.check(result(), result(known=new_known(2, 1, 2)[:1]))
        self.assertEqual(code, 1, "新结果少了一题")
        self.assertIn("✗ known#2", text)
        self.assertEqual(self.check(result(), result(known=[]))[0], 1)
        with tempfile.TemporaryDirectory() as d:
            good = Path(d, "good.json")
            good.write_text(json.dumps(result()), encoding="utf-8")
            for n, known in enumerate(([{"expect": ["C03-1.2"], "rank": 2, "ok": True}],
                                       [{"expect": 5, "rank": 1, "ok": True}],
                                       [{"expect": ["C03-1.2"], "rank": {"C03-1.3": 1}, "ok": True}],
                                       [{"expect": "C03-1.2", "rank": "1", "ok": True}],
                                       [{"expect": "C03-1.2", "ok": True}],
                                       ["C03-1.2"])):
                with self.subTest(n=n):
                    bad = Path(d, f"bad{n}.json")
                    bad.write_text(json.dumps(result(known=known)), encoding="utf-8")
                    err = io.StringIO()
                    with redirect_stdout(io.StringIO()), redirect_stderr(err):
                        self.assertEqual(kb_regression.main(["--compare", str(good), str(bad)]), 2)
                    self.assertIn("known", err.getvalue())

    def test_cli_compare_old_and_new_files(self):
        with tempfile.TemporaryDirectory() as d:
            a, b, c = Path(d, "titan.json"), Path(d, "cohere.json"), Path(d, "now.json")
            a.write_text(json.dumps(result(known=old_known(3, 1)), ensure_ascii=False), encoding="utf-8")
            b.write_text(json.dumps(result(known=old_known(2, 2)), ensure_ascii=False), encoding="utf-8")
            c.write_text(json.dumps(result(known=new_known(2, 3, 1)), ensure_ascii=False), encoding="utf-8")
            for args, want in (((a, b), 0), ((a, c), 1), ((c, b), 0)):
                with self.subTest(args=[p.name for p in args]):
                    out = io.StringIO()
                    with redirect_stdout(out), redirect_stderr(out):
                        self.assertEqual(kb_regression.main(["--compare", *map(str, args)]), want, out.getvalue())
                    printed = out.getvalue()
                    self.assertIn("known#2", printed)
                    self.assertIn("对比：" + ("有变差（退出码 1）" if want else "持平或变好"), printed)
                    for q in KNOWN_QS:
                        self.assertNotIn(q, printed)

    def test_cli_compare_exit_code(self):
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d, "a.json"), Path(d, "b.json")
            a.write_text(json.dumps(result()), encoding="utf-8")
            b.write_text(json.dumps(result(main=(10, 5, 6))), encoding="utf-8")
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(kb_regression.main(["--compare", str(a), str(a)]), 0)
                self.assertEqual(kb_regression.main(["--compare", str(a), str(b)]), 1)
                self.assertEqual(kb_regression.main(["--compare", str(a), str(Path(d, "none.json"))]), 2)


class Pacing(unittest.TestCase):
    def test_sixty_questions_take_at_least_sixty_seconds(self):
        main = [question(i, ["A"]) for i in range(1, 41)]
        robust = [question(i, ["A"], "R") for i in range(1, 21)]
        clock = FakeClock()
        conn = FakeConn({**{x["q"]: ["A"] for x in main + robust}, **known_answers()}, clock)
        with tempfile.TemporaryDirectory() as d:
            sets = kb_regression.load_sets(write_sets(d, main, robust))
        with redirect_stderr(io.StringIO()):
            kb_regression.run(conn, sets, label="t", table="approval_rules", sleep=clock.sleep, clock=clock)
        calls = conn.calls
        self.assertEqual(len(calls), 62)
        self.assertGreaterEqual(calls[59] - calls[0], 60, "60 题至少用掉 60 秒")
        for i in range(len(calls) - 50):   # 任何 60 秒里至多 50 次：第 i 次和第 i+50 次至少隔 60 秒
            self.assertGreaterEqual(calls[i + 50] - calls[i], 60 - 1e-6, i)
        self.assertTrue(clock.slept, "用的是注入的 sleep")

    def test_rate_limited_waits_a_minute_and_retries(self):
        """撞上库里的每分钟上限（与审核 Agent 共用）：等一分钟再问同一题，不当成「没查到」。"""
        main = [question(1, ["A"]), question(2, ["B"])]
        clock = FakeClock()
        conn = FakeConn({main[0]["q"]: ["A"], main[1]["q"]: ["B"], **known_answers()}, clock)
        conn.rate_limited[main[1]["q"]] = 1
        with tempfile.TemporaryDirectory() as d:
            sets = kb_regression.load_sets(write_sets(d, main, []))
        with redirect_stderr(io.StringIO()):
            res = kb_regression.run(conn, sets, label="t", table="approval_rules", sleep=clock.sleep, clock=clock)
        self.assertEqual([i["rank"] for i in res["items"]], [1, 1])
        self.assertGreaterEqual(max(clock.slept), 60)

    def test_rate_limited_for_good_fails_without_result(self):
        main = [question(1, ["A"])]
        clock = FakeClock()
        conn = FakeConn({**known_answers()}, clock)
        conn.rate_limited[main[0]["q"]] = 99
        with tempfile.TemporaryDirectory() as d:
            q = write_sets(Path(d, "q"), main, [])
            out = Path(d, "out")
            err = io.StringIO()
            with redirect_stdout(io.StringIO()), redirect_stderr(err):
                code = kb_regression.main(["--host", "h", "--port", "1", "--db", "d", "--user", "u", "--password-file", "/dev/null",
                                           "--questions-dir", str(q), "--label", "t", "--out", str(out)],
                                          connect=lambda a: conn, sleep=clock.sleep, clock=clock)
            self.assertEqual(code, 2)
            self.assertIn("rate_limited", err.getvalue())
            self.assertFalse(Path(out, "t.json").exists(), "没跑完不写结果")
            self.assertNotIn(MARK, err.getvalue())


class Paths(unittest.TestCase):
    def run_main(self, qdir, out, *extra, connect=None):
        def boom(a):
            raise AssertionError("不该连库")
        err = io.StringIO()
        with redirect_stdout(io.StringIO()) as so, redirect_stderr(err):
            code = kb_regression.main(["--host", "h", "--port", "1", "--db", "d", "--user", "u", "--password-file", "/dev/null",
                                       "--questions-dir", str(qdir), "--label", "base", "--out", str(out), *extra],
                                      connect=connect or boom, sleep=lambda s: None, clock=lambda: 0.0)
        return code, so.getvalue(), err.getvalue()

    def test_out_inside_repo_refused(self):
        with tempfile.TemporaryDirectory() as d:
            q = write_sets(Path(d, "q"), [question(1, ["A"])], [])
            for out in (REPO / "kb" / ".build" / "kb-regression-should-not-exist", HERE / "nope", REPO):
                existed = out.exists()
                code, _, err = self.run_main(q, out)
                self.assertEqual(code, 2, out)
                self.assertIn("仓库", err)
                self.assertEqual(out.exists(), existed, f"{out} 不该被建出来")
            self.assertFalse((REPO / "base.json").exists())

    def test_questions_inside_repo_refused(self):
        with tempfile.TemporaryDirectory() as d:
            code, _, err = self.run_main(REPO / "kb" / "tests", Path(d, "out"))
            self.assertEqual(code, 2)
            self.assertIn("仓库", err)

    def test_check_only_and_existing_result(self):
        with tempfile.TemporaryDirectory() as d:
            q = write_sets(Path(d, "q"), [question(1, ["A"]), question(2, ["A"])], [question(1, ["A"], "R")])
            out = Path(d, "out")
            code, so, _ = self.run_main(q, out, "--check")
            self.assertEqual(code, 0)
            self.assertIn("2", so)
            self.assertNotIn(MARK, so)
            out.mkdir()
            Path(out, "base.json").write_text("{}", encoding="utf-8")
            code, _, err = self.run_main(q, out)
            self.assertEqual(code, 2, "同名结果已存在：不覆盖（基线别被冲掉）")
            self.assertIn("base.json", err)

    def test_bad_label_and_bad_questions(self):
        with tempfile.TemporaryDirectory() as d:
            q = write_sets(Path(d, "q"), [question(1, ["A"])], [])
            err = io.StringIO()
            with redirect_stdout(io.StringIO()), redirect_stderr(err):
                code = kb_regression.main(["--questions-dir", str(q), "--label", "../x", "--out", str(Path(d, "o")), "--check"])
            self.assertEqual(code, 2)
            bad = write_sets(Path(d, "bad"), [dict(question(1, ["A"]), id=f"{MARK}一题")], [])
            err = io.StringIO()
            with redirect_stdout(io.StringIO()), redirect_stderr(err):
                code = kb_regression.main(["--questions-dir", str(bad), "--label", "x", "--out", str(Path(d, "o")), "--check"])
            self.assertEqual(code, 2, "题号只能是字母、数字、点、横线、下划线：结果文件里只放题号")
            self.assertNotIn(MARK, err.getvalue())


class NoQuestionText(unittest.TestCase):
    def test_result_file_and_compare_output_have_only_ids_and_counts(self):
        main = [question(i, [f"C0{i}-1.{i}"]) for i in range(1, 6)]
        robust = [question(i, [f"C0{i}-1.{i}"], "R") for i in range(1, 4)]
        texts = [x["q"] for x in main + robust]
        clock = FakeClock()
        answers = {**{x["q"]: [f"C0{n}-1.{n}" for n in range(1, 9)] for x in main + robust}, **known_answers()}
        with tempfile.TemporaryDirectory() as d:
            q = write_sets(Path(d, "q"), main, robust)
            out = Path(d, "out")
            logs = io.StringIO()
            with redirect_stdout(logs), redirect_stderr(logs):
                for label, ans in (("titan", answers), ("cohere", {**answers, main[0]["q"]: ["Z"]})):
                    conn = FakeConn(ans, clock)
                    code = kb_regression.main(["--host", "h", "--port", "1", "--db", "d", "--user", "u", "--password-file", "/dev/null",
                                               "--questions-dir", str(q), "--label", label, "--out", str(out)],
                                              connect=lambda a, conn=conn: conn, sleep=clock.sleep, clock=clock)
                    self.assertEqual(code, 0, logs.getvalue()[-500:])
                    self.assertTrue(conn.closed)
                code = kb_regression.main(["--compare", str(out / "titan.json"), str(out / "cohere.json")])
            self.assertEqual(code, 1, "M01 掉出前 5：main 的 hit5 变低")
            for name in ("titan.json", "cohere.json"):
                path = out / name
                raw = path.read_text(encoding="utf-8")
                self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
                data = json.loads(raw)
                self.assertEqual(set(data), {"label", "at", "embed_model", "sets", "known", "items"})
                for t in texts:
                    self.assertNotIn(t, raw)
                self.assertNotIn(MARK, raw)
                self.assertNotIn("差旅", raw)
                self.assertEqual({k for i in data["items"] for k in i}, {"id", "set", "top8", "rank"})
                self.assertEqual([sorted(k) for k in data["known"]], [["expect", "ok", "rank"]] * 2, "known 里只有编号、名次、过不过")
                for q in KNOWN_QS:
                    self.assertNotIn(q, raw, "已知问题的问句也不写进结果文件")
            self.assertEqual(stat.S_IMODE(os.stat(out).st_mode), 0o700)
            printed = logs.getvalue()
            self.assertIn("M01", printed)
            self.assertIn("C05-3.3 第 1 名、C05-3.4 第 2 名", printed, "跑完的摘要逐个编号写名次")
            self.assertNotIn(MARK, printed)
            self.assertNotIn("差旅", printed)
            for q in KNOWN_QS:
                self.assertNotIn(q, printed)


if __name__ == "__main__":
    unittest.main()
