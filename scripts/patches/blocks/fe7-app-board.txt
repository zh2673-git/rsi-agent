"use strict";
// ── 左侧看板：布局驱动的章节装配（C 轮）──
// 设计要点（docs/self-evolution/02-评价体系与看板插件化.md）：
// 1. **不自由排布**：章节来自 `.rsi/board.json` 的 `layout.sections`，但 kind 只剩三类
//    （tasks / metrics / inspirations）、分组维度三种、筛选三种、指标四种，且**渲染顺序
//    由 kind 的固定优先级钉死**（任务 → 指标 → 灵感）。配置写乱序也只影响同 kind 内次序。
//    「插件化」= 加章节不用改前端；「有约束」= 能加的东西是封闭枚举，不是任意 DOM。
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
const VERDICT_LABEL = { none: "未跑", pending: "待人判", pass: "通过", fail: "不通过" };
// 章节种类与顺序（与 scripts/board.py::validate_layout 的 rank 逐字同源）。
const KIND_ORDER = ["tasks", "metrics", "inspirations"];
const KIND_LABEL = { tasks: "任务", metrics: "指标", inspirations: "灵感" };
// 无 layout 时的兜底（旧板 / 手改坏板也能渲染，不白屏）。
const DEFAULT_SECTIONS = [
  { id: "tasks", kind: "tasks", title: "任务看板", group_by: "status", filter: "all", limit: 30 },
  { id: "insp", kind: "inspirations", title: "灵感" },
];

let boardData = null;       // 最近一次 GET /api/board 的 payload
let boardFilter = "all";    // all | open | done（只作用于 tasks 章节）
let boardTimer = null;
const boardOpen = new Set(); // 展开中的任务行 id（轮询重绘不丢展开态）

function boardEsc(s) { return esc(String(s ?? "")); }

function boardReq(method, url, body) {
  return api(method, url, body);
}

function boardSections() {
  const raw = boardData?.board?.layout?.sections;
  const secs = Array.isArray(raw) && raw.length ? raw : DEFAULT_SECTIONS;
  // 前端二次校验：白名单外 kind 直接丢弃（后端已校验，这里防手改文件 + 旧 host）
  const kept = secs.filter((s) => KIND_ORDER.includes(s?.kind) && typeof s?.id === "string");
  const rank = (k) => { const i = KIND_ORDER.indexOf(k); return i < 0 ? 99 : i; };
  return kept
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (rank(a.s.kind) - rank(b.s.kind)) || (a.i - b.i))
    .map((x) => x.s);
}

// 任务分组：状态优先，其次优先级，再次更新时间倒序（新改动的在同组更靠上）。
function groupTasks(tasks, groupBy) {
  const key = groupBy === "priority" ? (t) => (PRIO_RANK[t.priority] ?? 9) : null;
  if (key) {
    const buckets = new Map();
    for (const t of tasks) {
      const k = t.priority ?? "P2";
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(t);
    }
    const order = ["P0", "P1", "P2", "P3"].filter((p) => buckets.has(p))
      .concat([...buckets.keys()].filter((p) => !["P0", "P1", "P2", "P3"].includes(p)));
    const out = new Map();
    for (const p of order) out.set(p, sortRows(buckets.get(p)));
    return out;
  }
  if (groupBy === "skill") {
    const out = new Map();
    for (const t of tasks) {
      const skills = (t.resourcing?.skills ?? []);
      const keys = skills.length ? skills : ["（未指派）"];
      for (const s of keys) {
        if (!out.has(s)) out.set(s, []);
        out.get(s).push(t);
      }
    }
    for (const s of out.keys()) out.set(s, sortRows(out.get(s)));
    return out;
  }
  const by = new Map(BOARD_ORDER.map((s) => [s, []]));
  for (const t of tasks) {
    const st = by.has(t.status) ? t.status : "planning";
    by.get(st).push(t);
  }
  for (const arr of by.values()) sortRows(arr);
  return by;
}

