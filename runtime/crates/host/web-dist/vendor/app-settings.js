"use strict";
// ── 设置面板（LLM / 工具白名单 / 技能 CRUD）──
const drawer = $("drawer");
// F2：打开设置时按需加载记忆页（连带 loadSkills 一起——两者都是「系统现在怎样」，
// 用户打开设置往往想知道的是这个，而不是马上改配置）。
$("gear").onclick = () => { drawer.classList.add("open"); loadConfig(); loadSkills(); loadMemory(); };
$("dclose").onclick = () => drawer.classList.remove("open");
document.querySelectorAll("#drawer .tabs button").forEach((b) => b.onclick = () => {
  document.querySelectorAll("#drawer .tabs button").forEach((x) => x.classList.toggle("on", x === b));
  for (const t of ["llm", "tools", "skills", "memory", "agent"]) $("tab-" + t).hidden = t !== b.dataset.tab;
});

function flash(id, ok, msg) {
  const e = $(id);
  e.textContent = msg; e.className = "flash " + (ok ? "ok" : "err");
  setTimeout(() => { if (e.textContent === msg) e.textContent = ""; }, 4000);
}
async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const v = await r.json().catch(() => ({}));
  if (!r.ok || v.ok === false) throw new Error(v.error?.message ?? r.status);
  return v;
}

let cfgTools = [], cfgMcp = { servers: [], tools: [] };
async function loadConfig() {
  try {
    await loadPresets(); // 站点清单就绪后再回显，base_url 反查预设
    const c = (await api("GET", "/api/config")).config;
    $("llm-provider").value = c.llm.provider;
    const model = c.llm.model ?? "";
    const sel = $("llm-model");
    if ([...sel.options].some((o) => o.value === model)) {
      sel.value = model; $("llm-model-custom").value = "";
    } else {
      sel.value = "__custom__"; $("llm-model-custom").value = model;
    }
    syncModelField();
    const isOllama = c.llm.provider === "ollama";
    $("llm-base").value = isOllama ? (c.llm.ollama_host ?? "localhost:11434") : (c.llm.base_url ?? "");
    $("llm-key").value = "";
    $("llm-key").placeholder = c.llm.key?.key_set ? `已设置（尾号 ${c.llm.key.key_tail}，留空不修改）` : "未设置";
    if (sitePresets.length && c.llm.provider === "openai") { $("llm-site").value = curSiteId(); updateSiteLink(curSiteId()); }
    // 媒体模型回显（tools PLAN §九 M3）：media 段 → 面板字段；key 只回掩码，留空 = 不修改
    const m = c.media ?? {};
    const mi = m.image ?? {}, mv = m.video ?? {};
    $("media-img-base").value = mi.base_url ?? "";
    $("media-img-model").value = mi.model ?? "";
    $("media-img-key").value = "";
    $("media-img-key").placeholder = mi.key?.key_set ? `已设置（尾号 ${mi.key.key_tail}，留空不修改）` : "未设置";
    $("media-vid-base").value = mv.base_url ?? "";
    $("media-vid-model").value = mv.model ?? "";
    $("media-vid-key").value = "";
    $("media-vid-key").placeholder = mv.key?.key_set ? `已设置（尾号 ${mv.key.key_tail}，留空不修改）` : "未设置";
    $("media-vid-submit").value = mv.submit_url ?? "";
    $("media-vid-query").value = mv.query_url ?? "";
    // W19 站点默认参数回显（对象 → JSON 串）
    $("media-vid-extra").value = mv.extra && typeof mv.extra === "object" ? JSON.stringify(mv.extra) : "";
    // 组头状态徽章（pcnt 位）：配置一眼可见
    $("llm-cnt").textContent = c.llm.model || c.llm.provider || "未配置";
    $("media-img-cnt").textContent = mi.base_url ? "已配置" : "未配置";
    $("media-vid-cnt").textContent = (mv.base_url && (mv.submit_url || mv.query_url)) ? "已配置" : "未配置";
    cfgTools = c.tools ?? [];
    cfgMcp = c.mcp ?? { servers: [], tools: [] };
    if (!$("tab-tools").hidden) renderTools(); // 工具 tab 可见时回填（覆盖 fetch 完成晚于 tab 切换的时序）
    // （MCP key 配置已移入「MCP 外接」各服务组内，随 renderTools 渲染）
    syncLlmFields();
    refreshUpstream(); // 回环 base_url 时亮出本地网关状态/积分（非回环自动隐藏）
    showInstBadge(c.instance_name ?? ""); // W17：子实例头部徽章（主实例为空不显示）
    showInstBadge(c.instance_name ?? ""); // W17：子实例头部徽章（主实例为空不显示）
    // F3：缓存本轮 config 喂「能力总览」——总览是只读目录，不该为它多发一次 /api/config
    window.__cfgCache = c;
    renderOverview();
    const a = c.agent ?? {};
    for (const [id, v] of [
      ["agent-max-rounds", a.max_rounds], ["agent-output-dir", a.output_dir ?? "outputs"], ["agent-budget-secs", a.budget_secs], ["agent-token-budget", a.token_budget],
      ["agent-history-limit", a.history_limit], ["agent-compact-trigger", a.compact_trigger], ["agent-compact-keep", a.compact_keep],
      ["agent-tool-result-limit", a.tool_result_limit], ["agent-retry-attempts", a.retry_attempts], ["agent-retry-base-ms", a.retry_base_ms],
      ["agent-llm-context-tokens", a.llm_context_tokens],
    ]) $(id).value = v ?? "";
    $("agent-system-prompt").value = a.system_prompt ?? "";
  } catch (e) { flash("llm-flash", false, "加载失败: " + e.message); }
}

