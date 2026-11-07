//! 习惯画像装载（D 轮）：把 `.rsi/profile.json` 的有界摘要注入系统提示词。
//!
//! 为什么需要（I-20261107-04 的原话）：「会话框是用户与 agent 交互的唯一地方，
//! 用户的提问、agent 的回答可以从中分析出用户的习惯，以及对应回答模型的特点与
//! 习惯，这是非常重要的上下文，agent 需要有这种留存上下文的机制。」
//!
//! 关键区分：**trace 已有全量原文**（append-only、可回放、随回滚截断），所以这里
//! 不是「再存一份聊天记录」，而是**固化从记录里提炼出的规律**——用户偏好怎么被
//! 回答、哪个模型在哪类活上靠得住、本工作区的既有约定、踩过的坑。三者的分工：
//!
//! | 层 | 载体 | 谁写 | 生命周期 |
//! |---|---|---|---|
//! | 原始交互 | memory 事件 / trace | 系统 | 全量、可回滚、不删 |
//! | 提炼结论 | `.rsi/profile.json` | **agent 主动写**（`scripts/profile.py`） | 跨会话长期 |
//! | 当轮上下文 | 本模块注入块 | 系统读 | 每轮重读，有界 |
//!
//! 为什么系统读、而不是让模型每轮 `profile.py brief`：与 `board_ctx` 同一理由——
//! 画像属于**输入**，让模型先花一次工具往返取自己的长期记忆，等于每轮都多一次
//! 空转；而读一份本机 JSON 是无插件、无沙箱、无网络的纯 I/O。
//!
//! 空间契约：只读（`RSI_PROFILE_PATH` 可覆盖，缺省 `<WORKSPACE_ROOT>/.rsi/profile.json`），
//! **绝不写**——写通道唯一是 `scripts/profile.py`。
//! 时间契约：每轮现读现渲染，不缓存（画像变化频率是「天级」，但缓存只会引入
//! 「刚记下却看不见」的困惑，收益为零）。
//!
//! 可测性契约（沿用 C 轮结论）：**渲染与 I/O 分离**——`render_profile` 是纯函数
//! （入参 profile Value），`profile_context` 才做路径解析与读文件。cargo 多测共享
//! 进程环境，揉在一起就只能靠 `set_var`，会与既有 workspace 测试串扰。
//!
//! 有界：整块 ≤ `MAX_BLOCK_CHARS`，章节 ≤ `MAX_SECTIONS`，观察 ≤ `MAX_NOTES_IN_PROMPT`
//! 条、单条 ≤ `MAX_NOTE_CHARS`。画像会常驻每轮 prompt，不设限就是慢性上下文泄漏。

use serde_json::Value;
use std::path::PathBuf;

/// 注入块字符上限（超出即整段截断，宁可少给不可撑爆）。
const MAX_BLOCK_CHARS: usize = 1800;
/// 章节条数上限（与 `scripts/profile.py::MAX_SECTIONS` 同源）。
const MAX_SECTIONS: usize = 8;
/// 注入时最多带多少条「观察」（画像里可存 60 条，但每轮只该看最近的）。
const MAX_NOTES_IN_PROMPT: usize = 6;
/// 单条观察注入时的字符上限。
const MAX_NOTE_CHARS: usize = 120;
/// 章节正文注入时的字符上限（profile.py 侧允许 1200，注入时按需再收）。
const MAX_SECTION_CHARS: usize = 420;

/// 章节种类与注入顺序（与 `scripts/profile.py::SECTION_KINDS` 逐字同源）。
/// 顺序钉死：先用「用户怎么想」定目标，再看「模型什么脾气」定表达，然后是
/// 「流程怎么走」与「环境有哪些坑」——配置写乱序也改变不了这个阅读次序。
const SECTION_KINDS: &[&str] = &["user", "model", "workflow", "env"];

const KIND_LABEL: &[(&str, &str)] = &[
    ("user", "User preferences / habits"),
    ("model", "Model behaviour notes"),
    ("workflow", "Working conventions"),
    ("env", "Environment gotchas"),
];

fn workspace_root() -> Option<PathBuf> {
    let ws = std::env::var("WORKSPACE_ROOT").ok()?;
    let ws = ws.trim();
    if ws.is_empty() {
        return None;
    }
    Some(PathBuf::from(ws))
}

