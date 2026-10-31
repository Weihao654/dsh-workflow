# 验收清单 · ACCEPTANCE

分两部分：**我已经替你验证的**（有命令输出为证），和**只有你能做的**（要在真实会话里点一下）。

---

## 一、已自动验证（可复跑）

| # | 项 | 命令 | 结果 |
|---|---|---|---|
| 1 | 五个源文件语法 | `node --check lib/*.js` | 全部 ok |
| 2 | 状态机全流程 | `node test/smoke.mjs` | **21 passed, 0 failed** |
| 3 | bundle 安装 | `plugin_manager install_bundle` | `stage: enable, changed: true, application: applied`，pnpm exit 0 |
| 4 | 插件行激活 | `plugin_manager list_plugins` | `include:role-chain-protocol` → `enabled: true, fiberPhase: "active"` |
| 5 | 工具真的注册了 | `~/.dsh/logs/desktop-next.log` | `[role-chain] 9 个 chain_* 工具已注册`，`pluginId: include:role-chain-protocol` |

自测覆盖的 8 组（`test/smoke.mjs`）：

1. 开轮 + 重复开轮被拒
2. T0 唯一：先写证据被拒（`NO_BASELINE`）、冻两次被拒（`BASELINE_ALREADY_FROZEN`）
3. 分层证据：证据自动绑 `t0Id`、work 写 review 层被拒（`EVIDENCE_LAYER_MISMATCH`）、review 层缺字段被拒（`BAD_ARGS`）
4. 计数：同签名第 3 次 → `exceeded: 'test'`；不同签名不继承计数
5. 越限时关闭被拒（`CLOSEOUT_REJECTED`，理由里点出缺 force 门禁）
6. 门禁：子代理 → `ESCALATE_TO_PARENT`；根 agent → 记下"批准"决策
7. 关闭成功：结论含版本/结果/未覆盖项/费用，并写出 `.dsh/rounds/<roundId>.json`
8. 关闭后看板：`closedAt` 有值、`activeRoundId` 变 null

---

## 二、需要你在真实会话里做（约 30 秒）

前提：已装 `plugins/l1-presets` + 本插件，并**重启 DSH 后新开一个会话**（preset 在会话创建时冻结）。

### 第 1 步：入口只剩 plan，角色看得见什么（§10.B）

新会话页面 → 预设控件应当只剩一个 **`plan`** 标签（四个选项的菜单不再出现）。直接开会话，然后：

- [ ] 能看见 `chain_status`、`chain_open_round`、`chain_close_round`、`chain_gate`（9 个都在）
- [ ] `write` / `edit` **不在**（plan 是只读人设）
- [ ] `dispatch_work` 在（派发工具）

`review` 是只读审计员，单独用最划算，但它现在是"非默认角色"，要单独开需两步：设置 → Agent presets 把默认改成 `review`，再新开会话。那会：

- [ ] 有 `chain_record_evidence`、`chain_status`
- [ ] 没有 shell（`pwsh` / `bash` 都不在）

看完记得把默认改回 `plan`。

### 第 2 步：错的角色会被拒（不是"看不见"）

在 **plan** 会话里让它 `dispatch_code` 派一个 code 子代理，再让这个子代理调一次 `chain_open_round`（只有 plan 能开）：

- [ ] 返回 `ROLE_DENIED: chain_open_round 只给 plan，当前角色是 code。`

这一步正是 P0 与设计的差别：现在是"调了会拒"，不是"看不见"。若第 1 步里 plan 会话能看见全部 9 个工具，说明挂载是全局的——符合 P0 预期。

### 第 3 步：门禁真的会等人（§10.A）

在 **plan** 会话里让模型调用：

```
chain_gate(kind: "accept", question: "门禁测试：这条链路能继续吗？", options: [{label:"能"},{label:"不能"}])
```

- [ ] **界面弹出选项卡**，且不点它就一直阻塞
- [ ] 点"能"后，返回值里 `gate.decision === "能"`、`gate.approved === true`
- [ ] 再调 `chain_status`，`gates` 里能看到这条记录

> 这一步是这个插件唯一无法离线验证的硬点：`userQuestions.ask` 的行为依赖真实 UI。

### 第 4 步：一轮完整跑通（可选，5 分钟）

plan 会话里让它按顺序来：`chain_open_round` → 派 work 会话 `chain_freeze_baseline` → code 写一条 `chain_record_evidence layer=command` → review 写一条 `layer=review` → `chain_close_round`。

- [ ] 关闭成功，输出里有"版本 / 结果 / 未覆盖项 / 费用 / 审计副本"
- [ ] 项目目录下出现 `.dsh/rounds/<roundId>.json`，内容含 `baseline` / `evidence` / `gates`

---

## 三、判定标准

- 第 1、2、3 步全绿 → **P0 验收通过**（工具可见性符合 P0 设计，门禁为人机交替可用）。
- 第 1 步发现 plan 会话能看见 `write` → L1 的 preset 工具矩阵没生效，要先修 L1。
- 第 3 步弹不出卡片或一直等到超时 → `userQuestions.ask` 的请求形状要按真实契约修正（`lib/service.js` 的 `askGate`），这是唯一预期需要回改的地方。
- 第 4 步关闭被拒 → 看错误里的 `problems` 列表，它就是六项校验的缺口清单。
