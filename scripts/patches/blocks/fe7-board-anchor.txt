"use strict";
// ── 左侧看板：任务 + 灵感（单会话形态）──
// 设计要点（docs/self-evolution/01-单会话与任务看板.md §3.4）：
// 1. **约束布局**：分区顺序固定（任务 → 灵感 → 窗口），任务组序由状态机固定
//    （计划→进行→验收→完成→阻塞→取消），组内按 priority 再按 updated_at。不给拖拽
//    ——「有自己的排布规则」是看板能被信任的前提，自由排布只会让它退化成第二个乱列表。
// 2. **只读任务 + 可写灵感**：任务由 agent 建与推进（用户不管背后的项目分类），
//    用户在 UI 只能记灵感、归档灵感。这是权限的界面表达，不是功能缺失。
// 3. **轮询而非推送**：看板变化频率是「分钟级」，SSE 加一路事件流得不偿失；
//    页面可见时每 20s 拉一次 + 操作后立即拉，足够。
const BOARD_ORDER = ["planning", "doing", "verifying", "done", "blocked", "cancelled"];
const BOARD_LABEL = {
  planning: "计划", doing: "进行", verifying: "验收", done: "完成", blocked: "阻塞", cancelled: "取消",
};
const PRIO_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
const INSP_LABEL = { open: "待议", adopted: "已采纳", archived: "已归档" };

let boardData = null;       // 最近一次 GET /api/board 的 payload
let boardFilter = "all";    // all | open | done
let boardTimer = null;

function boardEsc(s) { return esc(String(s ?? "")); }

function boardReq(method, url, body) {
  return api(method, url, body);
}

// 任务分组：状态优先，其次优先级，再次更新时间倒序（新改动的在同组更靠上）。
function groupTasks(tasks) {
  const by = new Map(BOARD_ORDER.map((s) => [s, []]));
  for (const t of tasks) {
    const st = by.has(t.status) ? t.status : "planning";
    by.get(st).push(t);
  }
  for (const arr of by.values()) {
    arr.sort((a, b) => {
      const pa = PRIO_RANK[a.priority] ?? 9, pb = PRIO_RANK[b.priority] ?? 9;
      if (pa !== pb) return pa - pb;
      return String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""));
    });
  }
  return by;
}

function taskVisible(t) {
  if (boardFilter === "open") return t.status !== "done" && t.status !== "cancelled";
  if (boardFilter === "done") return t.status === "done" || t.status === "cancelled";
  return true;
}

function renderTasks() {
  const box = $("tasks"), cnt = $("task-count");
  if (!box) return;
  box.innerHTML = "";
  const tasks = (boardData?.board?.tasks ?? []).filter(taskVisible);
  const sum = boardData?.summary?.tasks;
  if (cnt) {
    const bs = sum?.by_status ?? {};
    const open = (bs.planning ?? 0) + (bs.doing ?? 0) + (bs.verifying ?? 0);
    cnt.textContent = `${open} 进行中 / ${sum?.total ?? 0}`;
  }
  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = boardFilter === "all" ? "暂无任务（agent 会把成规模的事登记到这里）" : "该筛选下没有任务";
    box.appendChild(empty);
    return;
  }
  const grouped = groupTasks(tasks);
  for (const st of BOARD_ORDER) {
    const arr = grouped.get(st);
    if (!arr.length) continue;
    const head = document.createElement("div");
    head.className = "tgroup";
    head.innerHTML = `<span class="tdot ${esc(st)}"></span><span>${BOARD_LABEL[st]}</span><span class="tcnt">${arr.length}</span>`;
    box.appendChild(head);
    for (const t of arr) box.appendChild(taskRow(t));
  }
}

function taskRow(t) {
  const el = document.createElement("div");
  el.className = `trow st-${esc(t.status)}`;
  const done = Number(t.progress?.done ?? 0), total = Number(t.progress?.total ?? 0);
  const ratio = total > 0 ? `${done}/${total}` : "";
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const prio = t.priority ?? "P2";
  const res = t.resourcing ?? {};
  const bits = [];
  if (res.effort) bits.push({ small: "轻", medium: "中", large: "重" }[res.effort] ?? res.effort);
  if (res.model && res.model !== "current") bits.push(res.model === "cheap" ? "省模型" : res.model === "strong" ? "强模型" : res.model);
  if ((res.skills ?? []).length) bits.push(`部门 ${res.skills.length}`);
  if ((res.tools ?? []).length) bits.push(`工具 ${res.tools.length}`);
  el.innerHTML =
    `<div class="tline"><span class="tprio p-${esc(prio)}">${esc(prio)}</span>` +
    `<span class="ttitle" title="${boardEsc(t.title)}">${boardEsc(t.title)}</span>` +
    (ratio ? `<span class="tratio">${ratio}</span>` : "") +
    `<button class="tref" title="在输入框引用这个任务（@T）">@</button></div>` +
    (total > 0 ? `<div class="tbar"><i style="width:${pct}%"></i></div>` : "") +
    (bits.length ? `<div class="tmeta">${bits.map((b) => `<span>${boardEsc(b)}</span>`).join("")}</div>` : "") +
    `<div class="tdetail" hidden></div>`;
  el.querySelector(".tref").onclick = (e) => { e.stopPropagation(); mentionRef(t.id); };
  el.querySelector(".tline").onclick = () => toggleTaskDetail(el, t);
  return el;
}

