//! guest 失联自愈（K7）：宿主侧看门狗。
//!
//! 背景（为什么必须在宿主侧做）：内核 `dispatch` 只在 `PluginPanic` 时走
//! `handle_plugin_failure`；进程型 guest 死掉后拿到的是 `KernelError::DomainUnavailable`
//! （Display = `[K700] execution domain '<id>' not available in this build`），插件状态仍是
//! Running ⇒ 之后**每一次**调用都 K700，只能重启宿主。而 `Kernel` 的公开 API 只有
//! `new/register/dispatch/hot_swap/run/stop/destroy`，没有 `unload`（`inner` 是 pub(crate)），
//! 宿主无法「先卸后注」；但 `hot_swap` 的 `plan()` 只查 `registry.generation_of(id)`，
//! 死插件并未 unload、仍在注册表里 ⇒ 宿主侧可以「重新 spawn → hot_swap 原地替换」自愈，
//! 不必改内核。
//!
//! 语义边界（改前必读）：
//! - **只在错误是 K700 / DomainUnavailable 时触发**。K502（deadline 超时）与 K403（draining）
//!   说明 guest 活着，重启只会放大故障；探针超时同样不触发（serial 插件可能只是排队）。
//! - 探针用**轻量只读 op**，不复用启动期那条真 chat 探测（那会打真模型、烧配额）。
//! - `hot_swap` 不重放 `init(config)` 的 raw（内核用 `PluginConfig::default()`）。当前四个
//!   guest 都靠 env 恢复（memory: MEMORY_DATA_DIR；tools: TOOLS_ENABLED/SANDBOX_HELPER），
//!   故此处按 spec 重新计算 env 后 spawn 即可。将来若有插件依赖 init raw，必须把 raw 放进
//!   spec，否则自愈会「起来但行为不对」。
//! - `register`/`hot_swap` 失败只 `tracing::error!` 且返回 `()`，返回值不可信 ⇒ 本模块
//!   不把「调用没 panic」当成功，成功判据是**下一轮探针通过**（日志里能看到恢复）。

use crate::assemble::{self, HostSpec, PluginRuntime, PluginSpec};
use crate::{manifests, spawn};
use agent_kernel_kernel::Kernel;
use agent_kernel_sdk::{Envelope, PluginId};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 探针间隔。memory 是 serial 语义（整段 on_event 加插件级锁），间隔太密会与真回合排队；
/// 5s 足够在用户察觉前发现失联，又不至于和 30s 的 trace.read 轮询打架。
const TICK: Duration = Duration::from_secs(5);
/// 单次探针超时。给宽是刻意的：serial 插件在忙一个长回合时探针会排在后面，20s 内返回
/// 都算活着；真正的死亡是「立刻 K700」，不会等到超时。
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// 同一插件自愈失败后的冷却，避免对「怎么都起不来」的插件做忙重试（会拖慢所有探针）。
const BACKOFF: Duration = Duration::from_secs(30);

/// 启动看门狗。返回的句柄由 main 在退出前 `abort()`。
pub fn spawn_watchdog(kernel: Arc<Kernel>, spec: HostSpec) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move { run(kernel, spec).await })
}

