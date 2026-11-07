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
  const st = qState(session), q = st.queue;
  box.hidden = !queueOpen || q.length === 0;
  if (cnt) cnt.textContent = "待发 " + q.length + " 条";
  list.innerHTML = "";
  q.forEach((item, i) => {
    // Q5：第 0 条即「正在执行」的那条（drain 驻留到它跑完）；其余才是真待发。
    const running = st.draining && i === 0;
    const row = el(`<div class="qitem"><span class="qtext"></span><button class="qexec">⏭</button><button class="qup">↑</button><button class="qrm">×</button></div>`);
    if (running) {
      row.classList.add("running");
      const tag = document.createElement("span");
      tag.className = "qrun"; tag.textContent = "执行中";
      row.insertBefore(tag, row.querySelector(".qexec"));
    }
    row.querySelector(".qtext").textContent = item.text;
    const [exec, up, rm] = row.querySelectorAll("button");
    exec.title = running ? "正在执行" : "立即执行这条（打断当前任务，优先跑它）";
    up.title = "上移（更早执行）"; rm.title = "从待发队列删除";
    exec.disabled = running; up.disabled = running || (st.draining && i === 1); rm.disabled = running;
    exec.onclick = () => { runQueueNow(i); };
    // 执行中那条（index 0）不可被上移顶掉；故 index 1 的上移在 draining 期间禁用。
    up.onclick = () => { if (i > 0 && !(st.draining && i === 1)) { [q[i - 1], q[i]] = [q[i], q[i - 1]]; renderQueue(); } };
    rm.onclick = () => { q.splice(i, 1); renderQueue(); };
    list.appendChild(row);
  });
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
      // Q5：队列本地驻留——第 0 条即「执行中」。postChatDirect 的 Promise 覆盖整段执行，
      // 跑完才出队；待发面板因此在整轮执行期间都可见，行内 ⏭/↑/× 才有操作窗口。
      await postChatDirect(sid, item);
      const at = s.queue.indexOf(item);   // 执行期间可能被删除/上移：按身份删除，不盲目 shift
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
  // Q5：队列驻留后 index 0 是「执行中」，新条插到它之后，否则会把执行中的行顶成待发。
  s.queue.splice(s.draining ? 1 : 0, 0, { text, atts });
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
  // Q5：队列驻留后第 0 条是「执行中」，目标是让它插到执行中那条之后（index 1），
  // 再打断当前任务——drain 的 await 一返回就出队第 0 条，随即轮到它。
  s.queue.splice(i, 1);
  const at = s.draining ? 1 : 0;
  s.queue.splice(at, 0, item);
  queueOpen = true; renderQueue();
  if (!s.draining) { drain(session); return; }
  // 有在途任务：取消服务端回合 + 断客户端 fetch，让 drain 尽快轮到它。
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
  // Q5：composer 不再有「插队」键（恢复为纯「停止」），Alt+Enter 仍走 interruptAndSend。
}
