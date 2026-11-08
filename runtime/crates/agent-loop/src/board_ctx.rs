//! 看板上下文装载（C 轮）：把 `@T-…` / `@I-…` 引用与在办任务摘要注入系统提示词。
//!
//! 为什么在 agent-loop 里直接读文件、而不是让模型先发一次 `board.py resolve`：
//! ① 引用是**输入的一部分**，不是待办事项——要模型先花一次工具往返才看见自己刚被
//! 引用的任务，多引用时就是 N 次往返；② 读一份本机 JSON 是纯 I/O，无插件、无沙箱、
//! 无网络，代价远小于一次工具波次；③ 失败必须静默（文件缺失/坏 JSON → 空串），
//! 绝不能因为看板坏了让 chat 起不来。
//!
//! 空间契约：只读 `WORKSPACE_ROOT/.rsi/board.json`（`RSI_BOARD_PATH` 可覆盖），
//! **不写**——写通道唯一是 `scripts/board.py`（agent）与 host 的 `/api/board`（UI）。
//! 时间契约：每次 chat 现读现渲染，不缓存（看板是分钟级变化，缓存只会让引用读到旧态）。
//!
//! 可测性契约（本轮踩过的坑）：**渲染与 I/O 分离**。`render_refs` / `render_open_tasks`
//! 是纯函数（输入 board Value），`refs_context` 才做路径解析与读文件。初版把读文件
//! 与渲染揉在一起，测试只能 `set_var("WORKSPACE_ROOT")`——而 cargo 多测共享进程环境，
//! 与既有 `self_extension_section_gated_by_workspace_reachability` 直接串扰（实测红）。
//!
//! 有界：整块 ≤ `MAX_BLOCK_CHARS`，在办摘要 ≤ `MAX_OPEN_TASKS` 条——防止 200 条任务的
//! 看板把每轮 prompt 撑爆（这是「看板不进上下文」纪律被有条件放宽的代价，必须显式设限）。

use serde_json::Value;
use std::path::PathBuf;

/// 注入块字符上限；超出即截断（宁可少给，不可撑爆上下文）。
const MAX_BLOCK_CHARS: usize = 4000;
/// 无引用时的在办任务摘要条数上限。
const MAX_OPEN_TASKS: usize = 12;
/// 单条引用里计划/验收/检查的展示条数上限。
const MAX_ITEMS: usize = 6;

fn workspace_root() -> Option<PathBuf> {
    let ws = std::env::var("WORKSPACE_ROOT").ok()?;
    let ws = ws.trim();
    if ws.is_empty() {
        return None;
    }
    Some(PathBuf::from(ws))
}

fn board_path() -> Option<PathBuf> {
    let raw = std::env::var("RSI_BOARD_PATH").unwrap_or_default();
    let raw = raw.trim();
    let p = if raw.is_empty() {
        PathBuf::from(".rsi").join("board.json")
    } else {
        PathBuf::from(raw)
    };
    if p.is_absolute() {
        Some(p)
    } else {
        workspace_root().map(|ws| ws.join(p))
    }
}

fn load_board() -> Option<Value> {
    let p = board_path()?;
    let text = std::fs::read_to_string(p).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.is_object().then_some(v)
}

