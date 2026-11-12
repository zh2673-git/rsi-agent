"""内容检索索引：SQLite FTS5 + CJK bigram，给「按内容找历史/资料」用。

为什么是 FTS5 而不是向量库
--------------------------
1. 语料量级差三个数量级：可检索单元（L2 摘要 + outputs + docs + skills 文档）合计几 MB，
   向量库解决的是千万级文档。
2. 中文没有 CJK tokenizer，但**字符二元组（bigram）**足够：索引侧切 bigram，查询侧同样切，
   bm25() 给出的就是真正的相关性排序——这正是 memory.recall（子串扫描 + 最近 2000 行 + 上限 5 条）
   缺的那一块。
3. 零新依赖：sqlite3 是标准库，FTS5 在 3.9+ 默认编译进来（本机实测 3.41.2 可用）。

索引是**派生视图**：`.rsi/index/fts.db` 随时可删掉重建，不做真相源。

用法
----
  python scripts/index.py build [--corpus l2,outputs,docs,skills,board] [--force]
  python scripts/index.py search "<query>" [--k 5] [--corpus ...] [--json]
  python scripts/index.py stat
  python scripts/index.py bench "<query1>" ["<query2>" ...]   # 对比 grep 基线

设计约束
--------
- 增量：按 (path, mtime_ns, size) 跳过未变文件；文件消失则删条目。
- 分块：按标题（markdown `#`）与段落切，chunk ≤ 1200 字符，带起始行号，
  召回结果能直接 `path:line` 打开。
- 幂等：同一份语料重复 build，索引内容逐字节等价（只 mtime 变）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent


def rsi_home() -> Path:
    """代码根（锚 RSI_HOME，缺省取本文件上两级）——与看板/画像同一约定。"""
    return Path(os.environ.get("RSI_HOME") or ROOT)


def workspace_root() -> Path:
    return Path(os.environ.get("WORKSPACE_ROOT") or rsi_home())


def index_path() -> Path:
    d = Path(os.environ.get("RSI_INDEX_DIR") or (rsi_home() / ".rsi" / "index"))
    d.mkdir(parents=True, exist_ok=True)
    return d / "fts.db"


# ---- 语料定义 ---------------------------------------------------------------

def corpora() -> dict[str, list[Path]]:
    home, ws = rsi_home(), workspace_root()
    out = {
        "l2": sorted((home / ".rsi" / "memory" / "L2").glob("*.md")),
        "l3": [p for p in [home / ".rsi" / "memory" / "L3" / "index.json"] if p.is_file()],
        "outputs": sorted((ws / "outputs").glob("*.md")),
        "docs": sorted((home / "docs").rglob("*.md")),
        "skills": sorted((home / "skills").rglob("SKILL.md")),
        "patches": sorted((home / "scripts" / "patches").glob("*.json")),
    }
    return out


CORPUS_HELP = {
    "l2": "记忆 L2 按天摘要（.rsi/memory/L2/*.md）",
    "l3": "记忆 L3 时间线索引（.rsi/memory/L3/index.json）",
    "outputs": "交付文档（outputs/*.md）",
    "docs": "项目文档（docs/**/*.md）",
    "skills": "技能说明（skills/**/SKILL.md）",
    "patches": "补丁说明（scripts/patches/*.json）",
}

MAX_CHUNK = 1200


# ---- CJK bigram 切分 --------------------------------------------------------
#
# FTS5 的 unicode61 tokenizer 把连续 CJK 当成一个 token（整句一个词），检索基本失效。
# 解法：索引侧把每个 CJK 连续串切成 bigram（"内容检索" -> "内容 容检 检索"），
# 查询侧同样切，两边对齐后 bm25 才有意义。ASCII 词保持原样（英文/代码本来就以空格分词）。

_CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")
_ASCII_WORD = re.compile(r"[A-Za-z0-9_./+-]{2,}")


def tokenize(text: str) -> str:
    """把文本转成 FTS5 可用的 token 串（CJK bigram + ASCII 原词）。"""
    parts: list[str] = []
    for run in _CJK.findall(text):
        if len(run) == 1:
            parts.append(run)
        else:
            parts.extend(run[i:i + 2] for i in range(len(run) - 1))
    parts.extend(w.lower() for w in _ASCII_WORD.findall(text))
    return " ".join(parts)


def chunk_markdown(text: str, max_len: int = MAX_CHUNK) -> list[tuple[int, str]]:
    """按标题/空行切块，返回 [(起始行号, 块文本)]。

    为什么不按固定窗口切：检索命中后要能「打开那一节」而不是「打开那一段的中间」，
    标题边界就是人读文档时的边界。
    """
    lines = text.splitlines()
    chunks: list[tuple[int, str]] = []
    buf: list[str] = []
    start = 1

    def flush(at: int) -> None:
        nonlocal buf, start
        body = "\n".join(buf).strip()
        if body:
            # 超长块再按长度硬切（保持行号可回溯：按行数比例估算起点）
            while len(body) > max_len:
                cut = body.rfind("\n", 0, max_len)
                cut = cut if cut > max_len // 2 else max_len
                head, body = body[:cut].strip(), body[cut:].strip()
                if head:
                    chunks.append((start, head))
                start += head.count("\n") + 1
            if body:
                chunks.append((start, body))
                start = at
        buf = []

    for i, line in enumerate(lines, 1):
        is_heading = bool(re.match(r"^#{1,6}\s", line))
        if is_heading and buf:
            flush(i)
            start = i
        buf.append(line)
        if not line.strip() and len("\n".join(buf)) > max_len // 2:
            flush(i + 1)
            start = i + 1
    flush(len(lines) + 1)
    return chunks


# ---- 建索引 -----------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  corpus TEXT NOT NULL,
  mtime_ns INTEGER NOT NULL,
  size INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  built_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
  path UNINDEXED,
  corpus UNINDEXED,
  line UNINDEXED,
  body,
  tokenize='unicode61 remove_diacritics 2'
);
-- 原文旁表：FTS 表里存的是 bigram token 串（给人看不可读），
-- 展示与片段高亮必须读原文。rowid 与 chunks 对齐，一次查询即可 JOIN。
CREATE TABLE IF NOT EXISTS chunk_text (
  id INTEGER PRIMARY KEY,
  raw TEXT NOT NULL
);
"""


