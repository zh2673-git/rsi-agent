"use strict";
const $ = (id) => document.getElementById(id);
const feed = $("feed"), input = $("input"), sendBtn = $("send"), stopBtn = $("stop"), statusEl = $("status"), connEl = $("conn");

// ── 单一会话（单会话形态）──
// 用户面对 agent 永远只有一个会话框：不再有会话列表、新建对话、重命名/删除。
// 历史靠「一份连续 trace + SSE 游标续传」自然累积，项目分类由 agent 自己在工作区完成
// （左侧看板才是分类视图，见 app-board.js）。旧的多会话 key 一次性清理，避免残留数据
// 在新形态下变成幽灵状态。
const WS_KEY = String(window.RA_WS ?? "");
const CKEY = "ra.session#" + WS_KEY;
const SESSION_ID = "main";
// 兼容层：旧代码（app-events/q-session）仍以 session 变量为当前会话标识。
let session = SESSION_ID;
localStorage.setItem(CKEY, session);
(function dropLegacySessionLists() {
  try {
    localStorage.removeItem("ra.sessions#" + WS_KEY);
    localStorage.removeItem("ra.sessions");
    localStorage.removeItem("ra.session");
  } catch { /* 隐私模式：忽略 */ }
})();
// 旧调用点（touchSession/autoName/renderSessions 等）保留为空操作或最简实现：
// 删掉它们要同步改 app-events.js 的发送路径，收益只是少几行——先保接口稳定，
// 语义上「单会话 = 无标题需维护、无列表需重绘」。
function touchSession() {}
function autoName() {}
function renderSessions() {}
function refreshSessionTag() {
  const tag = $("ws-tag");
  if (tag) tag.title = "当前工作区（文件工具/文件树/产物的根）";
}
function switchSession() {}
refreshSessionTag();
$("toggle").onclick = () => $("sidebar").classList.toggle("collapsed");
function esc(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }

// ── markdown 渲染（先转义，再还原受控标签；代码块带语言标签+复制）──
function md(src) {
  let text = esc(src);
  const blocks = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, body) => {
    const i = blocks.length;
    blocks.push({ lang: lang || "text", body: body.replace(/\n$/, "") });
    return `\u0000B${i}\u0000`;
  });
  // 表格：| a | b | 行 + |---|---| 分隔行 + 数据行。在行级规则前整块替换，
  // 单元格内容仍走后续 inline 规则（bold/code/link），语义不丢。
  text = text.replace(/(?:^\|.*\|$\n?)+/gm, (block) => {
    const rows = block.trim().split("\n").map((l) => l.trim());
    if (rows.length < 2 || !/^\|?[\s:|-]+\|?$/.test(rows[1]) || !rows[1].includes("-")) return block;
    const cells = (l) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const th = cells(rows[0]).map((c) => `<th>${c}</th>`).join("");
    const trs = rows.slice(2).map((l) => "<tr>" + cells(l).map((c) => `<td>${c}</td>`).join("") + "</tr>").join("");
    return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>\n`;
  });
  text = text
    .replace(/^###### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^##### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^#### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^&gt; ?(.*)$/gm, "<blockquote>$1</blockquote>");
  const lines = text.split("\n");
  let html = "", list = null, para = [];
  const flushPara = () => { if (para.length) { html += `<p>${para.join("<br>")}</p>`; para = []; } };
  const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const ln of lines) {
    const t = ln.trim();
    let m;
    if (!t) { flushPara(); flushList(); continue; }
    if (/^\u0000B\d+\u0000$/.test(t)) { flushPara(); flushList(); html += t; continue; }
    if ((m = t.match(/^[-*] (.*)$/))) { flushPara(); if (list !== "ul") { flushList(); html += "<ul>"; list = "ul"; } html += `<li>${m[1]}</li>`; continue; }
    if ((m = t.match(/^\d+[.)] (.*)$/))) { flushPara(); if (list !== "ol") { flushList(); html += "<ol>"; list = "ol"; } html += `<li>${m[1]}</li>`; continue; }
    if (/^<(h\d|blockquote|ul|ol|table)/.test(t)) { flushPara(); flushList(); html += t; continue; }
    flushList(); para.push(t);
  }
  flushPara(); flushList();
  return html.replace(/\u0000B(\d+)\u0000/g, (_, i) => {
    const b = blocks[+i];
    return `<pre class="code"><div class="cb-head"><span class="cb-lang">${esc(b.lang)}</span><button class="cb-copy">复制</button></div><pre>${esc(b.body)}</pre></pre>`;
  });
}

// 代码块复制（事件委托）
feed.addEventListener("click", (e) => {
  const btn = e.target.closest(".cb-copy");
  if (btn) {
    const pre = btn.closest("pre.code")?.querySelector("pre");
    if (pre) navigator.clipboard.writeText(pre.textContent).then(() => { const o = btn.textContent; btn.textContent = "已复制"; setTimeout(() => (btn.textContent = o), 1200); });
  }
});

function el(html) { const d = document.createElement("div"); d.innerHTML = html; return d.firstElementChild; }
function scroll() { const s = $("stream"); s.scrollTop = s.scrollHeight; }
// 页面级跟随（R12）：事件流增长时 #stream 贴底滚动；用户上滚即暂停，距底 <64px 视为
// 回到底部自动恢复。scrollFeed 供事件驱动路径调用（过程框内滑动、产物/来源卡追加、
// 正文流式），与 scroll()（强制置底，用于发送消息等用户主动动作）区分。
let feedPinned = true;
$("stream").addEventListener("scroll", () => {
  const s = $("stream");
  feedPinned = s.scrollHeight - s.scrollTop - s.clientHeight < 64;
}, { passive: true });
function scrollFeed() { if (feedPinned) scroll(); }
function setStatus(t) { statusEl.textContent = t || ""; }