/// 从任意文本里抽出 `@T-…` / `@I-…` 引用（去重保序）。
///
/// 手写扫描而非正则：形状固定为 `@` + 单字母前缀 + `-` + 8 位日期 + `-` + 2~3 位序号，
/// 且本 crate 无 regex 依赖（不为一个 token 抽取加 crate）。松匹配会把 `@Tomorrow`
/// 当引用，紧匹配会漏真引用——两个方向都有代价，故按 ID 形状严格判定。
pub(super) fn extract_refs(text: &str) -> Vec<String> {
    let cs: Vec<char> = text.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i + 1 < cs.len() {
        if cs[i] == '@' && (cs[i + 1] == 'T' || cs[i + 1] == 'I') {
            let start = i + 1;
            let mut j = start + 1;
            while j < cs.len() && (cs[j].is_ascii_digit() || cs[j] == '-') {
                j += 1;
            }
            let cand: String = cs[start..j].iter().collect();
            let parts: Vec<&str> = cand.split('-').collect();
            let ok = parts.len() == 3
                && parts[0].len() == 1
                && parts[1].len() == 8
                && parts[1].chars().all(|c| c.is_ascii_digit())
                && (parts[2].len() == 2 || parts[2].len() == 3)
                && parts[2].chars().all(|c| c.is_ascii_digit());
            if ok && !out.contains(&cand) {
                out.push(cand);
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    out
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn u(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn arr<'a>(v: &'a Value, key: &str) -> Vec<&'a Value> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default()
}

fn strs(v: &Value, key: &str) -> Vec<String> {
    arr(v, key)
        .iter()
        .filter_map(|x| x.as_str())
        .filter(|x| !x.is_empty())
        .map(str::to_string)
        .collect()
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let cut: String = text.chars().take(max).collect();
        format!("{cut}…")
    }
}

fn or_default<'a>(v: &'a Value, key: &str, fallback: &'a str) -> &'a str {
    let got = s(v, key);
    if got.is_empty() {
        fallback
    } else {
        got
    }
}

/// 单个任务的引用块（含目标/计划/验收/检查结论/人财物/产物）。
fn render_task(t: &Value) -> String {
    let prog = t.get("progress").cloned().unwrap_or(Value::Null);
    let ev = t.get("evaluation").cloned().unwrap_or(Value::Null);
    let res = t.get("resourcing").cloned().unwrap_or(Value::Null);
    let done = u(&prog, "done");
    let total = u(&prog, "total");
    let note = s(&prog, "note");
    let mut out = format!(
        "- @{} 「{}」 status={} priority={} progress={}{} verdict={}\n",
        s(t, "id"),
        truncate(s(t, "title"), 80),
        s(t, "status"),
        s(t, "priority"),
        if total > 0 { format!("{done}/{total}") } else { "-".into() },
        if note.is_empty() { String::new() } else { format!(" ({})", truncate(note, 60)) },
        or_default(&ev, "verdict", "none"),
    );
    let goal = s(t, "goal");
    if !goal.is_empty() {
        out.push_str(&format!("  goal: {}\n", truncate(goal, 160)));
    }
    let plan = arr(t, "plan");
    if !plan.is_empty() {
        let items: Vec<String> = plan
            .iter()
            .take(MAX_ITEMS)
            .map(|p| {
                let mark = match s(p, "status") {
                    "completed" => "[x]",
                    "in_progress" => "[~]",
                    "cancelled" => "[-]",
                    _ => "[ ]",
                };
                format!("{mark} {}", truncate(s(p, "step"), 48))
            })
            .collect();
        out.push_str(&format!("  plan: {}\n", items.join(" / ")));
    }
    let acc = arr(t, "acceptance");
    if !acc.is_empty() {
        let list: Vec<String> = acc
            .iter()
            .take(MAX_ITEMS)
            .map(|a| truncate(a.as_str().unwrap_or(""), 60))
            .collect();
        out.push_str(&format!("  acceptance: {}\n", list.join("；")));
    }
    let checks = arr(t, "checks");
    if !checks.is_empty() {
        let list: Vec<String> = checks
            .iter()
            .take(MAX_ITEMS)
            .map(|c| format!("{}={}", s(c, "id"), or_default(c, "status", "pending")))
            .collect();
        out.push_str(&format!(
            "  checks: {} (pass={} fail={} skip={})\n",
            list.join(" "),
            u(&ev, "pass"),
            u(&ev, "fail"),
            u(&ev, "skip"),
        ));
    }
    let skills = strs(&res, "skills");
    if !skills.is_empty() {
        out.push_str(&format!(
            "  resourcing: model={} effort={} skills={}\n",
            or_default(&res, "model", "current"),
            or_default(&res, "effort", "medium"),
            skills.join(",")
        ));
    }
    let arts = strs(t, "artifacts");
    if !arts.is_empty() {
        out.push_str(&format!("  artifacts: {}\n", arts.join(" ")));
    }
    // G5（I-20261108-04 第 3 条）：任务被 @ 引用时也要带上**结果**，不只有过程。
    // 此前 render_task 给的是 goal/plan/acceptance/checks——全是「打算怎么做」，
    // 缺「最后做成了什么」。后果是引用一件已完成任务时 agent 仍要翻对话才知道结论，
    // 跨任务归纳（digest）同理。两条线都进上下文：
    //   brief = 用户视角的一句话结论（复述它即可，不必自己组织话术）
    //   pro   = 专业结论（判断「能不能复用、还差什么」的依据）
    let outs = t.get("outcomes").cloned().unwrap_or(Value::Null);
    let brief = s(&outs, "brief");
    if !brief.is_empty() {
        out.push_str(&format!("  outcome: {}\n", truncate(brief, 200)));
    }
    let pro = s(&outs, "pro");
    if !pro.is_empty() {
        out.push_str(&format!("  outcome_detail: {}\n", truncate(pro, 300)));
    }
    out
}

/// 单条灵感的引用块（原文 + 标签 + 已采纳的任务）。
fn render_inspiration(i: &Value) -> String {
    let tags = strs(i, "tags");
    let mut out = format!(
        "- @{} 「{}」 status={}{}\n",
        s(i, "id"),
        truncate(s(i, "text"), 200),
        s(i, "status"),
        if tags.is_empty() { String::new() } else { format!(" tags={}", tags.join(",")) }
    );
    let tasks = strs(i, "tasks");
    if !tasks.is_empty() {
        out.push_str(&format!("  adopted_by: {}\n", tasks.join(",")));
    }
    out
}

/// 纯函数：把用户文本里的引用渲染成上下文块（不读文件、不改环境）。
///
/// 三种结局都要**明确**，不能静默：命中 → 装载；全部未命中 → 只回报缺失（空壳 header
/// 比不注入更误导）；无引用 → 空串（调用方决定是否退化为在办摘要）。
pub(super) fn render_refs(user_text: &str, board: &Value) -> String {
    let tasks = arr(board, "tasks");
    let insps = arr(board, "inspirations");
    let refs = extract_refs(user_text);
    if refs.is_empty() {
        return String::new();
    }
    let mut body = String::new();
    let mut missing: Vec<String> = Vec::new();
    for r in &refs {
        if let Some(t) = tasks.iter().find(|t| s(t, "id") == r.as_str()) {
            body.push_str(&render_task(t));
        } else if let Some(i) = insps.iter().find(|i| s(i, "id") == r.as_str()) {
            body.push_str(&render_inspiration(i));
        } else {
            missing.push(r.clone());
        }
    }
    if body.is_empty() {
        return format!(
            "\n## Board references\n- {} not on the board (stale @-reference); ignore it or ask the user.\n",
            missing.join(", ")
        );
    }
    let mut block = String::from(
        "\n## Board references (auto-loaded from .rsi/board.json)\n\
         The user just @-referenced these board items; treat them as already-read context \
         (do not call `board.py show` again for them).\n",
    );
    block.push_str(&body);
    if !missing.is_empty() {
        block.push_str(&format!("- missing (not on the board): {}\n", missing.join(", ")));
    }
    truncate(&block, MAX_BLOCK_CHARS)
}

/// 纯函数：在办任务摘要（done/cancelled 排除，按看板顺序取前 N 条）。
pub(super) fn render_open_tasks(board: &Value) -> String {
    let open: Vec<&Value> = arr(board, "tasks")
        .into_iter()
        .filter(|t| !matches!(s(t, "status"), "done" | "cancelled"))
        .collect();
    if open.is_empty() {
        return String::new();
    }
    let mut block = String::from(
        "\n## Open tasks on the board (digest; `python scripts/board.py digest --skill <name>` \
         for same-kind history)\n",
    );
    for t in open.iter().take(MAX_OPEN_TASKS) {
        let prog = t.get("progress").cloned().unwrap_or(Value::Null);
        let done = u(&prog, "done");
        let total = u(&prog, "total");
        block.push_str(&format!(
            "- {} 「{}」 {} {} {}\n",
            s(t, "id"),
            truncate(s(t, "title"), 60),
            s(t, "status"),
            s(t, "priority"),
            if total > 0 { format!("{done}/{total}") } else { String::new() }
        ));
    }
    if open.len() > MAX_OPEN_TASKS {
        block.push_str(&format!(
            "- …共 {} 个未完成（`board.py list --status doing` 看全部）\n",
            open.len()
        ));
    }
    truncate(&block, MAX_BLOCK_CHARS)
}

/// I/O 入口：读板 → 引用优先；无引用且本轮像「交代一件成规模的事」→ 在办摘要。
/// 读不到板（无工作区 / 无文件 / 坏 JSON）一律空串——看板坏了不能拖垮 chat。
pub(super) fn refs_context(user_text: &str, want_plan: bool) -> String {
    let Some(board) = load_board() else {
        return String::new();
    };
    let refs = render_refs(user_text, &board);
    if !refs.is_empty() {
        return refs;
    }
    if want_plan {
        render_open_tasks(&board)
    } else {
        String::new()
    }
}

/// 看板通道补充说明（C 轮新增的五个 op）。
///
/// 为什么追加在独立段而不是改写 `skills.rs::task_board_section`：那段是 B 轮落地的长
/// 字符串字面量（含续行转义），改它等于重写整块提示词，锚点脆弱；这里新增一段，
/// 并纠正一处被本轮改变的事实——@引用现在自动装载，不再需要模型自己去 `show`。
pub(super) fn board_ops_hint(full: bool, has_cli: bool) -> String {
    if !has_cli {
        return String::new();
    }
    let mut out = String::from(
        "\n### Board ops added in this build\n\
         - `@T-...` / `@I-...` are **auto-loaded** into this prompt (see \"Board references\"); \
         do NOT run `board.py show` again for them.\n\
         - `board.py resolve \"<text>\"` — same resolution for text you are handed indirectly \
         (e.g. a queued message, a file).\n\
         - `board.py digest [--skill <name>] [--brief]` — same-kind history across tasks: use it \
         when the user asks \"how did we do this before\" or before re-inventing a workflow.\n\
         - `board.py layout` / `layout --file <json>` — the left panel is assembled from \
         `layout.sections` (kinds: tasks | metrics | inspirations, order fixed by kind).\n",
    );
    if full {
        out.push_str(
            "\n### Verification = evidence, not self-report (checks)\n\
             `acceptance` is the human-readable standard; `checks` is the machine-runnable proof. \
             Add 1-3 checks when the task has a runnable criterion, then run them:\n\
             ```json\n\
             \"checks\": [\n\
               {\"id\": \"c1\", \"kind\": \"cmd\",  \"name\": \"pytest 全绿\", \"target\": \"python -m pytest tests -q\", \"timeout_secs\": 120},\n\
               {\"id\": \"c2\", \"kind\": \"file\", \"name\": \"产物落盘\", \"target\": \"outputs/report.md\"},\n\
               {\"id\": \"c3\", \"kind\": \"grep\", \"name\": \"旧入口已删\", \"target\": \"postChat\", \"scope\": \"runtime/crates/host/web-dist/vendor\"},\n\
               {\"id\": \"c4\", \"kind\": \"manual\", \"name\": \"用户确认文案\"}\n\
             ]\n\
             ```\n\
             `cmd` exits 0 = pass (cwd = workspace); `file` = existence; `grep` = substring hit \
             under `scope`; `manual` always `skip` (a human judges it — you must not grade yourself).\n\
             Run `python scripts/board.py eval <ID>`; it writes `evaluation.verdict` and **downgrades \
             verifying/done back to doing when a check fails**. `done` without a passing evaluation \
             on a task that has checks is a self-report (the CLI warns you).\n\
             \n### Same-kind history (context management)\n\
             The board is where repeated work converges. Before starting something that smells \
             familiar, `board.py digest --skill <name> --brief` and reuse what was learned (plan \
             shape, artifacts, what failed). After finishing, keep the task's `plan`, `resourcing` \
             and `artifacts` accurate — a later digest is only as good as what you wrote now. \
             Keep digests out of the conversation: query when needed, do not paste them.\n",
        );
    }
    out
}

/// 工作区里是否有看板 CLI（`scripts/board.py`）——决定是否注入看板通道段。
/// 别的项目工作区没有这个脚本，就不该多出这段提示词。
pub(super) fn has_board_cli() -> bool {
    workspace_root()
        .map(|ws| ws.join("scripts").join("board.py").is_file())
        .unwrap_or(false)
}

/// D 轮：任务分解与委派纪律（I-20261107-01 的落点）。
///
/// 用户原话：「具体计划怎么执行，需要哪些部门哪些人，是否需要进一步的进行细分。
/// 这些 agent 需要自行在计划中写清楚，全盘考虑，是否需要调用子代理等。考虑好任务的
/// 复杂度。」
///
/// 为什么做成 plan 步上的 `owner` 字段而不是一段「请考虑复杂度」的软提示：
/// 软提示的产物是模型的自述（"这个任务比较复杂，我会分解"），无法核对；字段化之后
/// 每一步都必须回答「谁干」，验收时能数出来（几步委派、几步要现造技能）。
///
/// 三种 owner 的判据（写进提示词，避免模型凭感觉选）：
/// - `self`：需要本轮上下文才能做的步（改刚读过的那个函数、按上一次输出继续）；
/// - `subagent`：可自包含且**产物是结论而非改动**的步（大范围调研、跨文件阅读后总结、
///   多方案对比）——把它们的原文阅读留在子会话里，主上下文只收结论；
/// - `skill`：仓库里没有现成能力、要现造技能/工具才能做的步（这是「物力自造」的
///   入口：先写 SKILL.md 或 tools.json，再按 plan 走）。
///
/// 什么时候**才**该把一件事拆成多个任务（parent）：拆开的价值是「各自可独立验收」，
/// 若子件验收条件与父任务相同，拆了只是把进度条切成两段——那种情况就别拆。
pub(super) fn decompose_hint() -> String {
    if !has_board_cli() {
        return String::new();
    }
    String::from(
        "\n### Decomposition & delegation (`plan[].owner`, `parent`)\n\
         Each plan step records **who executes it** — this is how \"how complex is this, do I need \
         a sub-agent\" becomes checkable instead of self-reported:\n\
         - `owner: \"self\"` — needs this turn's context (edit the function you just read, continue \
         from the last output).\n\
         - `owner: \"subagent\"` — self-contained, and the deliverable is a *conclusion*, not an edit: \
         broad research, reading many files to summarise, comparing options. The raw reading stays \
         in the sub-session; this context only receives the answer.\n\
         - `owner: \"skill\"` — no existing capability in this workspace: author a skill/tool first \
         (skills self-extension), then run the step.\n\
         Default is `self` when omitted; do not mark everything `subagent` — delegation costs a \
         fresh context that knows nothing about this conversation.\n\
         \n\
         Split a request into child tasks (each with its own `parent: \"T-...\"`) **only when the \
         children are independently verifiable**. If a child's acceptance criteria are the same as \
         the parent's, splitting just cuts the progress bar in two — don't.\n\
         ```json\n\
         \"plan\": [\n\
           {\"step\": \"读现有看板实现，定位写通道\", \"status\": \"in_progress\", \"owner\": \"self\"},\n\
           {\"step\": \"调研同类工具怎么表达『人财物』\", \"owner\": \"subagent\"},\n\
           {\"step\": \"现造一个导出 CSV 的工具\", \"owner\": \"skill\"}\n\
         ]\n\
         ```\n\
         Sub-tasks: `task-upsert` with `\"parent\": \"T-...\"`; deleting a parent never deletes \
         children — `board.py task-rm` detaches them (`parent` cleared).\n",
    )
}