def open_db() -> sqlite3.Connection:
    conn = sqlite3.connect(index_path())
    conn.executescript(SCHEMA)
    return conn


def build(corpus_names: list[str], force: bool = False) -> dict:
    conn = open_db()
    all_corpora = corpora()
    stats = {"scanned": 0, "rebuilt": 0, "skipped": 0, "removed": 0, "chunks": 0}
    seen: set[str] = set()

    for name in corpus_names:
        for path in all_corpora.get(name, []):
            try:
                st = path.stat()
            except OSError:
                continue
            stats["scanned"] += 1
            key = str(path.resolve())
            seen.add(key)
            row = conn.execute(
                "SELECT mtime_ns, size FROM files WHERE path=?", (key,)
            ).fetchone()
            if row and not force and row[0] == st.st_mtime_ns and row[1] == st.st_size:
                stats["skipped"] += 1
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            chunks = chunk_markdown(text)
            # 先取旧 rowid 一并清掉旁表，避免孤儿
            old_ids = [r[0] for r in conn.execute("SELECT rowid FROM chunks WHERE path=?", (key,))]
            if old_ids:
                conn.executemany("DELETE FROM chunk_text WHERE id=?", [(i,) for i in old_ids])
            conn.execute("DELETE FROM chunks WHERE path=?", (key,))
            for line, body in chunks:
                cur = conn.execute(
                    "INSERT INTO chunks(path, corpus, line, body) VALUES (?,?,?,?)",
                    (key, name, line, tokenize(body)),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO chunk_text(id, raw) VALUES (?,?)",
                    (cur.lastrowid, body),
                )
            conn.execute(
                "INSERT INTO files(path, corpus, mtime_ns, size, chunks, built_at) "
                "VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET "
                "mtime_ns=excluded.mtime_ns, size=excluded.size, "
                "chunks=excluded.chunks, built_at=excluded.built_at",
                (key, name, st.st_mtime_ns, st.st_size, len(chunks), int(time.time())),
            )
            stats["rebuilt"] += 1
            stats["chunks"] += len(chunks)

    # 清掉已消失的文件（只在本次涉及的语料范围内）
    for name in corpus_names:
        stale = [
            r[0]
            for r in conn.execute("SELECT path FROM files WHERE corpus=?", (name,))
            if r[0] not in seen
        ]
        for p in stale:
            conn.execute("DELETE FROM chunks WHERE path=?", (p,))
            conn.execute("DELETE FROM files WHERE path=?", (p,))
            stats["removed"] += 1

    conn.commit()
    conn.close()
    return stats


# ---- 检索 -------------------------------------------------------------------

def search(query: str, k: int = 5, corpus_names: list[str] | None = None) -> list[dict]:
    conn = open_db()
    toks = tokenize(query)
    if not toks.strip():
        conn.close()
        return []
    # FTS5 语法：token 之间默认 AND，长查询会因某 token 缺失而全灭；
    # 用 OR 保召回，靠 bm25 排序把真正相关的顶上来。
    expr = " OR ".join(f'"{t}"' for t in toks.split())
    sql = (
        "SELECT c.path, c.corpus, c.line, t.raw, bm25(chunks) AS score "
        "FROM chunks c LEFT JOIN chunk_text t ON t.id = c.rowid "
        "WHERE chunks MATCH ? "
    )
    args: list = [expr]
    if corpus_names:
        sql += "AND corpus IN (%s) " % ",".join("?" * len(corpus_names))
        args += corpus_names
    sql += "ORDER BY score LIMIT ?"
    args.append(max(k * 4, k))
    try:
        rows = conn.execute(sql, args).fetchall()
    except sqlite3.OperationalError as exc:
        conn.close()
        return [{"error": str(exc)}]
    conn.close()

    out, seen_path = [], {}
    for path, corpus, line, body, score in rows:
        # 同一文件最多贡献 2 条，避免一个大文件占满结果
        seen_path[path] = seen_path.get(path, 0) + 1
        if seen_path[path] > 2:
            continue
        snippet = re.sub(r"\s+", " ", body)[:280]
        out.append({
            "path": path,
            "corpus": corpus,
            "line": line,
            "score": round(-score, 4),  # bm25 越小越相关，取负让「大=相关」更好读
            "snippet": snippet,
        })
        if len(out) >= k:
            break
    return out