// ── W17 多窗口多实例：徽章 + 「新窗口」modal（免填实例名：自动取工作区文件夹名）──
function showInstBadge(name) {
  const b = $("inst-badge");
  if (name) { b.textContent = "▣ " + name; b.hidden = false; }
}
$("btn-newwin").onclick = () => {
  $("win-modal").hidden = false;
  $("win-flash").textContent = "";
  $("win-ws").value = "";
  renderInstList();
  $("win-browse").focus();
};
// ── W17 迭代十：按需复活——modal 内实例列表（在线打开 / 离线启动）──
// offline 实例「启动」= POST /api/instances 同工作区（create_instance 复活路径：
// 换新端口，memory/config/会话延续）；在线实例直接开 url 新标签。
async function renderInstList() {
  const box = $("inst-list");
  box.textContent = "加载中…";
  let list = [];
  try {
    const v = await api("GET", "/api/instances");
    list = v.instances || [];
  } catch (e) {
    box.textContent = "";
    return; // 清单不可用不阻断建窗主流程
  }
  box.textContent = "";
  if (!list.length) {
    box.innerHTML = '<span class="hint" style="margin:0">暂无注册实例（首次用下方创建）</span>';
    return;
  }
  for (const it of list) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex; align-items:center; gap:8px; padding:6px 10px; border:1px solid var(--border,#ddd); border-radius:8px";
    const badge = it.online
      ? '<span style="color:#2e7d32; font-weight:600">● 在线</span>'
      : (it.stopped ? '<span style="color:#9e9e9e">○ 已手动停止</span>' : '<span style="color:#b26a45">○ 离线</span>');
    row.innerHTML =
      '<div style="flex:1; min-width:0"><div style="font-weight:600">' + esc(it.name) + "</div>" +
      '<div class="hint" style="margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">' + esc(it.workspace || "") + "</div></div>" + badge;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn ghost";
    btn.style.whiteSpace = "nowrap";
    btn.textContent = it.online ? "打开" : "启动";
    btn.onclick = async () => {
      btn.disabled = true;
      if (it.online) {
        window.open(it.url, "_blank");
        btn.disabled = false;
        return;
      }
      flash("win-flash", true, "启动 " + it.name + " 中（等待就绪，最多 ~15s）…");
      try {
        const v = await api("POST", "/api/instances", { workspace: it.workspace });
        flash("win-flash", true, "已启动 " + v.url + "（实例名 " + v.name + "）");
        window.open(v.url, "_blank");
        renderInstList();
      } catch (e) {
        flash("win-flash", false, e.message);
        btn.disabled = false;
      }
    };
    row.appendChild(btn);
    box.appendChild(row);
  }
}
$("win-browse").onclick = async () => {
  const btn = $("win-browse");
  btn.disabled = true;
  flash("win-flash", true, "请在弹出的文件夹选择框中选择…");
  try {
    const v = await api("POST", "/api/pick-folder");
    $("win-ws").value = v.path;
    flash("win-flash", true, "");
    $("win-create").focus();
  } catch (e) {
    flash("win-flash", false, e.message);
  } finally { btn.disabled = false; }
};
$("win-cancel").onclick = () => { $("win-modal").hidden = true; };
$("win-modal").onclick = (e) => { if (e.target === $("win-modal")) $("win-modal").hidden = true; };
$("win-create").onclick = async () => {
  const ws = $("win-ws").value.trim();
  if (!ws) { flash("win-flash", false, "请先选择工作区文件夹"); return; }
  // 同步先开空白标签占位（保住用户手势，避免 await 后被浏览器弹窗拦截）
  const winRef = window.open("about:blank", "_blank");
  const btn = $("win-create");
  btn.disabled = true;
  flash("win-flash", true, "创建中（实例名自动取文件夹名；等待新窗口就绪，最多 ~15s）…");
  try {
    const v = await api("POST", "/api/instances", { workspace: ws });
    flash("win-flash", true, (v.reused ? "已复用运行中窗口 " : "已创建 ") + v.url + "（实例名 " + v.name + "）");
    winRef.location.href = v.url;
    setTimeout(() => { $("win-modal").hidden = true; }, 800);
  } catch (e) {
    winRef.close();
    flash("win-flash", false, e.message);
  } finally { btn.disabled = false; }
};

