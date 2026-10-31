# 轮次协议 · Role Chain Protocol

> **状态：v0.1（P0）已实现、已安装、已自测。** 9 个工具全部注册（激活日志见下），状态机 21 条自测全过。**尚未验证的只有三件事**：真实会话里"角色看不见不该有的工具"是否成立、`chain_gate` 是否真的弹出卡片等人回答、客户端半身是否真的把 New Session 的预设控件收成一个 `plan` 标签——这三条都要重启后新开一个会话看，步骤见 [ACCEPTANCE.md](./ACCEPTANCE.md)。

一句话：把 `plan → work → code → work → review → work → plan` 这条角色链，从"靠提示词自觉"变成**可执行、可审计的轮次状态机**。

![角色链与一轮六步](../../assets/architecture.png)

---

## 它是什么

DSH 已经能声明四个角色（本仓库的 `plugins/l1-presets` 做到了：plan / work / code / review 各自的人设与工具集），但管不住**纪律**：T0 是不是唯一、失败到底重试了几次、证据是谁给的、这一轮花了多少、什么时候算关闭。这些在 L1 里全靠模型自觉加人眼检查，事后无法审计。

这个插件补的就是这一层。它不新增角色，也不改源码工具——它在四个角色上面加一层 `chain_*` 协议工具，把六步里"必须成立的事实"写进磁盘、卡在工具调用上。

## 它拦得住什么（已实现，且自测覆盖）

| 规则 | 怎么拦 | 自测 |
|---|---|---|
| 一轮只有一个 T0 | `chain_freeze_baseline` 第二次调用抛 `BASELINE_ALREADY_FROZEN`；插件自己跑 `git rev-parse HEAD` / `git status --porcelain`，不听模型自述 | ✅ |
| 证据必须绑本轮 T0 | 每条证据写入时自动打上本轮 `t0Id`；没有 T0 时写证据抛 `NO_BASELINE` | ✅ |
| 证据分层、不互相扩大 | 层与角色绑定：`command` / `artifact` 仅 work·code，`review` 仅 review，`self-report` 全部但标记为未独立验证 | ✅ |
| "同一个测试失败 3 次"是真的 3 次 | 按**失败签名**累计，不同签名互不影响 | ✅ |
| 计数越限就关不掉这一轮 | `chain_close_round` 六项校验；越限时找不到 `kind:'force'` 且被批准的门禁记录就拒绝 | ✅ |
| 需要用户拍板时真的等人 | `chain_gate` 走 `userQuestions.ask`，阻塞到人点选；子代理调用返回 `ESCALATE_TO_PARENT` | ✅ 逻辑 · ⏳ 卡片待你验证 |
| 交付结论是算出来的 | 版本 / 结果 / 未覆盖项 / 费用 / 服务已停 由插件校验并组装，通过后自动落 `.dsh/rounds/<roundId>.json` | ✅ |
| 关掉的轮不能改事实 | 已关闭轮次的写操作抛 `ROUND_CLOSED`；同一时间只能有一轮未关闭 | ✅ |

## 它拦不住什么（别指望它）

- **"实施要连续"**：插件不知道中途有没有换人，只能看证据时间线。
- **"修正要限定、不许顺手改别的"**：`chain_check_baseline` 能给出"相对 T0 脏/commit 变了"，但"这些改动是否都在工单范围内"要比对规则，属 P2。
- **"结论不能超出证据范围"**：分层保证不混层，"这条证据能支撑多大结论"仍要 review 自己写 `scope` / `uncovered`。
- **模型敷衍**：它把"没证据就关不了轮"变成硬约束，但不能让证据本身变真。
- **work 的只读是软的**：work 这个人设里有 shell，重定向照样能写文件（L1 遗留，见 §已知缺口）。

## 九个工具

| 工具 | 谁能调 | 干什么 |
|---|---|---|
| `chain_open_round` | plan | 开一轮，定目标与预算（token / 修正 / 重跑 / 重启） |
| `chain_freeze_baseline` | work | 冻结唯一 T0（插件自己跑 git） |
| `chain_check_baseline` | 全部 | 当前工作区 vs T0 的漂移（`clean` / `baseline-dirty` / `baseline-moved`） |
| `chain_record_failure` | work / code | 失败 / 修正 / 重跑 / 重启按签名计数，到上限即 `exceeded` |
| `chain_record_evidence` | 全部（分层限权） | 记一条证据，自动绑 T0 |
| `chain_gate` | 根角色 | 阻塞式问人，决策入库；子代理只得到 `ESCALATE_TO_PARENT` |
| `chain_close_round` | plan | 六项校验后关闭，产出结论与审计副本 |
| `chain_status` | 全部 | 只读看板：当前轮、T0、预算与计数、失败签名、证据、门禁 |
| `chain_export_audit` | plan | 把整轮导出成 `.dsh/rounds/<roundId>.json` |

## 六步怎么映射到工具

| 协议步骤 | 工具 |
|---|---|
| 1 核对基线 | `chain_status`（看有没有未关闭的轮）→ `chain_open_round` |
| 2 收敛方案与授权 | `chain_gate kind=scope`（要新权限/新预算时） |
| 3 连续实施（唯一 T0） | `chain_freeze_baseline` 一次 → `chain_record_evidence layer=command/artifact` |
| 4 限定修正 | `chain_record_failure` → 到上限时 `chain_gate kind=force` |
| 5 独立终审 | review 会话 `chain_record_evidence layer=review`（verdict + scope + uncovered） |
| 6 交付并关闭 | `chain_close_round` → 自动落审计文件 |

