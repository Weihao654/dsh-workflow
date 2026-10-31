# 验收清单 · ACCEPTANCE

分两部分：**我已经替你验证的**（有命令输出为证），和**只有你能做的**（要在真实会话里点一下）。

---

## 一、已自动验证（可复跑）

| # | 项 | 命令 | 结果 |
|---|---|---|---|
| 1 | 源文件语法（7 个） | `node --check lib/*.js` | 全部 ok |
| 2 | 状态机全流程 | `node test/smoke.mjs` | **21 passed, 0 failed** |
| 3 | 角色→模型路由 | `node test/routes.mjs` | **34 passed, 0 failed** |
| 4 | bundle 安装 | `plugin_manager install_bundle` | `stage: enable, changed: true, application: applied`，pnpm exit 0 |
| 5 | 插件行激活 | `plugin_manager list_plugins` | `include:role-chain-protocol` → `enabled: true, fiberPhase: "active"` |
| 6 | 工具真的注册了 | `~/.dsh/logs/desktop-next.log` | `[role-chain] 9 个 chain_* 工具已注册`，`pluginId: include:role-chain-protocol` |

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

前提：已装 `plugins/l1-presets` + 本插件，并**新开一个会话**（preset 在会话创建时冻结）。

### 第 1 步：角色看得见什么（§10.B）

新会话 → preset 选 **`plan`** → 输入 `/` 或直接看工具列表，确认：

- [ ] 能看见 `chain_status`、`chain_open_round`、`chain_close_round`、`chain_gate`（9 个都在）
- [ ] `write` / `edit` **不在**（plan 是只读人设）
- [ ] `dispatch_work` 在（派发工具）

再开一个 **`review`** 会话：

- [ ] 有 `chain_record_evidence`、`chain_status`
- [ ] 没有 shell（`pwsh` / `bash` 都不在）

### 第 2 步：错的角色会被拒（不是"看不见"）

在 **code** 会话里让模型调一次 `chain_open_round`（只有 plan 能开）：

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

### 第 4 步：角色→模型真的换了模型（新增，约 2 分钟）

前提：**重启一次 DSH**（宿主监听器与客户端半身都在启动时装载），然后在**你的项目目录**建 `.dsh/role-chain.json`：

```json
{ "roleModels": { "plan": { "provider": "deepseek-account", "model": "deepseek-flash" } } }
```

- [ ] 新开 plan 会话，问一句让它调 `chain_status`：`roleModels.exists === true`、`roles.plan` 是你写的值、`thisSession.applied` 与之一致
- [ ] 在输入框**手动**把模型换成别的，再问一轮：`thisSession.manual` 变成 `true`，模型不再被改回
- [ ] 故意把 `model` 写错一个字母：对话仍能继续，`roleModels.errors` 里出现 `解析失败` 或该角色被跳过

### 第 5 步：新建菜单只有自带的那几项 + plan（新增）

- [ ] 新建会话的预设菜单里**还在**的：DSH 自带的 `standard` / `ptc` / `minimal` / `cordis`（以你机器为准）+ `plan`
- [ ] 菜单里**看不到**：`work` / `code` / `review`
- [ ] Settings → Agent Presets 页里它们仍在（被过滤的只是新建菜单，不是注册表）

> 若第 5 步菜单里仍然出现 work/code/review，说明客户端过滤没装上（失败开放）。这不会影响功能，只是回到装之前的样子；把菜单截图给我，我改包装点。

### 第 6 步：一轮完整跑通（可选，5 分钟）

plan 会话里让它按顺序来：`chain_open_round` → 派 work 会话 `chain_freeze_baseline` → code 写一条 `chain_record_evidence layer=command` → review 写一条 `layer=review` → `chain_close_round`。

- [ ] 关闭成功，输出里有"版本 / 结果 / 未覆盖项 / 费用 / 审计副本"
- [ ] 项目目录下出现 `.dsh/rounds/<roundId>.json`，内容含 `baseline` / `evidence` / `gates`

---

## 三、判定标准

- 第 1、2、3 步全绿 → **P0 验收通过**（工具可见性符合 P0 设计，门禁为人机交替可用）。
- 第 4、5 步是新加的两条（角色→模型、新建菜单过滤），它们失败不影响 P0 状态机：路由失败只是模型没换；菜单过滤失败只是多显示三个选项。
- 第 1 步发现 plan 会话能看见 `write` → L1 的 preset 工具矩阵没生效，要先修 L1。
- 第 3 步弹不出卡片或一直等到超时 → `userQuestions.ask` 的请求形状要按真实契约修正（`lib/service.js` 的 `askGate`），这是唯一预期需要回改的地方。
- 第 4 步关闭被拒 → 看错误里的 `problems` 列表，它就是六项校验的缺口清单。
