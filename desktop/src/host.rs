//! host 生命周期：探测 ready / 拉起 run.cmd / 只回收自己启动的实例。
//! 安全边界（与 run.cmd、scripts/magpie_pid.py 同口径）：
//!   - 已有服务 → 复用，不拉起、不杀；
//!   - 仅当本壳经 run.cmd 拉起 host 时保存该 cmd 进程树 PID；
//!   - 回收前校验进程名只能是 cmd.exe，防止 PID 复用误杀外部实例。

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::time::{Duration, Instant};

#[cfg(windows)]
const NO_WINDOW: u32 = 0x08000000; // CREATE_NO_WINDOW：避免 spawn 控制台子进程时闪黑框

const DEFAULT_ADDR: &str = "127.0.0.1:8710";

pub fn addr() -> String {
    std::env::var("RSI_DESKTOP_ADDR").unwrap_or_else(|_| DEFAULT_ADDR.into())
}

fn repo_root() -> PathBuf {
    // 上溯到含 run.cmd 的安装/仓库根（最多 6 层）。
    // 必须先看 exe 所在目录：快捷方式启动时 cwd 是 %USERPROFILE% 或 System32，
    // 不是安装目录；只看 cwd 会找不到 run.cmd 导致壳起不来。
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            starts.push(dir.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    for mut dir in starts {
        for _ in 0..6 {
            if dir.join("run.cmd").is_file() {
                return dir;
            }
            if !dir.pop() {
                break;
            }
        }
    }
    PathBuf::from(".")
}

fn port_open(addr: &str) -> bool {
    TcpStream::connect(addr).is_ok()
}

/// 等待 host 端口就绪；返回 None 表示超时。
pub fn wait_ready(addr: &str, secs: u64) -> bool {
    let limit = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < limit {
        if port_open(addr) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    port_open(addr)
}

/// 确保服务可用。返回 Some((Child, pid)) 表示本壳拥有该进程树；None 表示复用外部实例。
pub fn ensure_ready() -> Result<Option<(Child, u32)>, String> {
    let addr = addr();
    if port_open(&addr) {
        eprintln!("[rsi-desktop] 复用已运行的 host ({addr})，不拉起、不回收。");
        return Ok(None);
    }
    let root = repo_root();
    let run_cmd = root.join("run.cmd");
    if !run_cmd.is_file() {
        return Err(format!("找不到 run.cmd: {}", run_cmd.display()));
    }
    eprintln!("[rsi-desktop] 通过 run.cmd 拉起 host（隐藏窗口，不弹浏览器）...");
    // run.cmd 末尾前台运行 host，这个 cmd 进程树就是我们拥有的全部。
    // RSI_NO_BROWSER=1 让 run.cmd 跳过自动开浏览器；CREATE_NO_WINDOW 隐藏控制台。
    #[cfg(windows)]
    let child = Command::new("cmd")
        .args(["/C"])
        .arg(&run_cmd)
        .env("RSI_NO_BROWSER", "1")
        .env("WEB_ADDR", &addr)
        .creation_flags(0x08000000)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    #[cfg(not(windows))]
    let child = Command::new(&run_cmd)
        .env("RSI_NO_BROWSER", "1")
        .env("WEB_ADDR", &addr)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    let child = child.map_err(|e| format!("spawn run.cmd 失败: {e}"))?;
    let pid = child.id();
    eprintln!("[rsi-desktop] 已拉起 run.cmd（自有进程树 pid={pid}），等待 host 就绪...");
    Ok(Some((child, pid)))
}

/// 退出时彻底释放本壳拉起的 host：
/// 1) 按端口找到真正的监听进程（react-agent-host.exe）并结束，避免 cmd /T 在
///    子进程脱离父子链后失效、留下孤儿 host 占着端口；
/// 2) 再回收 run.cmd 外壳（校验进程名后杀）。
/// 只在 OWNED_PID=Some（本壳自己拉起）时调用；复用外部实例绝不触碰。
pub fn stop_owned_tree(pid: u32, addr: &str) {
    stop_listener_on_port(addr);
    stop_owned(pid);
}

/// 结束监听 addr 的 react-agent-host.exe（带进程名校验，防 PID 复用误杀）。
fn stop_listener_on_port(addr: &str) {
    #[cfg(windows)]
    {
        // 从 netstat 取监听该端口的 PID；再校验进程名必须是 host exe。
        let ps = format!(
            "$p=(Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue).OwningProcess; if($p){{ $n=(Get-CimInstance Win32_Process -Filter \"ProcessId=$p\").Name; if($n -eq 'react-agent-host.exe'){{ Write-Output $p }} }}",
            port = addr.rsplit(':').next().unwrap_or("")
        );
        let out = Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps])
            .creation_flags(NO_WINDOW)
            .output();
        if let Ok(o) = out {
            let pid = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !pid.is_empty() && pid.chars().all(|c| c.is_ascii_digit()) {
                eprintln!("[rsi-desktop] 退出：结束本壳拉起的 host (pid={pid}) 释放端口 {addr}");
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid, "/T", "/F"])
                    .creation_flags(NO_WINDOW)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
    }
    #[cfg(not(windows))]
    let _ = addr;
}

/// 校验进程名后回收，防 PID 复用误杀。只接受 cmd.exe（run.cmd 的外壳）。
pub fn stop_owned(pid: u32) {
    #[cfg(windows)]
    {
        let name = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}' -ErrorAction SilentlyContinue).Name"
                ),
            ])
            .creation_flags(NO_WINDOW)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_ascii_lowercase())
            .unwrap_or_default();
        if name != "cmd.exe" {
            eprintln!("[rsi-desktop] 拒绝回收 PID {pid}：进程名不匹配 ({name})，防止误杀。");
            return;
        }
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    let _ = pid;
}
