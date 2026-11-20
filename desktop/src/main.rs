//! rsi-agent 桌面薄壳：先开窗口显示启动态，再后台拉起 host，就绪后导航到 Web UI。
//! 不引入第二套 UI、不改 host 业务代码；编排逻辑复用根目录 run.cmd。
mod host;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, RunEvent, WindowEvent};

// 本壳拥有的 run.cmd 进程 pid（Some = 自己拉起并负责回收；None = 复用外部实例）。
static OWNED_PID: Mutex<Option<u32>> = Mutex::new(None);

// 启动编排只跑一次：Tauri v2 必须在事件循环启动（RunEvent::Ready）后 navigate，
// 否则 WebView2 尚未就绪，导航被丢弃——窗口停在 about:blank 白屏。
static BOOTED: AtomicBool = AtomicBool::new(false);

// 退出时统一清理：只回收本壳拉起的 host（按端口 + 进程名校验），复用实例不碰。
// 点 X 与 Exit 事件都会调用，Mutex::take 保证只执行一次。
fn cleanup_owned() {
    let owned = OWNED_PID.lock().unwrap().take();
    if let Some(pid) = owned {
        host::stop_owned_tree(pid, &host::addr());
    }
}

// 赛博风启动/错误页：纯本地 data URL，无 host 也能秒开。
// 全部样式内联、零外部依赖；percent_encode 会把 # 等编码，避免被当作 URL fragment。
const CYBER_CSS: &str = r#"
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:#05070d;color:#cfe9ff;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;
 display:flex;align-items:center;justify-content:center;overflow:hidden}