$("llm-fetch-models").onclick = () => fetchModels(false);
// models_meta：/api/models 可选扩展（ollama 原生窗口探测），其他 provider 为空数组——零硬编码
let modelsMeta = [];
function fmtCtx(n) { return n >= 1024 ? Math.round(n / 1024) + "k" : String(n); }
function curModelName() {
  const msel = $("llm-model");
  return msel.value === "__custom__" ? $("llm-model-custom").value.trim() : msel.value;
}
// Agent 页 llm_context_tokens 提示 + 「填入原生值」（L7：按 provider 联动——仅本地窗口型生效）
function updateCtxHint() {
  const hit = modelsMeta.find((m) => m.name === curModelName() && m.ctx_limit);
  const hint = $("ctx-hint"), fill = $("ctx-fill");
  const p = $("llm-provider").value;
  if (p !== "ollama") {
    // 云端 API：窗口由服务端管理，token 闸与 num_ctx 均不生效（值保留，切回本地部署自动恢复）
    hint.textContent = p === "openai" || p === "anthropic"
      ? `当前 provider（${p}）为云端 API：窗口由服务端管理，此设置不生效（切回本地部署时自动恢复作用）`
      : "此设置仅本地窗口型 provider（ollama 等）生效";
    fill.hidden = true;
    return;
  }
  if (hit) {
    hint.textContent = `当前模型原生窗口 ${fmtCtx(hit.ctx_limit)} tokens（为速度可调小；原生值仅参考，非必填）`;
    fill.hidden = false;
  } else if (modelsMeta.length) {
    hint.textContent = "未探测到该模型的原生窗口（自定义模型或响应缺失）；为速度可调小";
    fill.hidden = true;
  } else {
    hint.textContent = "原生窗口：未拉取模型列表（LLM 页「拉取模型」后可用）；为速度可调小";
    fill.hidden = true;
  }
}
$("ctx-fill").onclick = () => {
  const hit = modelsMeta.find((m) => m.name === curModelName() && m.ctx_limit);
  if (hit) $("agent-llm-context-tokens").value = hit.ctx_limit;
};
async function fetchModels(silent) {
  const btn = $("llm-fetch-models");
  const prev = btn.textContent;
  if (!silent) { btn.disabled = true; btn.textContent = "拉取中…"; }
  try {
    const v = await api("GET", "/api/models?provider=" + encodeURIComponent($("llm-provider").value));
    if (v && v.ok && Array.isArray(v.models) && v.models.length) {
      const sel = $("llm-model");
      const cur = sel.value && sel.value !== "__custom__" ? sel.value : "";
      modelsMeta = Array.isArray(v.models_meta) ? v.models_meta : [];
      const ctxByName = new Map(modelsMeta.filter((m) => m.ctx_limit).map((m) => [m.name, m.ctx_limit]));
      sel.innerHTML = "";
      for (const m of v.models) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = ctxByName.has(m) ? `${m} · ${fmtCtx(ctxByName.get(m))}` : m;
        sel.appendChild(o);
      }
      const oc = document.createElement("option");
      oc.value = "__custom__"; oc.textContent = "（自定义…）"; sel.appendChild(oc);
      sel.value = (cur && v.models.includes(cur)) ? cur : (v.models[0] || "__custom__");
      syncModelField();
      if (!silent) flash("llm-flash", true, `已拉取 ${v.models.length} 个模型，点 model 下拉选择`);
    } else if (!silent) {
      flash("llm-flash", false, "未返回模型列表：" + (v?.error?.message || "空"));
    }
  } catch (e) {
    if (!silent) flash("llm-flash", false, "拉取失败: " + e.message);
  } finally {
    if (!silent) { btn.disabled = false; btn.textContent = prev; }
    updateCtxHint();
  }
}
// 打开设置时静默拉一次（仅 ollama）：Agent 页原生窗口提示开箱可用，失败不打扰
async function ensureModelsMeta() {
  if (modelsMeta.length || $("llm-provider").value !== "ollama") return;
  await fetchModels(true);
}
function syncModelField() {
  const isCustom = $("llm-model").value === "__custom__";
  $("llm-model").style.display = isCustom ? "none" : "";
  const ci = $("llm-model-custom");
  ci.style.display = isCustom ? "" : "none";
  if (isCustom && !ci.value) ci.focus();
}
$("llm-model").addEventListener("change", () => { syncModelField(); updateCtxHint(); });
$("llm-model-custom").addEventListener("input", updateCtxHint);
$("llm-provider").addEventListener("change", syncLlmFields);
// L6 站点预设：一键切换 OpenAI 兼容站点（数据源 /api/presets → presets.py；保存 = configure 热应用，零重启）
let sitePresets = [];
async function loadPresets() {
  if (sitePresets.length) return;
  try {
    const v = await api("GET", "/api/presets");
    if (v && v.ok && Array.isArray(v.presets) && v.presets.length) {
      sitePresets = v.presets;
      const sel = $("llm-site");
      sel.innerHTML = "";
      for (const p of sitePresets) {
        const o = document.createElement("option");
        o.value = p.id; o.textContent = p.base_url ? p.name : `${p.name}（手填 base_url）`;
        sel.appendChild(o);
      }
    }
  } catch (e) { /* 软依赖：拉不到则站点栏留空不阻塞 */ }
}
function siteById(id) { return sitePresets.find((p) => p.id === id); }
function curSiteId() {
  const base = $("llm-base").value.trim().replace(/\/+$/, "");
  const hit = sitePresets.find((p) => p.base_url && p.base_url.replace(/\/+$/, "") === base);
  return hit ? hit.id : (sitePresets.length ? "custom" : "");
}
function applySite(id) {
  const p = siteById(id);
  if (!p) { $("llm-site-key-url").hidden = true; return; }
  if (p.base_url) {
    $("llm-base").value = p.base_url;
    const saved = localStorage.getItem("react-agent:llmkey:" + p.id) || "";
    if (saved) {
      $("llm-key").value = saved;
      $("llm-key").placeholder = `已记忆该站点 key（尾号 ${saved.slice(-4)}，可覆盖）`;
    } else if (p.key_hint) {
      $("llm-key").value = p.key_hint; // 免 key 站点：直接预填提示值（如 magpie 本地网关任意令牌）
      $("llm-key").placeholder = p.key_hint;
    } else {
      $("llm-key").value = "";
      $("llm-key").placeholder = "未保存过该站点 key";
    }
  } else {
    $("llm-base").value = ""; $("llm-key").value = "";
    $("llm-key").placeholder = "输入该站点 api_key";
  }
  updateSiteLink(id);
}
function updateSiteLink(id) {
  const p = siteById(id), link = $("llm-site-key-url");
  if (p && p.key_url) { link.href = p.key_url; link.hidden = false; } else link.hidden = true;
}
$("llm-site").addEventListener("change", () => { applySite($("llm-site").value); refreshUpstream(); });
// ── 上游本地网关（magpie）：状态灯 + 一键启动 + 积分行 ──
// base_url 为本机回环时显示网关块；GET /api/upstream/status（探活 + /magpie/quotas），
// POST /api/upstream/start 幂等 spawn magpie serve。非 magpie 站点无 quotas 端点 → 积分行自然隐藏。
async function refreshUpstream() {
  const base = $("llm-base").value.trim();
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|::1|\[::1\])(:\d+)?/i.test(base);
  const field = $("upstream-field"), quotas = $("upstream-quotas");
  if (!local) {
    field.hidden = true; quotas.hidden = true;
    const ck = $("upstream-checkin-field"); if (ck) ck.hidden = true;
    return;
  }
  field.hidden = false;
  const ckf = $("upstream-checkin-field"); if (ckf) ckf.hidden = false;
  refreshCheckinAccounts();
  const st = $("upstream-state");
  try {
    renderUpstream(await api("GET", "/api/upstream/status"));
  } catch (e) {
    st.textContent = "状态获取失败"; st.className = "up-state down";
    $("upstream-start").hidden = false; quotas.hidden = true;
  }
}
function renderUpstream(v) {
  const st = $("upstream-state"), q = $("upstream-quotas");
  st.textContent = v.up ? `运行中 · ${v.models ?? "?"} 个模型` : "未运行";
  st.className = "up-state " + (v.up ? "up" : "down");
  $("upstream-start").hidden = !!v.up;
  // 积分行：每账户一行（provider 名 + user + 各窗口剩余百分比/额度/重置日）
  const rows = [];
  for (const acc of (v.quotas?.data ?? [])) {
    const wins = (acc.windows ?? []).map((w) => {
      const reset = w.resetsAt ? `，${w.resetsAt.slice(5, 10)} 重置` : "";
      const pct = (w.limit > 0 && typeof w.amount === "number") ? Math.round(((w.limit - w.amount) / w.limit) * 100)
        : ((w.remaining ?? 0) + (w.used ?? 0) > 0 ? Math.round(((w.remaining ?? 0) / ((w.remaining ?? 0) + (w.used ?? 0))) * 100) : null);
      return pct == null ? `${w.name} ${w.display ?? ""}` : `${w.name} 剩 ${pct}%（${w.display ?? ""}${reset}）`;
    }).join("；");
    if (wins) rows.push(`<b>${esc(acc.name ?? acc.provider ?? "")}</b>（${esc(acc.user ?? "")}）：${esc(wins)}`);
  }
  if (rows.length) { q.innerHTML = rows.join("<br>"); q.hidden = false; } else q.hidden = true;
}
// ── 账号签到（magpie 内置渠道）：登录弹窗 / 一键领取 / 状态行 ──
const CHECKIN_PROVIDERS = [["workbuddy","WorkBuddy","workbuddy"],["trae","Trae","trae-cn"],["qoder","Qoder","qoder"],["minimax","MiniMax","minimax"]];
function renderCheckinState(text, cls) {
  const st = $("checkin-state");
  st.textContent = text;
  st.className = "up-state " + (cls ?? "");
}
async function refreshCheckinAccounts() {
  const field = $("upstream-checkin-field");
  if (field.hidden) return;
  try {
    const v = await api("GET", "/api/upstream/accounts");
    const list = Array.isArray(v.accounts) ? v.accounts : (v.accounts?.accounts ?? []);
      const PN = { workbuddy: "WorkBuddy", "trae-cn": "Trae CN", qoder: "Qoder", minimax: "MiniMax", kiro: "Kiro" };
      const f = x => (typeof x === "number" ? Math.round(x * 10) / 10 : x);
      const log = $("upstream-checkin-log");
      log.style.whiteSpace = "pre-wrap";
      log.textContent = list.map(a => {
        const name = `${PN[a.agent] ?? a.agent} ${a.user}${a.active ? "" : "（未激活）"}`;
        const qs = (a.windows ?? []).map(w => `${w.name ?? "积分"} 剩 ${f(w.remaining) ?? "?"}`).join("，");
        return `· ${name}：${qs || "暂无积分数据"}`;
      }).join("\n");
      log.hidden = list.length === 0;
    const withQuota = list.filter(a => (a.windows?.length ?? 0) > 0);
    renderCheckinState(`已登录 ${list.length} 个账号${withQuota.length ? `（${withQuota.length} 个有积分）` : ""}`, "up");
  } catch { renderCheckinState("账号状态获取失败", "down"); }
}
for (const [prov, label, pid] of CHECKIN_PROVIDERS) {
  $(`upstream-login-${prov}`).onclick = async () => {
    const btn = $(`upstream-login-${prov}`);
    btn.disabled = true; btn.textContent = `${label} 登录中…（在弹窗完成登录后自动恢复）`;
    flash("llm-flash", true, `${label} 登录窗已弹出——在窗口里完成验证，关窗后自动刷新账号。`);
    try { await api("POST", `/api/upstream/login?provider=${pid}`); flash("llm-flash", true, `${label} 登录流程结束，正在刷新账号…`); }
    catch (e) { flash("llm-flash", false, `${label} 登录流程提前退出：${e.message}（若窗口里已完成登录，稍后自动刷新即可确认）`); }
    btn.disabled = false; btn.textContent = `登录 ${label} 账号`;
    refreshCheckinAccounts(); refreshUpstream();
  };
}
$("upstream-checkin").onclick = async () => {
  const btn = $("upstream-checkin");
  btn.disabled = true; btn.textContent = "领取中…";
  renderCheckinState("正在为全部账号签到…", "up");
  try {
    const v = await api("POST", "/api/upstream/checkin");
    const log = $("upstream-checkin-log");
    log.textContent = (v.lines ?? []).join("\n") || "（无输出）";
    log.hidden = false;
    flash("llm-flash", true, v.ok ? "签到完成（幂等：当天重复点只显示 already）" : "签到命令退出非 0，详情见结果行");
  } catch (e) { flash("llm-flash", false, `签到失败：${e.message}`); renderCheckinState("签到失败", "down"); }
  btn.disabled = false; btn.textContent = "一键领取积分";
  refreshCheckinAccounts(); refreshUpstream();
};
$("upstream-start").onclick = async () => {
  const btn = $("upstream-start");
  btn.disabled = true; btn.textContent = "启动中…";
  try {
    const v = await api("POST", "/api/upstream/start");
    if (!v.up) flash("llm-flash", false, "magpie serve 已拉起但未在 10s 内就绪（详情见 config 同目录 .magpie-serve.log）");
    else flash("llm-flash", true, "本地网关已就绪");
  } catch (e) { flash("llm-flash", false, e.message); }
  btn.disabled = false; btn.textContent = "一键启动";
  refreshUpstream();
};
function syncLlmFields() {
  const p = $("llm-provider").value;
  const baseWrap = $("llm-base").closest(".field");
  const baseLabel = baseWrap.querySelector("label");
  const keyWrap = $("llm-key").closest(".field");
  const siteWrap = $("llm-site-field");
  if (p === "ollama") {
    baseLabel.textContent = "ollama 地址";
    $("llm-base").placeholder = "localhost:11434";
    const bv = $("llm-base").value.trim();
    if (!bv || /api\.(openai|anthropic|deepseek)\.com/.test(bv)) $("llm-base").value = "localhost:11434";
    keyWrap.style.display = "none";
    baseWrap.style.display = "";
    siteWrap.style.display = "none";
  } else if (p === "mock") {
    baseWrap.style.display = "none";
    keyWrap.style.display = "none";
    siteWrap.style.display = "none";
  } else {
    baseLabel.textContent = "base_url";
    $("llm-base").placeholder = p === "anthropic" ? "https://api.anthropic.com" : "https://api.deepseek.com/v1";
    baseWrap.style.display = "";
    keyWrap.style.display = "";
    siteWrap.style.display = p === "openai" ? "" : "none"; // 站点预设仅 OpenAI 兼容族
  }
}
$("llm-save").onclick = async () => {
  const msel = $("llm-model");
  const model = msel.value === "__custom__" ? $("llm-model-custom").value.trim() : msel.value.trim();
  const body = { llm: { provider: $("llm-provider").value, model, base_url: $("llm-base").value.trim() } };
  const key = $("llm-key").value.trim();
  if (key) body.llm.api_key = key;
  try {
    await api("PUT", "/api/config", body);
    // per-site key 记忆：按站点 id 存 localStorage（custom 不记，base_url 不定）；config.json 只落当前生效站
    if (key && $("llm-provider").value === "openai") {
      const sid = $("llm-site").value;
      if (sid && sid !== "custom") localStorage.setItem("react-agent:llmkey:" + sid, key);
    }
    flash("llm-flash", true, "已保存并热生效");
    loadConfig();
    fetchModels();
  } catch (e) { flash("llm-flash", false, e.message); }
};
// ── 媒体模型独立保存（tools PLAN §九 M3）：生图/生视频各自 PUT media 段（逐字段 merge，
// key 留空不提交 = 不修改；后端 merge 对 null/空串不覆盖，故想清空某字段须整段重填）──
function mediaBody(kind) {
  const sec = kind === "image"
    ? { base_url: "media-img-base", model: "media-img-model" }
    : { base_url: "media-vid-base", model: "media-vid-model", submit_url: "media-vid-submit", query_url: "media-vid-query" };
  const out = {};
  for (const [field, id] of Object.entries(sec)) {
    const v = $(id).value.trim();
    if (v) out[field] = v;
  }
  const key = $(kind === "image" ? "media-img-key" : "media-vid-key").value.trim();
  if (key) out.key = key; // media 段字段名与 llm 段不同：是 key 不是 api_key
  // W19 站点默认参数：JSON 输入（非法即报错不提交；填 {} = 清空全部默认参数）
  if (kind === "video") {
    const raw = $("media-vid-extra").value.trim();
    if (raw) {
      try { out.extra = JSON.parse(raw); }
      catch { throw new Error("站点默认参数 extra 不是合法 JSON"); }
    }
  }
  return out;
}
async function saveMedia(kind, flashId) {
  let fields;
  try {
    fields = mediaBody(kind);
  } catch (e) { flash(flashId, false, e.message); return; }
  if (!Object.keys(fields).length) { flash(flashId, false, "未填写任何字段"); return; }
  try {
    await api("PUT", "/api/config", { media: { [kind]: fields } });
    flash(flashId, true, "已保存落盘（重启 host 后 env 生效）");
    loadConfig();
  } catch (e) { flash(flashId, false, e.message); }
}
$("media-img-save").onclick = () => saveMedia("image", "media-img-flash");
$("media-vid-save").onclick = () => saveMedia("video", "media-vid-flash");
// LLM tab 三区折叠（与工具池 poolhead 同款交互；静态 HTML，加载时绑定一次）
document.querySelectorAll("#tab-llm .poolhead.collapsible").forEach((head) => {
  const body = head.nextElementSibling;
  head.onclick = () => {
    body.hidden = !body.hidden;
    head.querySelector(".chev").textContent = body.hidden ? "▸" : "▾";
    head.classList.toggle("closed", body.hidden);
  };
});
// 工具三池分组元数据（pool → 组标题/说明）；条目点击折叠展开配置详情
const POOL_META = {
  builtin: { label: "内置工具", hint: "" },
  skill: { label: "技能工具", hint: "随技能装载（tools.json 声明）——装载 ≠ 启用" },
  mcp: { label: "MCP 外接", hint: "展开各服务组：勾选启用工具、填写 API Key（保存落盘，重启 host 生效）" },
};
function paramSummary(p) {
  if (!p || typeof p !== "object") return "";
  const props = p.properties;
  if (!props || typeof props !== "object") return "";
  const lines = Object.entries(props).map(([k, v]) => {
    const t = v && v.type ? v.type : "?";
    const d = v && v.description ? ` — ${v.description}` : "";
    return `${k} (${t})${d}`;
  });
  return lines.length ? lines.join("\n") : "（无参数）";
}
function renderTools() {
  const box = $("tools-list"); box.innerHTML = "";
  if (!cfgTools.length) { box.innerHTML = '<div class="empty">（工具池为空或 tools 不可用）</div>'; return; }
  const groups = { builtin: [], skill: [], mcp: [] };
  for (const t of cfgTools) (groups[t.pool] ?? groups.builtin).push(t);
  for (const pool of ["builtin", "skill", "mcp"]) {
    const items = groups[pool];
    if (!items.length && !(pool === "mcp" && (cfgMcp.servers ?? []).length)) continue; // MCP 池：声明了 server（即使装载失败 0 工具）也要可见
    const meta = POOL_META[pool];
    // 池级折叠：poolhead 本身可点击收起/展开整池（默认展开）
    const phead = el(`<div class="poolhead collapsible"><span class="chev">▾</span><span class="plabel">${meta.label}</span><span class="pcnt">${items.length}</span></div>`);
    const pbody = el(`<div class="poolbody"></div>`);
    phead.onclick = () => {
      pbody.hidden = !pbody.hidden;
      phead.querySelector(".chev").textContent = pbody.hidden ? "▸" : "▾";
      phead.classList.toggle("closed", pbody.hidden);
    };
    box.appendChild(phead);
    box.appendChild(pbody);
    if (meta.hint) pbody.appendChild(el(`<div class="poolhint">${meta.hint}</div>`));
    if (pool === "builtin") {
      // 内置 9 件：少而稳定，平铺
      for (const t of items) appendToolRow(pbody, t, "");
      continue;
    }
    // 技能/MCP 池：按来源折叠分组（默认收起），组头 = 来源名 + 计数 +（MCP）状态灯 + 总开关
    const key = pool === "skill" ? "skill" : "mcp_server";
    const order = new Map();
    if (pool === "mcp") {
      // server 排序：ready 在前、其余按名稳定排；failed 垫底（故障一眼可见）
      const rank = { ready: 0, starting: 1, stopped: 1, failed: 2 };
      (cfgMcp.servers ?? []).forEach((s) => order.set(s.name, s));
      items.sort((a, b) => ((rank[order.get(a[key])?.status] ?? 1) - (rank[order.get(b[key])?.status] ?? 1)) || a[key].localeCompare(b[key]));
    } else {
      items.sort((a, b) => (a[key] ?? "").localeCompare(b[key] ?? ""));
    }
    const bySrc = new Map();
    for (const t of items) { const k = t[key] ?? "?"; (bySrc.get(k) ?? bySrc.set(k, []).get(k)).push(t); }
    if (pool === "mcp") {
      // 装载失败/0 工具的声明 server 也要可见（否则用户无从发现该去填 key）
      for (const s of cfgMcp.servers ?? []) if (!bySrc.has(s.name)) bySrc.set(s.name, []);
    }
    for (const [src, list] of bySrc) {
      const st = order.get(src);
      const stHtml = pool === "mcp" && st
        ? `<span class="mcp-status st-${esc(st.status)}" ${st.status === "failed" && st.error ? `title="${esc(st.error)}"` : ""}>${esc(st.status)}</span>`
        : "";
      const head = el(`<div class="tghead"><input type="checkbox" title="全启/全停该组工具"><span class="tname">${esc(src)}</span><span class="pcnt">${list.length}</span>${stHtml}<span class="chev">▸</span></div>`);
      const body = el(`<div class="tgbody" hidden></div>`);
      for (const t of list) appendToolRow(body, t, pool === "skill" ? "" : `<span class="badge b-skill" title="MCP server：${esc(src)}">mcp</span>`);
      if (pool === "mcp" && !list.length) body.appendChild(el(`<div class="empty">0 工具装载——${esc(st?.error || st?.status || "未连接")}；下方填好 Key 保存后重启 host 重试</div>`));
      // MCP 服务配置区（组内）：env key 输入 + 独立保存（仅落盘，重启 host 生效）
      if (pool === "mcp") {
        const decl = (cfgMcp.declared ?? []).find((d) => d.name === src);
        if (decl && (decl.env ?? []).length) {
          const cfgBox = el(`<div class="tgcfg"><div class="tgcfg-title">服务配置（Key 保存仅落盘，需重启 host 生效）</div></div>`);
          for (const e of decl.env) {
            cfgBox.appendChild(el(`<div class="field"><label>${esc(e.key)}</label><input type="password" autocomplete="off" data-k="${esc(e.key)}" placeholder="${e.key_set ? `已设置（尾号 ${esc(e.key_tail ?? "")}，留空不修改）` : "未设置"}"></div>`));
          }
          const srow = el(`<div class="row"><button class="btn">保存 Key</button><span class="flash"></span></div>`);
          const sflash = srow.querySelector(".flash");
          srow.querySelector("button").onclick = async (e) => {
            e.stopPropagation();
            const env = {};
            for (const inp of cfgBox.querySelectorAll("input[data-k]")) {
              const v = inp.value.trim();
              if (v) { env[inp.dataset.k] = v; inp.value = ""; }
            }
            if (!Object.keys(env).length) { sflash.textContent = "无修改（留空 = 不覆盖）"; sflash.className = "flash err"; return; }
            try {
              await api("PUT", "/api/config", { mcp_servers: { [src]: { env } } });
              sflash.textContent = "已保存，重启 host 生效"; sflash.className = "flash ok";
            } catch (err) { sflash.textContent = err.message; sflash.className = "flash err"; }
          };
          cfgBox.appendChild(srow);
          body.appendChild(cfgBox);
        }
      }
      // 总开关三态：all / none / partial(indeterminate)；组内勾选变化实时回写
      const syncHead = () => {
        const boxes = [...body.querySelectorAll(".toolitem input")];
        const on = boxes.filter((b) => b.checked).length;
        head.querySelector("input").checked = on > 0 && on === boxes.length;
        head.querySelector("input").indeterminate = on > 0 && on < boxes.length;
      };
      head.querySelector("input").onclick = (e) => {
        e.stopPropagation();
        const on = head.querySelector("input").checked;
        body.querySelectorAll(".toolitem input").forEach((b) => { b.checked = on; });
        syncHead();
      };
      body.addEventListener("change", syncHead);
      head.onclick = (e) => {
        e.stopPropagation(); // 组头点击不冒泡到池级折叠
        if (e.target.tagName === "INPUT") return;
        body.hidden = !body.hidden;
        head.querySelector(".chev").textContent = body.hidden ? "▸" : "▾";
        head.classList.toggle("open", !body.hidden);
      };
      syncHead();
      pbody.appendChild(head);
      pbody.appendChild(body);
    }
  }
}
function appendToolRow(box, t, src) {
  const params = paramSummary(t.parameters);
  const row = el(`<div class="toolitem"><input type="checkbox" ${t.enabled ? "checked" : ""}><span class="name">${esc(t.name)}</span>${src}<span class="chev">▸</span></div>`);
  const detail = (t.description || params)
    ? el(`<div class="tooldetail" hidden><div class="tdesc">${esc(t.description ?? "")}</div>${params ? `<pre class="tparams">${esc(params)}</pre>` : ""}</div>`)
    : null;
  row.onclick = (e) => {
    if (e.target.tagName === "INPUT") return; // 勾选不触发折叠
    if (!detail) return;
    const open = detail.hidden;
    detail.hidden = !open;
    row.querySelector(".chev").textContent = open ? "▾" : "▸";
    row.classList.toggle("open", open);
  };
  box.appendChild(row);
  if (detail) box.appendChild(detail);
}
const toolsTabObserver = new MutationObserver(() => { if (!$("tab-tools").hidden) renderTools(); });
toolsTabObserver.observe($("tab-tools"), { attributes: true, attributeFilter: ["hidden"] });
$("tools-save").onclick = async () => {
  // 整体替换白名单：三池条目已统一渲染于 #tools-list，勾选合并提交
  // 注意选择器限定 .toolitem——折叠组头也有 checkbox（总开关），不能混入
  // MCP key 保存已移入各服务组内独立按钮（tools-save 只管白名单）
  const enabled = [...document.querySelectorAll("#tools-list .toolitem input:checked")].map((i) => i.closest(".toolitem").querySelector(".name").textContent);
  const body = { tools: { enabled } };
  try {
    await api("PUT", "/api/config", body);
    flash("tools-flash", true, "已保存，白名单热生效");
    await loadConfig();
  } catch (e) { flash("tools-flash", false, e.message); }
};

