# Tasks：工具层缺陷收敛

> 上游 spec：`specs/tool-improvements/spec.md`
> 前置：`specs/tool-call-integrity`（已落地并回归通过）
> 并列：`specs/call-efficiency`（D2 是它的 §E2 观测缺口的日常巡检工具）

## 阶段 A：提示词层（可自改，已落地）

- [x] A1 `SYSTEM.md` 增「bash 单行铁律」（多行只执行首行 + `&&`/`&` 串联 + 写文件用 write_file）
- [x] A2 `SYSTEM.md` 增「中间物不进产物目录」（先用专用工具取事实 / 确需脚本落 `.scratch/` / outputs 只放成品）
- [x] A3 `.gitignore` 增 `.scratch/`（**不**忽略 `outputs/`——交付物要入库）
- [x] A4 `SYSTEM.md` 自扩展表格修正：`plugins/tools` 顶层在 rsi-agent 布局下**不可达**
      （`files.py:43` 的 `runtime` 整树禁写），避免继续指引模型走死路

## 阶段 B：技能层（可自改，已落地）——消掉「必须写脚本」的驱动力

- [x] B1 新建 `skills/trace-analysis/SKILL.md`（origin: user，frontmatter 合规）
- [x] B2 新建 `skills/trace-analysis/trace_query.py`：6 个子命令
      （summary / toolmix / writes / errors / multiline / calls），只读、流式、容错
- [x] B3 `--trace` 三形态解析（会话 id / 路径 / `--latest` 或缺省取最新）+ 不可达返回 `TRACE_NOT_FOUND` 而非 traceback
- [x] B4 实测：`conformance_gate.py --skill skills/trace-analysis` → `ok: true`，0 error 0 warning
- [x] B5 实测：6 个子命令对本会话 trace 全部跑通（见下方「实测记录」）
- [x] B6 ~~刻意不带 tools.json~~ → **B6'（第二轮推翻）**：补 tools.json + exec_query.py 执行器，
      `trace_query_tool` 走 skill_install 正规通道（含 BAD_SUB 白名单与 shlex 解析）
- [x] B7 新增 `substitutability` 子命令：bash 可替代率量化（python -m 口径豁免）
- [x] B8 `--smoke` 冒烟通过（`{"args":{}}` → ok:true）

## 阶段 C：核心层（**需用户授权 / ALLOW_CORE_WRITE=1**，本轮只出补丁）

- [ ] C1 `runtime/plugins/tools/tools/bash.py::_run_bash` 加多行 fail-loud（`MULTILINE_UNSUPPORTED`）
- [ ] C2 `runtime/crates/agent-loop/src/skills.rs:80-83` 产物段补「中间物不是产物」反向约定
- [ ] C3 `runtime/crates/host/web-dist/index.html:122` `max="64"` → `max="10000"`
- [ ] C5（第二轮新增）`bash.py::_description` 两个分支加「单行约束 + 专用工具优先」引导（P4a/P4b）
- [ ] C4 三处改完后 `cargo test` 全绿 + **重启宿主**再复测（否则测的是旧二进制）

## 阶段 D：实例快照同步（第二轮：已裁决）

- [x] D1 `runtime/.instances/1102/config.json` 是建实例时快照（max_rounds=1000 / budget_secs=900），
      主配置改动不回灌（`instances.rs` 只在首建时复制）；该实例已掉线（pid 37204 不存在）。
      **用户裁决：删除重建** → 已删除（`runtime/.instances/` 现仅剩 `.last-workspace`）
- [x] D2（用户裁决）`budget_secs=0` 暂不兜底——唯一刹车是 max_rounds=2000，用户知情接受

## 阶段 E：验收

- [x] E1 P：`python -m pytest tests/ -q` → 18 passed（基线保持）
- [x] E2 P：`conformance_gate.py --skill skills/trace-analysis` → ok
- [x] E3 Q：`trace_query.py` 空文件 / 非法 session / 正常 trace 三种输入均不崩
- [ ] E4 Q：D1 修复后 `bash "echo A\necho B"` → `MULTILINE_UNSUPPORTED`（不是 `exit_code:0`+只有 A）
- [ ] E5 Q：D2 修复后新 chat 的 `file_change` 中 `outputs/` 占比为 0（用 `trace_query.py writes` 复查）
- [ ] E6 I：既有 64 项 Rust 测试全绿（C1/C2 后）
- [ ] E7 重启宿主后复测