async fn run(kernel: Arc<Kernel>, spec: HostSpec) {
    let mut cooldown: HashMap<String, Instant> = HashMap::new();
    // 首轮先让启动探测/预热跑完，别在宿主刚起来时抢锁。
    tokio::time::sleep(TICK).await;
    loop {
        for p in &spec.plugins {
            let Some(payload) = probe_payload(&p.id) else { continue };
            if let Some(t) = cooldown.get(&p.id) {
                if t.elapsed() < BACKOFF {
                    continue;
                }
            }
            let env = Envelope::new(PluginId::new(&p.id), payload);
            let dead = match tokio::time::timeout(PROBE_TIMEOUT, kernel.dispatch(env)).await {
                Ok(Ok(_)) => false,
                Ok(Err(e)) => is_domain_unavailable(&e),
                // 超时 ≠ 死：serial 插件可能正忙。交给下一轮。
                Err(_) => false,
            };
            if !dead {
                continue;
            }
            tracing::warn!(
                "guest {}({}) 探针返回 K700（执行域不可用）→ 判定进程已死，尝试自愈",
                p.id,
                if p.runtime == PluginRuntime::Python { "py" } else { "ts" }
            );
            match heal_one(&kernel, p).await {
                Ok(()) => match verify(&kernel, p).await {
                    Ok(()) => {
                        tracing::info!("guest {} 自愈成功（已 hot_swap 并复探通过）", p.id);
                        cooldown.remove(&p.id);
                    }
                    Err(e) => {
                        tracing::error!("guest {} 已 hot_swap 但复探仍失败: {e}", p.id);
                        cooldown.insert(p.id.clone(), Instant::now());
                    }
                },
                Err(e) => {
                    tracing::error!("guest {} 自愈失败（重 spawn 未成功）: {e}", p.id);
                    cooldown.insert(p.id.clone(), Instant::now());
                }
            }
        }
        tokio::time::sleep(TICK).await;
    }
}

/// 探针 payload：只用**只读、无副作用、不打外部服务**的 op。
///
/// 刻意不复用 `PluginSpec::probe`：llm-adapter 的启动探测是一条真 `chat`（会打真模型）。
fn probe_payload(id: &str) -> Option<Value> {
    match id {
        // memory 的 get 在会话不存在时返回空会话，不写盘。
        "memory" => Some(json!({"op": "get", "session_id": "__probe__"})),
        // tools 的 list 只回启用清单。
        "tools" => Some(json!({"op": "list"})),
        "assets" => Some(json!({"op": "skills.list"})),
        // provider.capabilities 只读本地能力表；未知 provider 才 K400——不是 K700，
        // 因此这里拿 K400 不会误触发自愈（触发条件是 K700）。
        "llm-adapter" => Some(json!({"op": "provider.capabilities"})),
        _ => None,
    }
}

/// 是否「执行域不可用」。`KernelError::DomainUnavailable` 的 Display 带 `[K700]` 前缀，
/// 这里按码判而不是按文案判：内核换措辞也不会让自愈失效。
fn is_domain_unavailable(e: &agent_kernel_sdk::KernelError) -> bool {
    let s = e.to_string();
    s.contains("[K700]") || s.contains("K700")
}

async fn verify(kernel: &Kernel, p: &PluginSpec) -> Result<(), String> {
    let payload = probe_payload(&p.id).ok_or_else(|| "无探针".to_string())?;
    let env = Envelope::new(PluginId::new(&p.id), payload);
    match tokio::time::timeout(PROBE_TIMEOUT, kernel.dispatch(env)).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("复探超时".into()),
    }
}

/// 用**原 spec** 重新 spawn 并原地替换。
///
/// env 必须重算：`assemble_with` 在启动期把 `SANDBOX_HELPER` 塞进 tools 的 env（沙箱
/// fail-closed 装配），spec 里并不含它；直接拿 `p.env` 重 spawn 会让 tools **悄悄失去沙箱**。
async fn heal_one(kernel: &Kernel, p: &PluginSpec) -> Result<(), String> {
    let mut env = p.env.clone();
    if p.bash_sandbox {
        assemble::apply_bash_sandbox(&mut env).await;
    }
    let caps: Vec<&str> = p.capabilities.iter().map(String::as_str).collect();
    let manifest = manifests::guest_manifest(&p.id, &caps, p.concurrent);
    let plugin = match p.runtime {
        PluginRuntime::Python => {
            let py = spawn::find_interpreter().ok_or_else(|| "python 未找到".to_string())?;
            spawn::spawn_python(py, &p.script, manifest, &env).await
        }
        PluginRuntime::NodeTs => {
            let node = spawn::find_node().ok_or_else(|| "node 未找到".to_string())?;
            spawn::spawn_node_ts(node, &p.script, manifest, &env).await
        }
    }
    .map_err(|e| format!("spawn 失败: {e}"))?;
    kernel.hot_swap(PluginId::new(&p.id), Arc::new(plugin)).await;
    Ok(())
}