// P5/E1 Agent 参数：空字段 = 不修改；system_prompt 总是提交（允许清空回内置链）
$("agent-save").onclick = async () => {
  const agent = {};
  for (const [k, id] of [
    ["max_rounds", "agent-max-rounds"], ["output_dir", "agent-output-dir"], ["budget_secs", "agent-budget-secs"], ["token_budget", "agent-token-budget"],
    ["history_limit", "agent-history-limit"], ["compact_trigger", "agent-compact-trigger"], ["compact_keep", "agent-compact-keep"],
    ["tool_result_limit", "agent-tool-result-limit"], ["retry_attempts", "agent-retry-attempts"], ["retry_base_ms", "agent-retry-base-ms"],
    ["llm_context_tokens", "agent-llm-context-tokens"],
  ]) {
    const raw = $(id).value.trim();
    if (raw !== "") agent[k] = Number(raw);
  }
  agent.system_prompt = $("agent-system-prompt").value;
  try {
    await api("PUT", "/api/config", { agent });
    flash("agent-flash", true, "已保存，下轮对话生效");
    loadConfig();
  } catch (e) { flash("agent-flash", false, e.message); }
};

let skillsCache = [], curSkill = null;
async function loadSkills() {
  try {
    skillsCache = (await api("GET", "/api/skills")).skills ?? [];
    renderSkills();
  } catch (e) { flash("skill-flash", false, "加载失败: " + e.message); }
}
function renderSkills() {
  const box = $("skills-list"); box.innerHTML = "";
  if (!skillsCache.length) box.innerHTML = '<div class="empty">（暂无技能）</div>';
  for (const s of skillsCache) {
    // 来源徽章：origin=preset 出厂（删除保护）/ 缺省 user 用户；老数据缺 origin 按 user 显示
    const isUser = s.origin !== "preset";
    const badge = `<span class="badge ${isUser ? "b-user" : "b-preset"}" title="${isUser ? "用户技能（可删除）" : "出厂技能（删除保护）"}">${isUser ? "用户" : "内置"}</span>`;
    const item = el(`<div class="skillitem"><span class="name">${esc(s.name)}</span>${badge}<span class="desc">${esc(s.description ?? "")}</span><span class="rev" title="在文件管理器中打开技能目录">📂</span></div>`);
    item.onclick = () => openSkill(s.name);
    item.querySelector(".rev").onclick = (e) => { e.stopPropagation(); reveal("skill", s.name, "skill-flash"); };
    box.appendChild(item);
    // R9/W6：配套工具区（tools_detail 由 host 从 tools.skill_tools 合入，含未启用项 + enabled 标记）。
    // 启停就地完成：永远走配置闸（现有启用集 ± 该工具 → PUT /api/config）；失败回滚 UI。
    const td = s.tools_detail ?? [];
    if (!td.length) continue;
    const zone = el(`<div class="skilltools"></div>`);
    for (const t of td) {
      const row = el(`<label class="skilltool"><input type="checkbox" ${t.enabled ? "checked" : ""}><span class="sname">${esc(t.name)}</span><span class="sdesc">${esc(t.description ?? "")}</span></label>`);
      row.querySelector("input").onchange = async (e) => {
        const on = e.target.checked;
        try {
          const c = (await api("GET", "/api/config")).config;
          const set = new Set((c.tools ?? []).filter((x) => x.enabled).map((x) => x.name));
          if (on) set.add(t.name); else set.delete(t.name);
          await api("PUT", "/api/config", { tools: { enabled: [...set] } });
          flash("skill-flash", true, on ? `已启用 ${t.name}（会话中 load_skill 后生效）` : `已禁用 ${t.name}`);
          loadConfig();
        } catch (err) {
          e.target.checked = !on; // 启用失败回滚勾选态
          flash("skill-flash", false, err.message);
        }
      };
      zone.appendChild(row);
    }
    box.appendChild(zone);
  }
}
// ── 设置面板「📂 源文件」：host 代为在文件管理器中打开配置源文件位置（浏览器禁 file:// 跳转）──
async function reveal(target, name, flashId) {
  try {
    await api("POST", "/api/reveal?target=" + target + (name ? "&name=" + encodeURIComponent(name) : ""));
    flash(flashId, true, "已在文件管理器中打开");
  } catch (e) { flash(flashId, false, e.message); }
}
$("llm-reveal").onclick = () => reveal("config", null, "llm-flash");
// ── F2：记忆页（画像可见化）──────────────────────────────────────────────────
// 设计取舍（对齐 I-20261108-02「设置把『我做的决定』和『系统现在的状态』混成一件」）：
// 1. **能看**：此前画像只在 prompt 里生效，用户完全看不见——写错了也不知道，
//    而它每轮都影响回答。可见化本身就是修 bug。
// 2. **只能删**：新增/编辑走对话（`profile.py`），因为画像是**观察的结论**，
//    用户手写一条「我喜欢简洁」不是观察而是一条命令；命令说在对话里，由模型落成画像。
//    但删除必须是用户的权力：写错的结论会让模型每轮带着它犯同一个错。
// 3. **分层展示**：全局 → 各域 → 观察。域按「作用范围」而非角色分（见 04 文档），
//    UI 直接把这条判据写进每组标题，用户看到结构就学会判据。
const MEM_KIND_LABEL = { user: "关于你", model: "模型脾气", workflow: "工作方式", env: "环境" };
let memData = null;