## 实测记录（本轮，可复现）

D1 根因链（`bash.py:223` 单 argv → `sandbox-run.rs:22` join → `sandbox-run.rs:96` `cmd.exe /c {command}`
→ cmd 只取首行）：

| 输入 | 输出 |
|---|---|
| `echo A\necho B` | `A` |
| `echo A && echo B` | `A` `B` |
| `python -c "print(1)\nprint(2)"` | （空） |
| `python -c "import sys;print('A');print('B')"` | `A` `B` |
| `subprocess.run(['cmd','/c','echo A\necho B'])` | `'A\n'`（直跑 `shell=True` 同） |

本会话 trace 量化（`trace_query.py`）：

- `toolmix`：403 次调用，bash 280（69.5%），read_file 45、grep 38、write_file 25、edit_file 10
- `bash_first_token`：python 86、chcp 62、powershell 38、findstr 36、dir 21、git 11
- `multiline`：**40 次** bash 含换行（占 bash 14.3%）——全部是静默截断候选
- `writes`：37 次落盘，`outputs` **17 次**（46%），`(root)` 12、specs 5、skills 2、.scratch 1
- `summary`：3 轮 chat 全部 `stopped_by=deadline`（rounds 64/41/45）

## 验收（第二轮追加，对应 spec §7）

- [x] F1 P：`conformance_gate.py --skill skills/trace-analysis --smoke` → ok:true，tools_declared=1
- [x] F2 Q：`substitutability` 实测 = bash 449 中 379 可替代（84.4%）
- [x] F3 P：`apply-tool-patches.py --dry-run` → P1/P2/P3/P4a/P4b 五锚点全命中
- [ ] F4 I：C 类补丁应用 + 重启后，`pytest`/`cargo test` 全绿
- [ ] F5 Q（核心验收）：**下一轮会话** `substitutability` 中 findstr/dir/type/cat/ls/echo 桶 → 0；
      python -c 桶只剩确有必要的内联；chcp 桶 → 0

## 迭代记录

- 2026-11-03：立项。三条缺陷（D1 多行截断 / D2 成因A复发 / D3 通道文档不符）均为本会话**直接触发**
  并留证；D4（面板 max=64）为配置核查顺带发现。阶段 A/B 已落地，C/D 待授权。
- 2026-11-03（第二轮）：用户裁决实例 1102 删除重建（已删）、budget_secs=0 暂不兜底；完成四家
  （opencode/codex/pi/dsh）工具层调研 → spec §7；trace-analysis 升级为带工具技能（B6'/B7/B8）；
  SYSTEM.md 增「专用工具优先」纪律；补丁脚本增 P4a/P4b（bash 工具描述引导），dry-run 五锚点全过。
- 2026-11-03（第三轮）：用户指正补丁脚本位置 → 迁 `outputs/` 至 `scripts/apply-tool-patches.py`
  （工程资产与运维脚本同列），outputs 清空；删根目录 262KB 遗留 dump `ocpaths.json`；
  `.gitignore` 增 `*.patchbak`；spec §7.4 记录生效时机探查结论（SYSTEM.md 免重启 /
  技能工具启用免重启但装载需会话触发 / C 类补丁必须重启）。
  本轮新坑：`bash` 多行命令再次被静默截断（echo 写文件全丢）——D1 现象第 3 次复现，
  P1 补丁的紧迫性再加一档。
- 2026-11-03（第四轮）：用户发起架构反思（rsi-agent 是否该按自身发展改工具层）→ 按 project-dev
  优化模式裁决，结论落 spec §8：底座（kernel/agent-loop 骨架）照搬不动；该长自己的四项——
  A 闸改按前缀授权（布尔全有全无 → 路径列表，config/memory 永不豁免）、B 死途径文案收口、
  C bash P1/P4 缺陷修复（等 allow_core_write 授权）、D 适配重放机制化（apply-tool-patches.py
  升格为差异集重放工具，未来收编 README 现存 4 处适配）。自我修正一处：§7.4「授权后删补丁
  脚本」作废——改源码后 P1/P4 即是适配第 5/6 处，脚本 = 下次同步的还原态，必须保留。