function toggleTaskDetail(row, t) {
  const box = row.querySelector(".tdetail");
  if (!box) return;
  if (!box.hidden) { box.hidden = true; return; }
  const plan = (t.plan ?? []).map((s) => `<li><span class="pdot ${esc(s.status)}"></span>${boardEsc(s.step)}</li>`).join("");
  const acc = (t.acceptance ?? []).map((a) => `<li>${boardEsc(a)}</li>`).join("");
  const res = t.resourcing ?? {};
  box.innerHTML =
    (t.goal ? `<div class="dsec"><b>目标</b><p>${boardEsc(t.goal)}</p></div>` : "") +
    (plan ? `<div class="dsec"><b>计划</b><ul class="dplan">${plan}</ul></div>` : "") +
    (acc ? `<div class="dsec"><b>验收</b><ul class="dacc">${acc}</ul></div>` : "") +
    `<div class="dsec"><b>人财物</b><p>模型 ${boardEsc(res.model ?? "current")} · 力度 ${boardEsc(res.effort ?? "medium")}` +
    (res.skills?.length ? ` · 技能 ${boardEsc(res.skills.join("、"))}` : "") +
    (res.tools?.length ? ` · 工具 ${boardEsc(res.tools.join("、"))}` : "") + `</p></div>` +
    (t.progress?.note ? `<div class="dsec"><b>进度备注</b><p>${boardEsc(t.progress.note)}</p></div>` : "") +
    ((t.artifacts ?? []).length
      ? `<div class="dsec"><b>产物</b><p>${t.artifacts.map((a) => `<a href="/files/${encodeURI(a)}" target="_blank" rel="noopener">${boardEsc(a.split("/").pop())}</a>`).join(" · ")}</p></div>`
      : "") +
    `<div class="dsec"><span class="did">${boardEsc(t.id)}</span></div>`;
  box.hidden = false;
}

function renderInsps() {
  const box = $("inspects"), cnt = $("insp-count");
  if (!box) return;
  box.innerHTML = "";
  const items = boardData?.board?.inspirations ?? [];
  if (cnt) cnt.textContent = `${items.filter((i) => i.status === "open").length} 待议 / ${items.length}`;
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "把零碎想法记在这里，需要时在对话里 @ 引入";
    box.appendChild(empty);
    return;
  }
  for (const it of items) {
    const el = document.createElement("div");
    el.className = `irow st-${esc(it.status)}`;
    const tags = (it.tags ?? []).map((t) => `<span class="itag">${boardEsc(t)}</span>`).join("");
    el.innerHTML =
      `<div class="iline"><span class="itext" title="${boardEsc(it.text)}">${boardEsc(it.text)}</span>` +
      `<button class="iref" title="在输入框引用（@I）">@</button>` +
      `<button class="iarc" title="${it.status === "archived" ? "恢复为待议" : "归档"}">${it.status === "archived" ? "↺" : "✓"}</button></div>` +
      (tags || it.status !== "open" ? `<div class="imeta">${tags}<span class="ist">${INSP_LABEL[it.status] ?? it.status}</span></div>` : "");
    el.querySelector(".iref").onclick = (e) => { e.stopPropagation(); mentionRef(it.id); };
    el.querySelector(".iarc").onclick = async (e) => {
      e.stopPropagation();
      const next = it.status === "archived" ? "open" : "archived";
      try { await boardReq("POST", "/api/board", { op: "inspiration.set", id: it.id, status: next }); refreshBoard(); }
      catch (err) { setStatus("归档失败: " + err.message); }
    };
    box.appendChild(el);
  }
}

// @引用：把 ID 以纯文本形式写进输入框（不引入隐藏元数据），agent 侧按 `@T-…` / `@I-…`
// 解析——这样引用在 trace 与回滚语义里就是普通文本，不新增任何事件类型。
function mentionRef(id) {
  const box = $("input");
  if (!box) return;
  const token = `@${id} `;
  const cur = box.value;
  const pos = box.selectionStart ?? cur.length;
  const needSpace = pos > 0 && !/\s$/.test(cur.slice(0, pos));
  box.value = cur.slice(0, pos) + (needSpace ? " " : "") + token + cur.slice(pos);
  box.dispatchEvent(new Event("input"));
  box.focus();
  const at = (box.value.length - cur.length) + pos + (needSpace ? 1 : 0) + token.length;
  box.setSelectionRange(at, at);
}

async function refreshBoard() {
  try {
    boardData = await boardReq("GET", "/api/board");
    renderTasks();
    renderInsps();
  } catch (e) {
    const box = $("tasks");
    if (box) box.innerHTML = `<div class="empty">看板读取失败: ${boardEsc(e.message)}</div>`;
  }
}

function boardTick() {
  // 页面不可见时不拉（后台标签页省 CPU）；切回可见立即补一次。
  if (document.visibilityState === "visible") refreshBoard();
}

$("insp-save").onclick = async () => {
  const input = $("insp-input");
  const text = input.value.trim();
  if (!text) return;
  input.disabled = true;
  try {
    await boardReq("POST", "/api/board", { op: "inspiration.add", text });
    input.value = "";
    await refreshBoard();
  } catch (e) {
    setStatus("灵感保存失败: " + e.message);
  } finally {
    input.disabled = false;
    input.focus();
  }
};
$("insp-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("insp-save").onclick(); }
});
$("task-refresh").onclick = () => refreshBoard();
$("task-filter").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-f]");
  if (!btn) return;
  boardFilter = btn.dataset.f;
  for (const b of $("task-filter").querySelectorAll("button")) b.classList.toggle("on", b === btn);
  renderTasks();
});
document.addEventListener("visibilitychange", boardTick);

refreshBoard();
boardTimer = setInterval(boardTick, 20000);