## 安装与前置

1. 先装本仓库的 `plugins/l1-presets`（四个 preset 就位：plan / work / code / review）。
2. 再装本 bundle：`plugin_manager install_bundle` 指向本目录，然后重载 Loader 或新开会话。
3. **必须新开会话**：preset 修订与工具集在会话创建时冻结。

已在本机验证：profile 里 `include:role-chain-protocol` → `enabled: true, fiberPhase: active`，激活日志：

```
[info] [role-chain] 9 个 chain_* 工具已注册 [host.kernel.role-chain-protocol] {"pluginId":"include:role-chain-protocol"}
```

## 新会话只有 plan（客户端半身）

`lib/client.js` 是浏览器半身，只干一件事：把 New Session 的预设控件换成静态 `plan` 标签。

为什么必须这么绕：`@deepseek-ai/dsh-agent-preset` 的 Config 只有 `id / name / description / order / plugins`，注册表的 `list()` 也把**每个**定义都列出来——没有任何"从选择器隐藏"的字段。唯一的合法杠杆是单槽位遮蔽：`conversation.hero.agentPreset` 是 `single` 槽位，同一优先级只能有一个占用者，**更低优先级会顶掉它**（slots 引擎的报错原文就写着 `register at a different priority to shadow it (lowest renders)`）。所以本模块以 `priority: -1` 注册。

配套的默认值在 L1 里：`plugins/l1-presets/cordis.patch.yml` 结尾用 `- id: agent-preset-registry` + `config: { default: plan }` 把宿主默认从 `standard` 换成 `plan`，于是新会话不依赖这个标签也会落在链路里。

要恢复官方的四选一：

1. 删掉 `package.json` 的 `dsh.client` 段（客户端半身不再加载），或
2. 在设置 → Agent presets 里改默认，单独开一个 work / review 会话——这条路是有意的出口，但那种会话是"根在错误角色上"，`chain_*` 仍会拒绝。

## 与设计的三处偏差（如实记录）

| 设计（DESIGN.md） | P0 实际 | 为什么 |
|---|---|---|
| 状态存 `dsh-storage-domain` | 存 `<cwd>/.dsh/rounds/state.json`（原子写：tmp + rename），每轮另落 `<roundId>.json` | profile 的 `zod` 是 3.25.76，而 `@deepseek-ai/dsh-storage-domain` 要求 zod 4.4.3；P0 不往 bundle 里塞第二份 zod。附带好处：权威副本与审计副本是同一份文件 |
| 4 个 preset 子行各注册本角色工具（结构性"看不见"） | **1 个全局行**注册 9 个工具，工具内部按角色拒绝（`ROLE_DENIED`） | §10.B / §10.C 未验证（子行工具是否 agent 作用域、能否 inject 宿主全局服务）。先保证"错的角色调用会被拒"，再谈"看不见" |
| 越限判定 `counters.* > limit` | `>= limit`（到上限即停，不是超一格才停） | "同一测试失败 3 次停下"指的是第 3 次就停 |

这三条都写进了 `DESIGN.md` §15。迁移路径：P1 换回 storageDomain（bundle 自带 zod 4）并把工具注册搬到 preset 子行。

## 已知缺口

1. **同轮并发**：状态文件按 cwd 单实例串行写，但两个会话同时开轮时后开的会被 `ROUND_ALREADY_OPEN` 拒绝——这是设计意图，不是 bug；真正缺的是"多会话共享同一轮"的看板刷新。
2. **费用**：`closeout.cost` 目前由调用方填（`tokenMeter` 自动累加属 P2），支持 `costOverride` 人工覆盖并标 `estimate:false`。
3. **崩溃恢复**：状态在磁盘上，进程重启后 `chain_status` 能读回；但"进行中的工具调用"没有事务，最坏情况是某条证据没落盘——重记一次即可。
4. **非 git 项目**：T0 记 `mode:'no-git'`，`version.commit` 写 `"(no-git)"`；文件哈希清单属 P2。
5. **work 的只读是软的**（见上）。
6. **preset 不能中途换**：一轮里想改角色纪律，只能新开会话。

## 文件

```
package.json          # dsh-role-chain-protocol 0.1.0, dsh.bundle.patch
cordis.patch.yml      # 1 个全局行 role-chain-protocol
lib/index.js          # 插件入口：inject ['tools']，注册 9 个工具，ctx.effect 释放
lib/roles.js          # 角色判定：SessionHeader.agentPreset / composedPreset / 是否根 / cwd
lib/service.js        # 状态机全部逻辑（开轮/T0/计数/证据/门禁/关闭/看板）
lib/store.js          # 原子 JSON 状态存储，按 cwd 单实例
lib/tools.js          # 9 个工具定义 + 角色拒绝
lib/client.js         # 浏览器半身：New Session 的预设控件换成静态 plan 标签
test/smoke.mjs        # 无宿主自测：21 条断言，node test/smoke.mjs
DESIGN.md             # 接口骨架 + §15 实施记录
ACCEPTANCE.md         # 30 秒验收清单
```

## 关键词

`deepseek-harness` `dsh` `cordis` `plugin` `workflow` `round` `audit` `subagent` `role-chain`
