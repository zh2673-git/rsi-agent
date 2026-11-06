"use strict";
// ── Q 轮：per-session 运行态 / 显式队列 / 会话视图缓存 ──────────────────────
// 旧实现把「忙」压在页面级 DOM（sendBtn.disabled）与单变量 chatAbort 上：A 会话
// 运行中切到 B，按钮仍禁用、abort 句柄串台，观感就是「新对话开不了任务」。
// 这里把运行态提升为 per-session 表；send/停止/插队全部按 sid 对位。队列只活在
// 当前标签页内存（服务端持久队列见 Phase 3），刷新/多标签页不共享，语义显式。
// 本文件先于 app-core/app-events 载入：只声明函数，所有跨文件全局在调用时才解析。
const runState = new Map();
function qState(sid) {
  let s = runState.get(sid);
  if (!s) { s = { running: false, abort: null, queue: [], draining: false }; runState.set(sid, s); }
  return s;
}

// DOM 快照缓存：离开会话时摘下 feed 的活节点 + 精确 cursor + 滚动位置 + 纯数据状态；
// 切回时把节点原样挂回瞬时显示，再用 EventSource(after=cursor) 只补增量。
const sessionCache = new Map();
const CACHE_MAX = 8;
let queueOpen = true;
let preciseCursor = false;
function dropSessionCache(sid) { sessionCache.delete(sid); }
function snapshotSessionFeed(sid) {
  if (typeof feed === "undefined" || !feed) return;
  sessionCache.delete(sid);
  // Q 轮修正：缓存的是「活的 DOM 节点」而不是 innerHTML 字符串。字符串快照经
  // 序列化再解析后，节点上挂的 expando（_fcpath/_fcargs/chip._items）与闭包
  // （chip.onclick / 工具卡事件）全部丢失 —— 缓存会话里「文件变更」chip 点不开、
  // 变更抽屉定位不到工具卡、⇄ diff 取不到 args。搬移节点引用即可原样保留。
  const nodes = [...feed.childNodes];
  sessionCache.set(sid, {
    nodes,
    cursor: lastAfter,
    scrollTop: ($("stream") || {}).scrollTop ?? 0,
    userTurns: userTurns.map((u) => ({ ...u, atts: (u.atts || []).slice() })),
    doneSids: [...doneSids],
    tail: turnTail ?? null,
    fcBox: turnFcBox ?? null,
    srcBox: turnSourceBox ?? null,
    artifacts: turnArtifacts.slice(),
    streamState: typeof snapshotStreamState === "function" ? snapshotStreamState() : null,
    fcSeen: typeof snapshotFileChanges === "function" ? snapshotFileChanges() : null,
  });
  while (sessionCache.size > CACHE_MAX) sessionCache.delete(sessionCache.keys().next().value);
}
function restoreSessionFeed(sid) {
  const c = sessionCache.get(sid);
  if (!c) return null;
  resetSessionFeed();                    // 集中重置（P7），随后覆盖纯数据状态
  feed.replaceChildren(...c.nodes);       // 搬移活节点：expando / 事件闭包原样保留
  lastAfter = c.cursor || 0;
  preciseCursor = lastAfter > 0;
  userTurns = c.userTurns || [];
  doneSids.clear();
  if (c.streamState && typeof restoreStreamState === "function") restoreStreamState(c.streamState);
  for (const s of c.doneSids || []) doneSids.add(s);
  if (c.fcSeen && typeof restoreFileChanges === "function") restoreFileChanges(c.fcSeen);
  // 回合尾/聚合 chip 的模块级指针一并接回，否则后续事件会另起一份重复卡。
  turnTail = c.tail ?? null;
  turnFcBox = c.fcBox ?? null;
  turnSourceBox = c.srcBox ?? null;
  turnArtifacts = c.artifacts || [];
  const box = $("stream"); if (box) box.scrollTop = c.scrollTop || 0;
  return c;
}

