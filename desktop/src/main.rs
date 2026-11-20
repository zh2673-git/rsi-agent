//! rsi-agent 桌面薄壳：先开窗口显示启动态，再后台拉起 host，就绪后导航到 Web UI。
//! 不引入第二套 UI、不改 host 业务代码；编排逻辑复用根目录 run.cmd。
mod host;

use std::sync::Mutex;
use tauri::Manager;

// 本壳拥有的 run.cmd 进程 pid（Some = 自己拉起并负责回收；None = 复用外部实例）。
static OWNED_PID: Mutex<Option<u32>> = Mutex::new(None);

fn splash_url() -> tauri::Url {
    // 纯本地启动页：无 host 也能秒开，避免冷启动时「半天没窗口」。
    let html = "<!doctype html><meta charset=utf-8><style>body{font:16px system-ui;background:#0f1115;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}.s{color:#8ab4f8;margin-top:12px}.e{color:#ff8a80}</style><div><h2>rsi-agent</h2><div class=s id=x>正在启动本地服务，请稍候…</div></div>";
    let pct = percent_encode(html);
    tauri::Url::parse(&format!("data:text/html,{pct}")).expect("启动页 URL 非法")
}

fn error_url(msg: &str) -> tauri::Url {
    let body = format!(
        "<!doctype html><meta charset=utf-8><style>body{{font:16px system-ui;background:#0f1115;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}}div{{text-align:center;max-width:640px}}.e{{color:#ff8a80}}</style><div><h2>rsi-agent 启动失败</h2><div class=e>{msg}</div></div>"
    );
    let pct = percent_encode(&body);
    tauri::Url::parse(&format!("data:text/html,{pct}")).expect("错误页 URL 非法")
}

// data URL 里只允许 unreserved 字符，其余按 UTF-8 字节百分号编码。
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn navigate(handle: &tauri::AppHandle, url: tauri::Url) {
    if let Some(win) = handle.get_webview_window("main") {
        if let Err(e) = win.navigate(url) {
            eprintln!("[rsi-desktop] 导航失败: {e}");
        }
    }
}

fn main() {
    // 立即建窗口显示启动页；host 准备放后台线程，避免「先阻塞再开窗」。
    let app = tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败（检查 desktop/tauri.conf.json）");

    let handle = app.handle().clone();
    navigate(&handle, splash_url());

    std::thread::spawn(move || {
        let addr = host::addr();
        let target_url = match tauri::Url::parse(&format!("http://{addr}/")) {
            Ok(u) => u,
            Err(e) => {
                navigate(&handle, error_url(&format!("地址非法: {e}")));
                return;
            }
        };

        // ensure_ready 可能拉起 run.cmd（异步返回，不再同步等 180s）。
        match host::ensure_ready() {
            Ok(owned) => {
                if let Some((_child, pid)) = owned {
                    *OWNED_PID.lock().unwrap() = Some(pid);
                    // 自己拉起的：等端口真正就绪。
                    if !host::wait_ready(&addr, 180) {
                        navigate(&handle, error_url("host 在 180s 内未就绪，请手动运行 run.cmd"));
                        return;
                    }
                }
                // 复用分支：端口已开，直接导航。
                navigate(&handle, target_url);
            }
            Err(e) => {
                navigate(&handle, error_url(&format!("host 启动失败: {e}")));
            }
        }
    });

    app.run(|_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(pid) = OWNED_PID.lock().unwrap().take() {
                host::stop_owned(pid);
            }
        }
    });
}
