# deepseek-paper：把 5 个文件的改动同步回兄弟源仓库

## 为什么需要这一步

`skills/deepseek-paper/` 是**部署副本**（运行时加载的就是它），但 `scripts/sync_skills.py`
规定源仓库在兄弟目录 `D:\ZH\vibe code\skills\tool\deepseek-paper`，方向是
**源仓库 → 部署副本**。我按工作区约束没有写工作区外的路径，所以本轮改动的 5 个文件
在部署副本里是新的、在源仓库里是旧的，`test_skill_sync` 因此报 `E_DRIFT`。

## 改动清单（5 个文件）

| 文件 | 改了什么 |
|---|---|
| `SKILL.md` | 门禁数量 `G1–G12` → `G1–G14`（3 处） |
| `evals/rubric.md` | 门禁数量同步；「图表规范」维度加上「误差棒注明 s.d./s.e.m. 并给 n」 |
| `references/05-图表规范.md` | 新增 §5.6「从 Nature 借来的四条」（+43 行） |
| `tools/paper_lint.py` | 新增 G13（统计口径声明）/ G14（图注必给 n） |
| `tools/paper_figure.py` | 新增 `style.palette="colorblind"`（Wong 8 色板）+ 默认 dpi 200→300 |

## 怎么做（三种，任选）

### 方式 A：用仓内脚本（推荐，需先临时改方向）

`sync_skills.py` 只有「源→部署」一个方向。想反向同步，最省事的是把 5 个文件
从部署副本复制过去：

```bat
cd /d "D:\ZH\vibe code\skills\tool\rsi-agent"
for %f in (SKILL.md evals\rubric.md references\05-图表规范.md tools\paper_lint.py tools\paper_figure.py) do @copy /Y "skills\deepseek-paper\%f" "..\deepseek-paper\%f"
```

然后验证：

```bat
python scripts/sync_skills.py --check --skill deepseek-paper
```

期望输出 `"ok": true`。

### 方式 B：先改源仓库，再用脚本同步回来（更符合项目设计意图）

如果你认为**源仓库才是正本**，那么正确做法是反向操作：先在
`D:\ZH\vibe code\skills\tool\deepseek-paper` 里做同样 5 处改动，然后

```bat
cd /d "D:\ZH\vibe code\skills\tool\rsi-agent"
python scripts/sync_skills.py --sync --skill deepseek-paper --write
```

这次是源→部署，方向天然正确。

### 方式 C：接受这份漂移（如果近期不打算维护源仓库）

在该测试里把 deepseek-paper 加进跳过名单，或删掉 `SOURCE_MAP` 里那一项。
**不推荐**：那等于放弃「源仓库与部署副本一致」这条契约，以后漂移不会再被发现。

## 改完的验证

```bat
cd /d "D:\ZH\vibe code\skills\tool\rsi-agent"
python -m pytest tests -q
```

期望 **289 passed**（当前 287 passed + 2 个因漂移失败的用例转绿，其中
`test_registered_skills_have_no_drift` 转绿；另一个是 `test_board_contract` 已修好）。
