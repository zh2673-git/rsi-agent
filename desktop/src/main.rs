//! rsi-agent 桌面薄壳：只负责「开一个 WebView 窗口 + 按需拉起 host + 关窗回收自己拉起的 host」。
//! 不引入第二套 UI、不改 host 业务代码；编排逻辑复用根目录 run.cmd。
mod host;

use std::sync::Mutex;

// 本壳拥有的 run.cmd 进程（Some = 自己拉起并负责回收；None = 复用外部实例）。
static OWNED: Mutex<Option<std::process::Child>> = Mutex::new(None);

fn main() {
    let owned = match host::ensure_ready() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[rsi-desktop] host 启动失败: {e}（窗口仍会打开，可手动运行 run.cmd）");
            None
        }
    };
    let owned_pid = owned.as_ref().map(|(_, p)| *p);
    *OWNED.lock().unwrap() = owned.map(|(child, _)| child);

    let app = tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败（检查 desktop/tauri.conf.json）");

    app.run(move |_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(pid) = owned_pid {
                host::stop_owned(pid);
            }
            // 让 run.cmd 的 host 有机会随 cmd 退出；不再显式 wait，避免卡住退出。
            drop(OWNED.lock().unwrap().take());
        }
    });
}