.grid{position:absolute;left:-50%;right:-50%;bottom:-30%;height:80%;
 background-image:linear-gradient(rgba(0,240,255,.18) 1px,transparent 1px),linear-gradient(90deg,rgba(0,240,255,.15) 1px,transparent 1px);
 background-size:44px 44px;transform:perspective(420px) rotateX(68deg);
 -webkit-mask-image:linear-gradient(transparent,#000 55%);mask-image:linear-gradient(transparent,#000 55%);
 animation:flow 2.4s linear infinite}
@keyframes flow{to{background-position:0 44px,0 0}}
.scan{position:absolute;left:0;right:0;height:2px;top:0;
 background:linear-gradient(90deg,transparent,#00f0ff,transparent);opacity:.55;
 box-shadow:0 0 18px 3px rgba(0,240,255,.5);animation:scan 3.2s linear infinite}
@keyframes scan{0%{top:-2%}100%{top:102%}}
.panel{position:relative;padding:46px 62px;text-align:center;min-width:440px;
 background:linear-gradient(160deg,rgba(10,20,34,.92),rgba(6,10,20,.92));
 border:1px solid rgba(0,240,255,.35);
 box-shadow:0 0 0 1px rgba(0,240,255,.08) inset,0 0 48px rgba(0,240,255,.12),0 0 90px rgba(255,46,151,.08);
 clip-path:polygon(0 16px,16px 0,calc(100% - 16px) 0,100% 16px,100% calc(100% - 16px),calc(100% - 16px) 100%,16px 100%,0 calc(100% - 16px))}
.panel::before,.panel::after{content:"";position:absolute;width:26px;height:26px;border:2px solid #ff2e97;opacity:.85}
.panel::before{top:10px;left:10px;border-right:0;border-bottom:0}
.panel::after{bottom:10px;right:10px;border-left:0;border-top:0}
.tag{font-size:11px;letter-spacing:4px;color:#ff2e97;text-transform:uppercase;margin-bottom:14px}
h2{margin:0;font-size:30px;letter-spacing:6px;color:#eafcff;text-shadow:0 0 12px rgba(0,240,255,.85),0 0 28px rgba(0,240,255,.4)}
.sub{margin-top:8px;font-size:11px;letter-spacing:2px;color:rgba(0,240,255,.55)}
.msg{margin-top:26px;font-size:14px;letter-spacing:1px;color:#9fd8e8;min-height:20px}
.msg::after{content:"_";animation:blink 1s steps(1) infinite;color:#00f0ff}
@keyframes blink{50%{opacity:0}}
.bar{margin:24px auto 0;width:280px;height:6px;background:rgba(0,240,255,.12);border:1px solid rgba(0,240,255,.3);overflow:hidden}
.bar i{display:block;height:100%;width:35%;background:linear-gradient(90deg,#00f0ff,#ff2e97);box-shadow:0 0 14px #00f0ff;animation:load 1.4s ease-in-out infinite}
@keyframes load{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}
.dots{margin-top:14px;font-size:11px;letter-spacing:3px;color:rgba(0,240,255,.7)}
.err{color:#ff5c7a;text-shadow:0 0 12px rgba(255,92,122,.7)}
"#;

fn splash_url() -> tauri::Url {
    let html = format!(
        "<!doctype html><meta charset=utf-8><style>{CYBER_CSS}</style>\
         <div class=grid></div><div class=scan></div>\
         <div class=panel><div class=tag>system // bootstrap</div>\
         <h2>RSI-AGENT</h2><div class=sub>LOCAL LINK INITIALIZING</div>\
         <div class=msg>正在建立本地链路</div>\
         <div class=bar><i></i></div>\
         <div class=dots>NODE :: 8710 &nbsp;|&nbsp; SECURE CHANNEL</div></div>"
    );
    let pct = percent_encode(&html);
    tauri::Url::parse(&format!("data:text/html,{pct}")).expect("启动页 URL 非法")
}

fn error_url(msg: &str) -> tauri::Url {
    let safe = msg.replace('<', "&lt;").replace('>', "&gt;");
    let body = format!(
        "<!doctype html><meta charset=utf-8><style>{CYBER_CSS}</style>\
         <div class=grid></div>\
         <div class=panel><div class=tag>system // fault</div>\
         <h2 class=err>LINK FAILED</h2><div class=sub>STARTUP ERROR</div>\
         <div class=msg err>{safe}</div>\
         <div class=dots>请检查 run.cmd 或使用终端手动启动</div></div>"
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

// 冷启动后让消息流**持续**贴底：长会话的 SSE 重放要数秒且分批到达，固定延时/时长的
// 轮询都会在停止后再次漂移；重放过程中的程序性滚动还会产生瞬时大 gap，旧逻辑把它误判
// 为用户上滚，pinned 永久变 false，之后不再贴底（用户反馈「滚动条不是默认在最下方」）。
// 通过 on_page_load 在 Web UI 加载完成后注入常驻脚本：每 120ms 把 #stream 置底；只有
// **用户主动**滚轮/触摸/按键上滚才暂停贴底，且暂停 8s 无操作自动恢复，保证加载完仍贴底。
// 不用 MutationObserver——重放上万次 append 逐次读 scrollHeight 触发强制重排，实测约 6.3s。
// 脚本幂等（window.__rsiSticky 单例标志），不碰 runtime 源码。
const STICKY_JS: &str = r#"(function(){
if(window.__rsiSticky)return;
var s=document.getElementById('stream');if(!s)return;
window.__rsiSticky=1;
var userScrollUntil=0;
function pause(){userScrollUntil=Date.now()+8000;}   // 用户主动上滚 → 暂停贴底 8s
// 只有用户真实输入才暂停；replay / 程序性置底 / 滚动锚定产生的 scroll 一律忽略。
s.addEventListener('wheel',function(e){if(e.deltaY<0)pause();},{passive:true});
s.addEventListener('touchstart',pause,{passive:true});
s.addEventListener('keydown',function(e){if(e.key==='PageUp'||e.key==='ArrowUp'||e.key==='Home')pause();},{passive:true});
// 用户滚回底部时立即恢复（gap<64 只可能来自真实回底，程序置底本就 gap=0）。
s.addEventListener('scroll',function(){
  if(s.scrollHeight-s.scrollTop-s.clientHeight<64)userScrollUntil=0;
},{passive:true});
function pin(){
  if(Date.now()<userScrollUntil)return;              // 用户阅读历史期内不打扰
  var gap=s.scrollHeight-s.scrollTop-s.clientHeight;
  if(gap>0)s.scrollTop=s.scrollHeight;
}
pin();
setInterval(pin,120);
})();"#;

// 桌面壳补预览：runtime 前端对 md 走页面内 overlay，但对 png/jpg/html/pdf/svg 等
// native 文件走 window.open("/files/...", "_blank")；Tauri 未注册 on_new_window 时
// WebView2 直接拒绝，故点图片/网页类产物没反应。这里在 Web UI 加载后覆盖 window.open，
// 把同源 /files/... 的打开请求改为页面内 overlay 渲染（图片/PDF/HTML 用 <img>/<iframe>），
// 复用 style.css 已有的 .fp-overlay 样式；外部链接保持新窗口原语义。不碰 runtime 源码。
const PREVIEW_JS: &str = r#"(function(){
if(window.__rsiPreviewPatch)return;
window.__rsiPreviewPatch=1;
function overlay(url,name){
  var mask=document.getElementById('rsi-native-preview');
  if(!mask){
    mask=document.createElement('div');mask.id='rsi-native-preview';mask.className='fp-overlay';
    mask.innerHTML='<div class="fp-box"><div class="fp-head"><span class="fp-name"></span><button class="btn ghost fp-close">关闭</button></div><div class="fp-body" style="height:100%;overflow:auto"></div></div>';
    document.body.appendChild(mask);
    var close=function(){var b=mask.querySelector('.fp-body');b.innerHTML='';mask.style.display='none';};
    mask.addEventListener('click',function(e){if(e.target===mask)close();});
    mask.querySelector('.fp-close').addEventListener('click',close);
  }
  mask.querySelector('.fp-name').textContent=name||url;
  var body=mask.querySelector('.fp-body');body.innerHTML='';
  var low=url.toLowerCase();
  var node;
  if(/\.svg(\?|$)/.test(low)||/\.png(\?|$)/.test(low)||/\.jpe?g(\?|$)/.test(low)||/\.gif(\?|$)/.test(low)||/\.webp(\?|$)/.test(low)){
    node=document.createElement('img');node.src=url;node.style.cssText='max-width:100%;max-height:100%;display:block;margin:auto;';
  }else{
    node=document.createElement('iframe');node.src=url;node.style.cssText='width:100%;height:100%;border:0;background:#fff;';
  }
  body.appendChild(node);mask.style.display='flex';
}
var orig=window.open;
window.open=function(u,target,feat){
  try{
    if(typeof u==='string'&&/^\/files\//.test(u)){
      var q=u.indexOf('?');var clean=q>=0?u.slice(0,q):u;
      if(!/\?download=1/.test(u)){overlay(u,decodeURIComponent(clean.split('/').pop()||u));return null;}
    }
  }catch(e){}
  return orig.apply(window,arguments);
};
})();"#;

fn main() {
    // 立即建窗口显示启动页；host 准备放后台线程，避免「先阻塞再开窗」。
    let app = tauri::Builder::default()
        // Q4：在 Web UI 页面加载完成后注入贴底脚本（此回调在 Tauri 事件循环上执行，
        // eval 才可靠命中已挂载的 DOM；后台线程定时 eval 实测静默失败）。data: 启动页
        // 无 #stream，直接跳过；只有 http(s) 的 Web UI 需要贴底。
        .on_page_load(|webview, payload| {
            use tauri::webview::PageLoadEvent;
            if payload.event() == PageLoadEvent::Finished
                && matches!(payload.url().scheme(), "http" | "https")
            {
                if let Err(e) = webview.eval(STICKY_JS) {
                    eprintln!("[rsi-desktop] 贴底脚本注入失败: {e}");
                }
                if let Err(e) = webview.eval(PREVIEW_JS) {
                    eprintln!("[rsi-desktop] 预览补丁注入失败: {e}");
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败（检查 desktop/tauri.conf.json）");

    let handle = app.handle().clone();

    // 系统托盘：点 X 只是隐藏到托盘，右键托盘图标 → 完全退出。
    let tray_menu = MenuBuilder::new(&handle)
        .text("quit", "完全退出")
        .build()
        .expect("创建托盘菜单失败");
    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().expect("缺少窗口图标"))
        .tooltip("rsi-agent")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id() == "quit" {
                cleanup_owned();
                app.exit(0);
            }
        })
        .on_tray_icon_event(|_tray, event| {
            // 左键单击托盘图标：显示并聚焦窗口。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(win) = _tray.app_handle().get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        })
        .build(&handle)
        .expect("创建系统托盘失败");

    app.run(|handle, event| {
        match event {
            // 启动编排：Tauri v2 的 WebView2 在事件循环启动后才就绪；在此之前的 navigate
            // 会被静默丢弃，窗口永远停在 about:blank（白屏）。因此必须在 Ready 里导航。
            // 用 BOOTED 保证只跑一次（Ready 可能随事件循环恢复再次触发）。
            RunEvent::Ready => {
                if BOOTED.swap(true, Ordering::SeqCst) {
                    return;
                }
                // 先显示赛博启动页（此时 WebView 已就绪，navigate 生效）。
                let splash_at = std::time::Instant::now();
                navigate(handle, splash_url());

                let h = handle.clone();
                std::thread::spawn(move || {
                    let addr = host::addr();
                    let target_url = match tauri::Url::parse(&format!("http://{addr}/")) {
                        Ok(u) => u,
                        Err(e) => {
                            navigate(&h, error_url(&format!("地址非法: {e}")));
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
                                    navigate(&h, error_url("host 在 180s 内未就绪，请手动运行 run.cmd"));
                                    return;
                                }
                            }
                            // 启动页至少停留 2s：host 已存活时 ensure_ready 立即返回，
                            // 之前会瞬间跳过 splash 直接进 Web UI（用户反馈「直接进界面」）。
                            if let Some(rest) = std::time::Duration::from_secs(2)
                                .checked_sub(splash_at.elapsed())
                            {
                                std::thread::sleep(rest);
                            }
                            // 导航到 Web UI。后台线程的 navigate 由 Tauri dispatch 到主事件循环，
                            // 此时循环已在运行，能正确提交（修复白屏的关键）。
                            navigate(&h, target_url);
                        }
                        Err(e) => {
                            navigate(&h, error_url(&format!("host 启动失败: {e}")));
                        }
                    }
                });
            }
            // 点 X：隐藏到系统托盘，不清理 host（窗口可再次从托盘打开）。
            // 真正的完全退出走托盘右键菜单，那里才 cleanup_owned + exit。
            RunEvent::WindowEvent {
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } => {
                api.prevent_close();
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.hide();
                }
            }
            // 兜底清理：任何其它退出路径（系统关机、托盘菜单 exit 之后）都确保释放自有 host。
            // OWNED_PID.take() 幂等；复用外部实例时 OWNED_PID=None，完全 no-op。
            RunEvent::Exit => cleanup_owned(),
            _ => {}
        }
    });
}