async function loadMemory() {
  const box = $("mem-body"), stat = $("mem-stat");
  if (!box) return;
  box.innerHTML = '<div class="empty">读取中…</div>';
  try {
    const v = await api("GET", "/api/profile");
    memData = v.profile ?? {};
    renderMemory();
  } catch (e) {
    stat.textContent = "读取失败";
    box.innerHTML = `<div class="empty">画像读取失败: ${esc(e.message)}</div>`;
  }
}

function memCount(p) {
  const secs = (p.sections ?? []).length, notes = (p.notes ?? []).length;
  const doms = Object.keys(p.domains ?? {}).length;
  return `全局 ${secs} 章节 · ${notes} 条观察 · ${doms} 个域`;
}

function renderMemory() {
  const box = $("mem-body"), stat = $("mem-stat");
  if (!box) return;
  const p = memData ?? {};
  box.innerHTML = "";
  const secs = p.sections ?? [], notes = p.notes ?? [], doms = p.domains ?? {};

  if (p.corrupt) {
    box.appendChild(el(`<div class="mem-warn">profile.json 解析失败——已按空画像展示，<b>原文件未改动</b>。请点「📂 源文件」人工核对。</div>`));
  }
  const empty = !secs.length && !notes.length && !Object.keys(doms).length;
  if (!p.exists || (empty && !p.corrupt)) {
    stat.textContent = p.exists ? "画像是空的" : "还没有画像";
    box.appendChild(el(`<div class="empty">还没有记下任何结论。<br>聊天时我若发现稳定的规律（你怎么偏好、这个域怎么做事），会记到这里——不用你手动填。</div>`));
    return;
  }
  stat.textContent = memCount(p) + (p.current_domain ? ` · 当前域 ${p.current_domain}` : " · 未选域（只用全局）");

  // ① 全局：换到哪都对的事实
  box.appendChild(memGroupHead("全局（换到哪都对）", `每轮注入 · 上限内合并`, false));
  const gbody = el(`<div class="mem-g"></div>`);
  if (!secs.length && !notes.length) gbody.appendChild(el(`<div class="empty">全局层为空——所有结论都在域里，或尚未记录</div>`));
  for (const s of secs) gbody.appendChild(memSection(s, ""));
  box.appendChild(gbody);

  // ② 域：同一件事在不同场合的不同版本
  const names = Object.keys(doms);
  if (names.length) {
    box.appendChild(memGroupHead("域（换到别处就错）", `${names.length} 个 · 上限 ${p.max_domains ?? 8}`, false));
    for (const name of names) {
      const d = doms[name] ?? {};
      const cur = name === p.current_domain;
      const head = el(`<div class="mem-domain-head${cur ? " cur" : ""}"></div>`);
      head.innerHTML = `<span class="mem-dname">${esc(name)}</span>` +
        (cur ? `<span class="mem-cur">当前</span>` : "") +
        `<span class="mem-dcnt">${(d.sections ?? []).length} 章节 · ${(d.notes ?? []).length} 观察</span>` +
        `<button class="mem-del" title="删除整个域（只删这个域，不动全局）">🗑</button>`;
      head.querySelector(".mem-del").onclick = () => memDelete("domain-rm", name, "", `域「${name}」`);
      box.appendChild(head);
      const body = el(`<div class="mem-g domain"></div>`);
      for (const s of d.sections ?? []) body.appendChild(memSection(s, name));
      for (const n of d.notes ?? []) body.appendChild(memNote(n, name));
      if (!(d.sections ?? []).length && !(d.notes ?? []).length) {
        body.appendChild(el(`<div class="empty">（空域）</div>`));
      }
      box.appendChild(body);
    }
  }

  // ③ 观察：原始记录（进 prompt 只取最近几条，这里全列——「我记过什么」要能查全）
  if (notes.length) {
    box.appendChild(memGroupHead("观察（原始记录，不是结论）", `${notes.length} 条 · 进上下文只取最近 10 条`, false));
    const nb = el(`<div class="mem-g"></div>`);
    for (const n of notes) nb.appendChild(memNote(n, ""));
    box.appendChild(nb);
  }

  const foot = el(`<p class="hint" style="margin-top:10px"></p>`);
  foot.textContent = "域按「作用范围」分，不按角色分：换到别处会错 → 域；换到哪都对 → 全局。" +
    "系统不会自己猜域（猜错比不猜更坏），切域请让我在对话里做。";
  box.appendChild(foot);
}