function sortRows(arr) {
  arr.sort((a, b) => {
    const pa = PRIO_RANK[a.priority] ?? 9, pb = PRIO_RANK[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""));
  });
  return arr;
}

function taskVisible(t, filter) {
  const f = filter ?? boardFilter;
  if (f === "open") return t.status !== "done" && t.status !== "cancelled";
  if (f === "done") return t.status === "done" || t.status === "cancelled";
  return true;
}

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

function sectionHead(sec, countText, withRefresh) {
  const head = el("div", "sec-head");
  const title = el("span", "sec-title");
  title.textContent = sec.title || KIND_LABEL[sec.kind] || sec.id;
  const count = el("span", "sec-count");
  count.textContent = countText ?? "";
  head.append(title, count);
  if (withRefresh) {
    const btn = el("button", "sec-btn");
    btn.title = "重新读取看板（.rsi/board.json）";
    btn.textContent = "⟳";
    btn.onclick = () => refreshBoard();
    head.appendChild(btn);
  }
  return head;
}

// ── tasks 章节 ───────────────────────────────────────────────────────────────
function renderTasksSection(sec) {
  const wrap = el("section", "board-sec");
  wrap.dataset.kind = "tasks";
  wrap.dataset.sec = sec.id;
  const tasksAll = (boardData?.board?.tasks ?? []).filter((t) => taskVisible(t, sec.filter));
  const sum = boardData?.summary?.tasks;
  const bs = sum?.by_status ?? {};
  const openN = (bs.planning ?? 0) + (bs.doing ?? 0) + (bs.verifying ?? 0);
  wrap.appendChild(sectionHead(sec, `${openN} 进行中 / ${sum?.total ?? 0}`, true));

  // 筛选只在「该章节不限 filter」时提供（章节自己指定 filter=open 时不再给开关）
  const showFilter = !sec.filter || sec.filter === "all";
  if (showFilter) {
    const bar = el("div", "sec-filter");
    for (const [f, label] of [["all", "全部"], ["open", "未完成"], ["done", "已完成"]]) {
      const b = el("button", f === boardFilter ? "on" : "");
      b.dataset.f = f;
      b.textContent = label;
      b.onclick = () => {
        boardFilter = f;
        for (const x of bar.querySelectorAll("button")) x.classList.toggle("on", x === b);
        refreshSections();
      };
      bar.appendChild(b);
    }
    wrap.appendChild(bar);
  }

  const body = el("div", "sec-body");
  body.id = `sec-${sec.id}-body`;
  wrap.appendChild(body);
  const limit = Number(sec.limit ?? 30);
  if (!tasksAll.length) {
    body.appendChild(el("div", "empty", boardFilter === "all"
      ? "暂无任务（agent 会把成规模的事登记到这里）" : "该筛选下没有任务"));
    return wrap;
  }
  const grouped = groupTasks(tasksAll, sec.group_by ?? "status");
  let shown = 0;
  for (const [g, arr] of grouped) {
    if (shown >= limit) break;
    const head = el("div", "tgroup");
    const label = (sec.group_by ?? "status") === "status" ? (BOARD_LABEL[g] ?? g) : g;
    head.innerHTML = `<span class="tdot ${boardEsc(g)}"></span><span>${boardEsc(label)}</span>` +
      `<span class="tcnt">${arr.length}</span>`;
    body.appendChild(head);
    for (const t of arr) {
      if (shown >= limit) break;
      body.appendChild(taskRow(t));
      shown += 1;
    }
  }
  if (tasksAll.length > shown) {
    body.appendChild(el("div", "empty", `…还有 ${tasksAll.length - shown} 个任务（切「全部/未完成」或调高 limit）`));
  }
  return wrap;
}