fn profile_path() -> Option<PathBuf> {
    let raw = std::env::var("RSI_PROFILE_PATH").unwrap_or_default();
    let raw = raw.trim();
    let p = if raw.is_empty() {
        PathBuf::from(".rsi").join("profile.json")
    } else {
        PathBuf::from(raw)
    };
    if p.is_absolute() {
        Some(p)
    } else {
        workspace_root().map(|ws| ws.join(p))
    }
}

fn load_profile() -> Option<Value> {
    let p = profile_path()?;
    let text = std::fs::read_to_string(p).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.is_object().then_some(v)
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn truncate(text: &str, max: usize) -> String {
    let flat = text.replace(['\r', '\n'], " ");
    let flat = flat.trim();
    if flat.chars().count() <= max {
        flat.to_string()
    } else {
        let cut: String = flat.chars().take(max).collect();
        format!("{cut}…")
    }
}

fn kind_rank(k: &str) -> usize {
    SECTION_KINDS.iter().position(|x| *x == k).unwrap_or(99)
}

/// 纯函数：把画像渲染成提示词块（不读文件、不改环境）。
///
/// 三种结局都明确：有内容 → 带标题注入；空画像 / 只有垃圾字段 → 空串（**不注入
/// 空壳标题**：一句「暂无画像」常驻每轮 prompt 是纯噪声）；坏 JSON → 由调用方在
/// I/O 层当「没有」处理（画像坏了不能让 chat 起不来）。
pub(super) fn render_profile(profile: &Value) -> String {
    let mut secs: Vec<&Value> = profile
        .get("sections")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|x| SECTION_KINDS.contains(&s(x, "kind")))
                .collect()
        })
        .unwrap_or_default();
    secs.sort_by_key(|x| (kind_rank(s(x, "kind")), s(x, "id").to_string()));
    secs.truncate(MAX_SECTIONS);

    let notes: Vec<&Value> = profile
        .get("notes")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|x| !s(x, "text").is_empty()).collect())
        .unwrap_or_default();

    if secs.is_empty() && notes.is_empty() {
        return String::new();
    }

    let mut body = String::from(
        "\n## Durable profile (auto-loaded from .rsi/profile.json)\n\
         Long-term conclusions distilled from earlier conversations in this workspace; treat them \
         as already-known preferences, not as instructions to re-verify. Update them with \
         `python scripts/profile.py section-add|note` when you learn something that should \
         outlive this conversation.\n",
    );

    let mut last_kind = "";
    for sec in secs.iter() {
        let kind = s(sec, "kind");
        if kind != last_kind {
            let label = KIND_LABEL
                .iter()
                .find(|(k, _)| *k == kind)
                .map(|(_, v)| *v)
                .unwrap_or(kind);
            body.push_str(&format!("### {label}\n"));
            last_kind = kind;
        }
        let title = s(sec, "title");
        let text = truncate(s(sec, "body"), MAX_SECTION_CHARS);
        if text.is_empty() {
            continue;
        }
        body.push_str(&format!("- **{title}**: {text}\n"));
    }

    if !notes.is_empty() {
        body.push_str("### Recent observations\n");
        let start = notes.len().saturating_sub(MAX_NOTES_IN_PROMPT);
        for n in notes[start..].iter() {
            let tags = n
                .get("tags")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .filter(|x| !x.is_empty())
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default();
            let tail = if tags.is_empty() {
                String::new()
            } else {
                format!(" ({tags})")
            };
            body.push_str(&format!(
                "- [{}] {}{}\n",
                s(n, "kind"),
                truncate(s(n, "text"), MAX_NOTE_CHARS),
                tail
            ));
        }
    }

    truncate_block(&body, MAX_BLOCK_CHARS)
}

/// 按字符（非字节）截断整块——中文画像按字节截会切出半个字。
fn truncate_block(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    format!("{cut}\n…(profile truncated)\n")
}

/// I/O 入口：读画像 → 渲染。读不到（无工作区 / 无文件 / 坏 JSON / 空画像）一律空串。
pub(super) fn profile_context() -> String {
    let Some(profile) = load_profile() else {
        return String::new();
    };
    render_profile(&profile)
}