function memGroupHead(title, meta) {
  const h = el(`<div class="mem-head"></div>`);
  h.innerHTML = `<span class="mem-t">${esc(title)}</span><span class="mem-m">${esc(meta)}</span>`;
  return h;
}

function memSection(s, domain) {
  const row = el(`<div class="mem-sec"></div>`);
  const kind = MEM_KIND_LABEL[s.kind] ?? s.kind ?? "";
  row.innerHTML =
    `<div class="mem-sh"><span class="mem-kind k-${esc(s.kind ?? "")}">${esc(kind)}</span>` +
    `<span class="mem-sid">${esc(s.id ?? "")}</span>` +
    `<span class="mem-stitle">${esc(s.title ?? "")}</span>` +
    `<button class="mem-del" title="删除这个章节（删了就真不记得了）">🗑</button></div>` +
    `<div class="mem-sbody">${esc(s.body ?? "")}</div>`;
  row.querySelector(".mem-del").onclick = () => memDelete("section-rm", s.id, domain, `章节「${s.title || s.id}」`);
  return row;
}

function memNote(n, domain) {
  const row = el(`<div class="mem-note"></div>`);
  const tags = (n.tags ?? []).map((t) => `<span class="itag">${esc(t)}</span>`).join("");
  row.innerHTML =
    `<span class="mem-kind k-${esc(n.kind ?? "")}">${esc(MEM_KIND_LABEL[n.kind] ?? n.kind ?? "")}</span>` +
    `<span class="mem-ntext">${esc(n.text ?? "")}</span>` +
    (tags ? `<span class="mem-ntags">${tags}</span>` : "") +
    `<span class="mem-nid">${esc(n.id ?? "")}</span>` +
    `<button class="mem-del" title="删掉这条观察">🗑</button>`;
  row.querySelector(".mem-del").onclick = () => memDelete("note-rm", n.id, domain, "这条观察");
  return row;
}