function taskRow(t) {
  const row = document.createElement("div");
  row.className = `trow st-${boardEsc(t.status)}`;
  const done = Number(t.progress?.done ?? 0), total = Number(t.progress?.total ?? 0);
  const ratio = total > 0 ? `${done}/${total}` : "";
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const prio = t.priority ?? "P2";
  const res = t.resourcing ?? {};
  const verdict = t.evaluation?.verdict ?? "none";
  const bits = [];
  if (res.effort) bits.push({ small: "轻", medium: "中", large: "重" }[res.effort] ?? res.effort);
  if (res.model && res.model !== "current") bits.push(res.model === "cheap" ? "省模型" : res.model === "strong" ? "强模型" : res.model);
  if ((res.skills ?? []).length) bits.push(`部门 ${res.skills.length}`);
  if ((res.tools ?? []).length) bits.push(`工具 ${res.tools.length}`);
  if ((t.checks ?? []).length) bits.push(`验收 ${t.checks.length}`);
  row.innerHTML =
    `<div class="tline"><span class="tprio p-${boardEsc(prio)}">${boardEsc(prio)}</span>` +
    `<span class="ttitle" title="${boardEsc(t.title)}">${boardEsc(t.title)}</span>` +
    (verdict !== "none" ? `<span class="tverdict v-${boardEsc(verdict)}">${boardEsc(VERDICT_LABEL[verdict] ?? verdict)}</span>` : "") +
    (ratio ? `<span class="tratio">${ratio}</span>` : "") +
    `<button class="tref" title="在输入框引用这个任务（@T）">@</button></div>` +
    (total > 0 ? `<div class="tbar"><i style="width:${pct}%"></i></div>` : "") +
    (bits.length ? `<div class="tmeta">${bits.map((b) => `<span>${boardEsc(b)}</span>`).join("")}</div>` : "") +
    `<div class="tdetail" hidden></div>`;
  row.querySelector(".tref").onclick = (e) => { e.stopPropagation(); mentionRef(t.id); };
  row.querySelector(".tline").onclick = () => toggleTaskDetail(row, t);
  if (boardOpen.has(t.id)) {
    const box = row.querySelector(".tdetail");
    fillTaskDetail(box, t);
    box.hidden = false;
  }
  return row;
}

function checkLine(c) {
  const st = c.status ?? "pending";
  const ev = c.evidence ?? {};
  const bits = [];
  if (ev.exit_code != null) bits.push(`exit=${ev.exit_code}`);
  if (ev.hits != null) bits.push(`hits=${ev.hits}`);
  if (ev.exists != null) bits.push(ev.exists ? "存在" : "缺失");
  if (ev.timeout_secs != null) bits.push(`超时 ${ev.timeout_secs}s`);
  return `<li><span class="cdot ${boardEsc(st)}"></span>${boardEsc(c.name ?? c.id)}` +
    `<span class="cmeta">${boardEsc(c.kind ?? "")}${bits.length ? " · " + boardEsc(bits.join(" ")) : ""}</span></li>`;
}

function fillTaskDetail(box, t) {
  const plan = (t.plan ?? []).map((s) => `<li><span class="pdot ${boardEsc(s.status)}"></span>${boardEsc(s.step)}</li>`).join("");
  const acc = (t.acceptance ?? []).map((a) => `<li>${boardEsc(a)}</li>`).join("");
  const checks = (t.checks ?? []).map(checkLine).join("");
  const ev = t.evaluation ?? {};
  const res = t.resourcing ?? {};
  box.innerHTML =
    (t.goal ? `<div class="dsec"><b>目标</b><p>${boardEsc(t.goal)}</p></div>` : "") +
    (plan ? `<div class="dsec"><b>计划</b><ul class="dplan">${plan}</ul></div>` : "") +
    (acc ? `<div class="dsec"><b>验收标准</b><ul class="dacc">${acc}</ul></div>` : "") +
    (checks
      ? `<div class="dsec"><b>可执行检查</b><ul class="dchecks">${checks}</ul>` +
        `<p class="dverdict v-${boardEsc(ev.verdict ?? "none")}">结论 ${boardEsc(VERDICT_LABEL[ev.verdict] ?? ev.verdict ?? "未跑")}` +
        (ev.pass || ev.fail || ev.skip ? ` · pass ${Number(ev.pass)} / fail ${Number(ev.fail)} / skip ${Number(ev.skip)}` : "") +
        (ev.ran_at ? ` · ${boardEsc(ev.ran_at)}` : "") + `</p></div>`
      : "") +
    `<div class="dsec"><b>人财物</b><p>模型 ${boardEsc(res.model ?? "current")} · 力度 ${boardEsc(res.effort ?? "medium")}` +
    (res.skills?.length ? ` · 技能 ${boardEsc(res.skills.join("、"))}` : "") +
    (res.tools?.length ? ` · 工具 ${boardEsc(res.tools.join("、"))}` : "") + `</p></div>` +
    (t.progress?.note ? `<div class="dsec"><b>进度备注</b><p>${boardEsc(t.progress.note)}</p></div>` : "") +
    ((t.artifacts ?? []).length
      ? `<div class="dsec"><b>产物</b><p>${t.artifacts.map((a) => `<a href="/files/${encodeURI(a)}" target="_blank" rel="noopener">${boardEsc(a.split("/").pop())}</a>`).join(" · ")}</p></div>`
      : "") +
    `<div class="dsec"><span class="did">${boardEsc(t.id)}</span></div>`;
}