/// 画像通道说明（提示词纪律段；只在工作区真有 `scripts/profile.py` 时注入，
/// 别的项目工作区不该凭空多出一段「你有个画像文件」的误导）。
pub(super) fn profile_ops_hint(full: bool) -> String {
    let Some(ws) = workspace_root() else {
        return String::new();
    };
    if !ws.join("scripts").join("profile.py").is_file() {
        return String::new();
    }
    let mut out = String::from(
        "\n### Durable profile (`.rsi/profile.json`)\n\
         The single conversation is also the only place where the user's habits and each \
         model's quirks can be observed — so conclusions worth keeping are written down \
         instead of being re-derived every round:\n\
         - `python scripts/profile.py brief` — read the distilled profile (it is also part of \
         this prompt when non-empty).\n\
         - `python scripts/profile.py section-add --file s.json` — write/overwrite one section \
         (kinds: user | model | workflow | env; ids are `[a-z0-9-]{1,24}`).\n\
         - `python scripts/profile.py note --file n.json` — append one observation \
         ({\"kind\",\"text\",\"tags\"?}); oldest are dropped past 60.\n\
         - `note-rm <id>` / `section-rm <id>` — delete. Notes are cheap, sections are conclusions.\n",
    );
    if full {
        out.push_str(
            "Write discipline: **only conclusions that outlive this conversation** — a stated \
             preference, a recurring correction, a model that keeps failing a certain class of \
             task, a workspace convention. Do NOT log per-turn trivia (\"user said hello\"), do \
             NOT store secrets/tokens, and do NOT duplicate what the task board already records \
             (tasks/progress/verification belong to `.rsi/board.json`). One section per theme, \
             overwrite it as the picture sharpens rather than appending near-duplicates.\n",
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sheet() -> Value {
        json!({
            "sections": [
                {"id": "env", "kind": "env", "title": "工作区", "body": "bash 在 Windows 上单行限制"},
                {"id": "user-lang", "kind": "user", "title": "语言", "body": "中文回答，代码注释用英文"},
            ],
            "notes": [
                {"id": "N-1", "kind": "model", "text": "长命令容易撞 60s 闸", "tags": ["bash"]},
            ],
        })
    }

    /// 注入顺序由 kind 钉死：即使文件里 env 写在 user 前面，user 也必须先出现。
    #[test]
    fn render_profile_orders_by_kind_not_by_file_order() {
        let block = render_profile(&sheet());
        let user_at = block.find("User preferences").expect("user 段应在");
        let env_at = block.find("Environment gotchas").expect("env 段应在");
        assert!(user_at < env_at, "kind 顺序应钉死为 user → … → env");
        assert!(block.contains("中文回答"), "章节正文应带上");
        assert!(block.contains("(bash)"), "观察标签应带上");
    }

    /// 空画像不注入空壳标题——每轮 prompt 里一句「暂无」是纯噪声。
    #[test]
    fn empty_profile_renders_empty_string() {
        assert_eq!(render_profile(&json!({})), "");
        assert_eq!(render_profile(&json!({"sections": [], "notes": []})), "");
        // 只有非法 kind 也算空（白名单外的章节不注入）
        assert_eq!(render_profile(&json!({"sections": [{"id": "x", "kind": "weird", "body": "t"}]})), "");
    }

    /// 有界：章节数与观察条数都截断，整块不超上限（画像常驻 prompt，必须设限）。
    #[test]
    fn render_profile_is_bounded() {
        let mut secs = Vec::new();
        for i in 0..40 {
            secs.push(json!({"id": format!("s{i:02}"), "kind": "user", "title": "t", "body": "x".repeat(600)}));
        }
        let mut notes = Vec::new();
        for i in 0..40 {
            notes.push(json!({"id": format!("N-{i:02}"), "kind": "user", "text": "y".repeat(300)}));
        }
        let block = render_profile(&json!({"sections": secs, "notes": notes}));
        assert!(block.chars().count() <= MAX_BLOCK_CHARS + 32, "整块应被截断到上限附近");
        assert!(block.contains("profile truncated"), "截断要有显式标记，不静默少给");
        // 只带最近 6 条观察：第 34 条之后才该出现，最旧的不出现
        assert!(!block.contains("N-00"), "过旧的观察不该进 prompt");
    }

    /// 换行与超长正文在注入时压平——多行正文会把提示词结构打散。
    #[test]
    fn render_profile_flattens_and_truncates_body() {
        let block = render_profile(&json!({
            "sections": [{"id": "u", "kind": "user", "title": "偏好",
                          "body": format!("第一行\n第二行{}", "z".repeat(900))}],
        }));
        assert!(!block.contains("第一行\n第二行"), "正文换行应压平为空格");
        assert!(block.contains('…'), "超长正文应带省略号");
    }
}