// 删除：两步确认放在**按钮原位**（不用 window.confirm——它会遮住列表，
// 用户看不见自己在删哪一条；与灵感删除同一裁决线）。
async function memDelete(op, id, domain, label) {
  const msg = `删掉${label}？这会真的从 profile.json 里移除。`;
  if (!window.confirm(msg)) return;
  try {
    await api("POST", "/api/profile", { op, id, domain });
    flash("skill-flash", true, `已删除：${label}`);
    await loadMemory();
  } catch (e) {
    flash("skill-flash", false, "删除失败: " + e.message);
  }
}

$("mem-refresh").onclick = () => loadMemory();
$("mem-refresh").onclick = () => loadMemory();
$("mem-reveal").onclick = () => reveal("config", null, "skill-flash");

// ── F3：能力总览（设置抽屉的目录页）──────────────────────────────────────────
// 三列 = 三类决定来源（见 index.html 注释）。每列的值都从**已有数据**推出来，
// 不新增任何后端接口：
//   · 你决定的 → loadConfig 已拉到的 llm / agent / tools
//   · 它带的牌 → tools 的 pool 分类 + skillsCache
//   · 它记得的事 → loadMemory 已拉到的 profile
// 点行跳页签，不展开不弹窗——目录的价值是「一眼看清 + 一步到位」。
function ovSet(id, text) {
  const node = $(id);
  if (node) node.textContent = text;
}