function syncRunUI() {
  const s = qState(session);
  sendBtn.disabled = s.running;
  stopBtn.hidden = !s.running;
  renderQueue();
}
function renderQueue() {
  const box = $("queue-box"), list = $("queue-list"), cnt = $("queue-count");
  if (!box || !list) return;
  const q = qState(session).queue;
  box.hidden = !queueOpen || q.length === 0;
  if (cnt) cnt.textContent = "待发 " + q.length + " 条";
  list.innerHTML = "";
  q.forEach((item, i) => {
    const row = el(`<div class="qitem"><span class="qtext"></span><button class="qexec" title="立即执行这条（插到队首并停当前）">⏭</button><button title="上移">↑</button><button title="删除">×</button></div>`);
    row.querySelector(".qtext").textContent = item.text;
    const [exec, up, rm] = row.querySelectorAll("button");
    exec.onclick = () => { runQueueNow(i); };
    up.onclick = () => { if (i > 0) { [q[i - 1], q[i]] = [q[i], q[i - 1]]; renderQueue(); } };
    rm.onclick = () => { q.splice(i, 1); renderQueue(); };
    list.appendChild(row);
  });
}
async function postChat(sid, item) {
  const s = qState(sid);
  // Q 轮 Phase 3：优先走服务端显式队列（跨标签页共享「待发」视图）。
  // 服务端 queue/enqueue 返回 accepted；本 fetch 立即结束，不阻塞等 chat 收敛。
  // 队列 full / 端点不存在（旧 host）→ 回退本地 postChatDirect。
  try {
    const r = await fetch("/api/queue", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: sid, message: item.text, target: "followup", ...(item.atts && item.atts.length ? { attachments: item.atts } : {}) }),
    });
    const v = await r.json();
    if (v && v.ok) return true;
  } catch { /* 旧版 host：走本地直发兜底 */ }
  return postChatDirect(sid, item);
}
async function postChatDirect(sid, item) {
  const s = qState(sid);
  // 显式队列内部消化 K409：cancel/abort 后服务端仍要跑到轮次边界才释放同会话闸，
  // 直接发下一条会撞 409。K409 在 memory.append 之前返回，重试不会重复落 user 事件。
  for (let attempt = 0; attempt < 24; attempt++) {
    s.abort = new AbortController();
    try {
      const r = await fetch("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" }, signal: s.abort.signal,
        body: JSON.stringify({ session_id: sid, message: item.text, ...(item.atts && item.atts.length ? { attachments: item.atts } : {}) }),
      });
      const v = await r.json();
      if (v && v.error && v.error.code === "K409" && attempt < 23) {
        await new Promise((done) => setTimeout(done, 250));
        continue;
      }
      if (session === sid) setStatus(v.ok ? "" : "失败: " + (v.error?.message ?? r.status));
      return;
    } catch (e) {
      if (e?.name === "AbortError") { if (session === sid) setStatus("已停止（后台正在收敛）"); return; }
      if (session === sid) setStatus("请求失败: " + e);
      return;
    } finally { s.abort = null; }
  }
}
async function drain(sid) {
  const s = qState(sid);
  if (s.draining) return;
  s.draining = true; s.running = true; syncRunUI();
  try {
    while (s.queue.length) {
      const item = s.queue[0];
      await postChat(sid, item);   // 每条各入队一次（服务端按序执行），或旧 host 直发兜底
      const at = s.queue.indexOf(item);   // 发送期间可能被删除/上移：按身份删除，不盲目 shift
      if (at >= 0) s.queue.splice(at, 1);
      renderQueue();
    }
  } finally {
    s.draining = false; s.running = false; s.abort = null;
    if (session === sid) { syncRunUI(); setStatus(""); input.focus(); }
  }
}
async function interruptAndSend() {
  const text = input.value.trim();
  if (!text) return;
  const atts = pendingAtts.splice(0);
  input.value = ""; input.style.height = "48px"; renderAtts();
  // Q 轮 Phase 3：steer = 轮次边界软注入（不杀当前任务）。服务端 queue/enqueue
  // 在有在途 chat 时把文本放进 steer 缓冲；chat_run 下一轮开头注入工作集。
  try {
    const r = await fetch("/api/queue", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: session, message: text, target: "steer", ...(atts.length ? { attachments: atts } : {}) }),
    });
    const v = await r.json();
    if (v && v.ok) { setStatus(v.position === 0 ? "已加入轮次边界注入" : "已排队"); return; }
  } catch { /* 旧版 host：回退「取消+重启」近似 */ }
  const s = qState(session);
  s.queue.unshift({ text, atts });            // 队首：drain 在当前 fetch finally 之后才取它
  queueOpen = true; renderQueue();
  try {
    await fetch(`/api/chat/cancel?session=${encodeURIComponent(session)}`, { method: "POST" });
  } catch { /* 取消失败仍由 drain 的 K409 重试兜底 */ }
  s.abort?.abort();                           // 只断客户端 fetch；服务端到轮次边界收敛 K499
  if (!s.draining) drain(session);
}
async function runQueueNow(i) {
  const s = qState(session);
  const item = s.queue[i];
  if (!item) return;
  s.queue.splice(i, 1);
  s.queue.unshift(item);            // 提到队首：drain 本轮收尾后立即取它
  queueOpen = true; renderQueue();
  if (!s.draining) { drain(session); return; }
  // 有在途任务：取消服务端回合 + 断客户端 fetch，让 drain 尽快走到队首。
  try {
    await fetch(`/api/chat/cancel?session=${encodeURIComponent(session)}`, { method: "POST" });
  } catch { /* 取消失败由 drain 的 K409 重试兜底 */ }
  s.abort?.abort();
}
function returnQueueToInput() {
  const s = qState(session);
  // 正在发送的第 0 项留给 drain 收尾（finally 后 shift），只把「待发」项退回输入框。
  const pending = s.draining ? s.queue.slice(1) : s.queue.slice();
  s.queue.length = s.draining ? 1 : 0;
  if (pending.length) {
    input.value = pending.map((p) => p.text).join("\n");
    const atts = pending.find((p) => p.atts && p.atts.length);
    if (atts) pendingAtts = atts.atts.slice();
  }
  renderAtts(); renderQueue();
}
function bindQueueUI() {
  const toggle = $("queue-toggle");
  if (toggle) toggle.onclick = () => {
    queueOpen = !queueOpen;
    toggle.textContent = queueOpen ? "隐藏" : "展开";
    renderQueue();
  };
  const interrupt = $("interrupt");
  if (interrupt) interrupt.onclick = () => { interruptAndSend(); };
}