def stat() -> dict:
    p = index_path()
    conn = open_db()
    files = conn.execute("SELECT COUNT(*), SUM(chunks) FROM files").fetchone()
    by_corpus = conn.execute(
        "SELECT corpus, COUNT(*), SUM(chunks) FROM files GROUP BY corpus ORDER BY corpus"
    ).fetchall()
    conn.close()
    return {
        "index": str(p),
        "bytes": p.stat().st_size if p.is_file() else 0,
        "files": files[0] or 0,
        "chunks": files[1] or 0,
        "by_corpus": [{"corpus": c, "files": f, "chunks": ch or 0} for c, f, ch in by_corpus],
    }


# ---- grep 基线对比 ----------------------------------------------------------
#
# 这条是「先证明增量，再付出成本」的落地：拿同样的查询，比 FTS5 与朴素 grep 的命中文件数。
# 不是评测（没有标准答案），是量级判断——如果 grep 已经能命中，索引就是白建。

def _grep_hits(query: str, corpus_names: list[str], limit: int = 200) -> set[str]:
    """朴素基线：查询按空白切词，任一词字面出现在文件里就算命中。"""
    words = [w for w in re.split(r"\s+", query.strip()) if len(w) >= 2]
    if not words:
        return set()
    hits: set[str] = set()
    for name in corpus_names:
        for path in corpora().get(name, []):
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if any(w in text for w in words):
                hits.add(str(path.resolve()))
            if len(hits) >= limit:
                return hits
    return hits


def bench(queries: list[str], corpus_names: list[str], k: int = 5) -> list[dict]:
    rows = []
    for q in queries:
        fts = [r for r in search(q, k=k, corpus_names=corpus_names) if "path" in r]
        grep = _grep_hits(q, corpus_names)
        rows.append({
            "query": q,
            "fts_files": len({r["path"] for r in fts}),
            "fts_top": [f"{Path(r['path']).name}:{r['line']}" for r in fts[:3]],
            "grep_files": len(grep),
            # grep 能「答」= 至少命中一个文件，且命中数不超过 k（人工可读）。
            # grep=0 不是「够用」，是「找不到」——这正是索引存在的理由。
            "grep_can_answer": 0 < len(grep) <= k,
        })
    return rows


# ---- CLI --------------------------------------------------------------------

def _split(v: str) -> list[str]:
    return [x.strip() for x in v.split(",") if x.strip()]


def main() -> int:
    ap = argparse.ArgumentParser(description="内容检索索引（FTS5 + CJK bigram）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="建/更新索引（增量）")
    b.add_argument("--corpus", default="all", help="逗号分隔；all=全部")
    b.add_argument("--force", action="store_true", help="忽略 mtime 全量重建")

    s = sub.add_parser("search", help="检索")
    s.add_argument("query")
    s.add_argument("--k", type=int, default=5)
    s.add_argument("--corpus", default="", help="逗号分隔；缺省全部")
    s.add_argument("--json", action="store_true")

    sub.add_parser("stat", help="索引状态")

    bn = sub.add_parser("bench", help="与 grep 基线对比")
    bn.add_argument("queries", nargs="+")
    bn.add_argument("--corpus", default="l2,outputs,docs")
    bn.add_argument("--k", type=int, default=5)

    args = ap.parse_args()
    names = list(corpora().keys())

    if args.cmd == "build":
        want = names if args.corpus == "all" else _split(args.corpus)
        bad = [w for w in want if w not in names]
        if bad:
            print(f"未知语料: {bad}（可用: {', '.join(names)}）", file=sys.stderr)
            return 2
        st = build(want, force=args.force)
        print(json.dumps(st, ensure_ascii=False))
        return 0

    if args.cmd == "search":
        cs = _split(args.corpus) or None
        res = search(args.query, k=args.k, corpus_names=cs)
        if args.json:
            print(json.dumps(res, ensure_ascii=False, indent=1))
        else:
            if not res:
                print("（无命中）")
            for r in res:
                if "error" in r:
                    print(f"ERROR: {r['error']}")
                    continue
                print(f"[{r['score']:>7}] {r['path']}:{r['line']}  ({r['corpus']})")
                print(f"          {r['snippet'][:200]}")
        return 0

    if args.cmd == "stat":
        print(json.dumps(stat(), ensure_ascii=False, indent=1))
        return 0

    if args.cmd == "bench":
        cs = _split(args.corpus)
        rows = bench(args.queries, cs, k=args.k)
        print(json.dumps(rows, ensure_ascii=False, indent=1))
        n = len(rows)
        better = sum(1 for r in rows if r["fts_files"] > 0)
        print(f"\n{better}/{n} 条查询 FTS5 有命中", file=sys.stderr)
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