function renderOverview() {
  if (!$("cap-overview")) return;
  const c = window.__cfgCache;
  if (c) {
    const m = c.llm ?? {};
    ovSet("ov-llm", m.model ? `${m.provider ?? "?"} · ${m.model}` : (m.provider ?? "未配置"));
    const tools = c.tools ?? [];
    const on = tools.filter((t) => t.enabled).length;
    ovSet("ov-tools", on ? `${on} / ${tools.length} 启用` : "未启用任何工具");
    const a = c.agent ?? {};
    const bits = [];
    if (a.max_rounds) bits.push(`≤${a.max_rounds} 轮`);
    if (a.budget_secs > 0) bits.push(`${a.budget_secs}s`);
    if (a.token_budget > 0) bits.push(`${a.token_budget} tok`);
    ovSet("ov-agent", bits.length ? bits.join(" · ") : "全部用缺省");
    const st = tools.filter((t) => t.pool === "skill").length;
    const mc = tools.filter((t) => t.pool === "mcp").length;
    const mcOn = tools.filter((t) => t.pool === "mcp" && t.enabled).length;
    ovSet("ov-pool", `技能 ${st} · MCP ${mcOn}/${mc}`);
  }
  if (skillsCache.length || c) {
    const preset = skillsCache.filter((s) => s.origin === "preset").length;
    ovSet("ov-skills", skillsCache.length
      ? `${skillsCache.length} 个（内置 ${preset} · 用户 ${skillsCache.length - preset}）`
      : "暂无技能");
  }
  const p = memData;
  if (p) {
    const ns = (p.sections ?? []).length, nn = (p.notes ?? []).length;
    const nd = Object.keys(p.domains ?? {}).length;
    ovSet("ov-mem", p.exists ? `${ns} 章节 · ${nn} 观察 · ${nd} 域` : "还没有画像");
    ovSet("ov-dom", p.current_domain ? p.current_domain : "未选域（只用全局）");
  }
}

// 点行跳页签：复用既有 tabs 的点击逻辑（不另写一套切换，避免两处状态不同步）
function ovGoto(tab) {
  const btn = [...document.querySelectorAll("#drawer .tabs button")].find((b) => b.dataset.tab === tab);
  if (btn) btn.click();
}

document.addEventListener("click", (e) => {
  const row = e.target.closest(".ov-row");
  if (row && row.dataset.goto) ovGoto(row.dataset.goto);
});
$("mem-reveal").onclick = () => reveal("config", null, "skill-flash");