function toggleTaskDetail(row, t) {
  const box = row.querySelector(".tdetail");
  if (!box) return;
  if (!box.hidden) { box.hidden = true; boardOpen.delete(t.id); return; }
  fillTaskDetail(box, t);
  box.hidden = false;
  boardOpen.add(t.id);
}

// ── metrics 章节（评价体系可见）───────────────────────────────────────────────
function metricTiles(tasks) {
  const byVerdict = { none: 0, pending: 0, pass: 0, fail: 0 };
  let withChecks = 0, withAcc = 0, checkedPass = 0;
  for (const t of tasks) {
    const v = t.evaluation?.verdict;
    byVerdict[v && byVerdict[v] != null ? v : "none"] += 1;
    if ((t.checks ?? []).length) withChecks += 1;
    if ((t.acceptance ?? []).length) withAcc += 1;
    if (v === "pass") checkedPass += 1;
  }
  return [
    { id: "verdict", label: "验收", value: `${checkedPass}/${tasks.length}`, hint: "通过 / 总任务" },
    { id: "acceptance", label: "有标准", value: `${withAcc}/${tasks.length}`, hint: "写了验收标准" },
    { id: "by_status", label: "有检查", value: `${withChecks}/${tasks.length}`, hint: "登记了可执行检查" },
    {
      id: "by_skill", label: "不通过", value: String(byVerdict.fail),
      hint: `未跑 ${byVerdict.none} · 通过 ${byVerdict.pass}`,
    },
  ];
}

function renderMetricsSection(sec) {
  const wrap = el("section", "board-sec");
  wrap.dataset.kind = "metrics";
  wrap.dataset.sec = sec.id;
  const tasks = boardData?.board?.tasks ?? [];
  wrap.appendChild(sectionHead(sec, tasks.length ? `${tasks.length} 个任务` : "", false));
  const body = el("div", "sec-body metrics");
  body.id = `sec-${sec.id}-body`;
  wrap.appendChild(body);
  if (!tasks.length) {
    body.appendChild(el("div", "empty", "还没有任务，指标暂无意义"));
    return wrap;
  }
  const wanted = new Set(sec.metrics ?? []);
  const tiles = metricTiles(tasks).filter((t) => !wanted.size || wanted.has(t.id));
  for (const tile of tiles) {
    const row = el("div", "metric");
    row.innerHTML = `<span class="mlabel">${boardEsc(tile.label)}</span>` +
      `<span class="mvalue">${boardEsc(tile.value)}</span>` +
      `<span class="mhint">${boardEsc(tile.hint)}</span>`;
    body.appendChild(row);
  }
  return wrap;
}

// ── inspirations 章节 ───────────────────────────────────────────────────────
function renderInspSection(sec) {
  const wrap = el("section", "board-sec grow");
  wrap.dataset.kind = "inspirations";
  wrap.dataset.sec = sec.id;
  const items = boardData?.board?.inspirations ?? [];
  wrap.appendChild(sectionHead(sec, `${items.filter((i) => i.status === "open").length} 待议 / ${items.length}`, false));

  const add = el("div", "insp-add");
  const input = document.createElement("input");
  input.id = `insp-input-${sec.id}`;
  input.maxLength = 2000;
  input.placeholder = "记一条灵感，回车保存";
  const save = document.createElement("button");
  save.id = `insp-save-${sec.id}`;
  save.title = "保存灵感";
  save.textContent = "＋";
  add.append(input, save);
  wrap.appendChild(add);

  const body = el("div", "sec-body");
  body.id = `sec-${sec.id}-body`;
  wrap.appendChild(body);

  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    try {
      await boardReq("POST", "/api/board", { op: "inspiration.add", text });
      input.value = "";
      await refreshBoard();
    } catch (err) {
      setStatus("灵感保存失败: " + err.message);
    } finally {
      input.disabled = false;
      input.focus();
    }
  };
  save.onclick = submit;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  if (!items.length) {
    body.appendChild(el("div", "empty", "把零碎想法记在这里，需要时在对话里 @ 引入"));
    return wrap;
  }
  for (const it of items) {
    const row = el("div", `irow st-${boardEsc(it.status)}`);
    const tags = (it.tags ?? []).map((t) => `<span class="itag">${boardEsc(t)}</span>`).join("");
    row.innerHTML =
      `<div class="iline"><span class="itext" title="${boardEsc(it.text)}">${boardEsc(it.text)}</span>` +
      `<button class="iref" title="在输入框引用（@I）">@</button>` +
      `<button class="iarc" title="${it.status === "archived" ? "恢复为待议" : "归档"}">${it.status === "archived" ? "↺" : "✓"}</button></div>` +
      (tags || it.status !== "open" ? `<div class="imeta">${tags}<span class="ist">${INSP_LABEL[it.status] ?? it.status}</span></div>` : "");
    row.querySelector(".iref").onclick = (e) => { e.stopPropagation(); mentionRef(it.id); };
    row.querySelector(".iarc").onclick = async (e) => {
      e.stopPropagation();
      const next = it.status === "archived" ? "open" : "archived";
      try { await boardReq("POST", "/api/board", { op: "inspiration.set", id: it.id, status: next }); refreshBoard(); }
      catch (err) { setStatus("归档失败: " + err.message); }
    };
    body.appendChild(row);
  }
  return wrap;
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

function refreshSections() {
  const root = $("board-sections");
  if (!root) return;
  root.innerHTML = "";
  const secs = boardSections();
  if (!secs.length) {
    root.appendChild(el("div", "empty", "看板布局为空（layout.sections 无合法章节）"));
    return;
  }
  const renderers = {
    tasks: renderTasksSection,
    metrics: renderMetricsSection,
    inspirations: renderInspSection,
  };
  for (const sec of secs) {
    const fn = renderers[sec.kind];
    if (fn) root.appendChild(fn(sec));
  }
  // 兜底：布局里若漏了任务或灵感章节，补一个可见提示（不静默少一块）
  const kinds = new Set(secs.map((s) => s.kind));
  for (const k of ["tasks", "inspirations"]) {
    if (!kinds.has(k)) {
      root.appendChild(el("div", "empty", `布局未包含 ${KIND_LABEL[k]} 章节（\`board.py layout --file\` 可调整）`));
    }
  }
}

async function refreshBoard() {
  try {
    boardData = await boardReq("GET", "/api/board");
    refreshSections();
  } catch (e) {
    const root = $("board-sections");
    if (root) root.innerHTML = `<div class="empty">看板读取失败: ${boardEsc(e.message)}</div>`;
  }
}

function boardTick() {
  // 页面不可见时不拉（后台标签页省 CPU）；切回可见立即补一次。
  if (document.visibilityState === "visible") refreshBoard();
}

document.addEventListener("visibilitychange", boardTick);

refreshBoard();
boardTimer = setInterval(boardTick, 20000);
