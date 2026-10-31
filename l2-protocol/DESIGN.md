# L2 轮次协议插件 · 接口骨架 v0.1（待评审）

状态：**§1–§14 是设计稿；P0 已实现并安装，实施记录与三处偏差见 §15。** 先读 §15 再读前面的设计，能看出哪里照做了、哪里改了。

---

## 0. 这份文档要解决的问题

L1（本仓库 `l1-presets/`，已装）只做到了"四个角色能被选出来，各带不同的工具集"。
它管不住的是**纪律**：T0 是不是唯一、失败到底重试了几次、证据是谁给的、这一轮花了多少、什么时候算关闭。
这些全部靠提示词 + 人眼检查，不可审计。

L2 要做的是把这六步变成**可执行、可审计的状态机**，而不是再写一遍更长的提示词。

判定标准（用来验收 L2 是否值得做）：

- 一个角色**做不出的动作**，是因为它**没有那个工具**，而不是因为它被提示词劝住了。
- 一轮的结论（版本 / 结果 / 未覆盖项 / 费用）是**工具算出来的**，不是模型打出来的。
- 事后能回答"第 3 轮为什么重跑了 2 次、谁下的令、花了多少 token"，**只靠存储**，不靠聊天记录。

---

## 1. 三条已验证的硬约束（它们决定了架构）

这三条不是设计偏好，是读了 Host 服务契约之后必须接受的事实。

### 1.1 门禁只能由"根 agent"发起

`ctx.userQuestions.ask()` 在调用者被别的 agent 持有时抛 `DELEGATED_CALLER`。
work / code / review 都是 plan spawn 出来的子代理 → **它们没有人类通道**，问人只会抛错，不会等人。

结论：链路里唯一能弹卡片的是 **plan**（根）。work 需要用户拍板时必须**上交**，不能自己问。
推论：L1 里给 `preset-work` 挂了 `tool-ask-user`，在方式 B（work 自己是根）下是对的，在链路里会抛 `DELEGATED_CALLER` —— L2 要么把这条从 work 摘掉，要么接受"报错即上交"。

### 1.2 存储域同名只能开一次

`ctx.storageDomain.open({name})` 对已打开的名字抛 `already-open`。
若把协议插件塞进四个 preset 各挂一份 → 四份都想开 `role-chain` → 三份失败。

结论：**状态存储必须在全局只有一个实例**，四个角色共享它。

### 1.3 工具可见性由挂载位置决定，不由提示词决定

`ctx.tools.register()` 会把工具注册进"全局"或"调用者 agent 作用域"。preset 子行是在该 agent 的 ctx 里加载的，所以理论上注册出来的是**这个角色专属**的工具集 —— 这正是我们要的"没有那个工具"。

⚠️ 未验证：preset 子行注册的工具是否真的只对那个 agent 可见（见 §10）。

---

## 2. 包与文件结构

一个 bundle，一条 patch，两类 row：

```
l2-protocol/
  package.json                      # @local/dsh-role-chain-protocol, dsh.bundle.patch -> ./cordis.patch.yml
  cordis.patch.yml                  # 1 个全局 store row + 4 个 preset 子行注入
  lib/
    index.js                        # 全局 row: 开 domain, 注册 roleChain 服务
    service.js                      # RoleChainService 实现（状态机全部逻辑）
    domain.js                       # defineDomain 的 spec + zod schema
    roles.js                        # 角色判定：composedPreset / session header / 是否根
    tools/
      index.js                      # 按角色注册工具集的工厂
      round-open.js                 # 8 个工具，每个一个文件
      baseline-freeze.js
      baseline-check.js
      record-failure.js
      record-evidence.js
      gate.js
      close-round.js
      round-status.js
    audit.js                        # 轮次导出成 JSON / MD
  DESIGN.md                         # 本文件
```

## 3. Cordis 组合

```yaml
# cordis.patch.yml（骨架，不是最终写法）
insert:
  - id: role-chain-store            # 全局唯一实例
    name: '@local/dsh-role-chain-protocol'
    config:
      domain: role-chain
      limits: { testFailures: 3, reruns: 2, restarts: 3 }
```

四个 preset 各加一行**只读消费者**，不提供 service，只 `inject: [roleChain]` 然后注册本角色工具：

```yaml
  - id: preset-plan                 # 已存在，patch 里用 insert 进 group 的方式追加
    ...
    plugins:
      - name: '@local/dsh-role-chain-protocol/tools'
        inject: [roleChain]
        config: { role: plan }
```

风险点：如果 Loader 对 preset 子行做了 `isolate`，宿主全局的 `roleChain` 会被遮住。备选方案见 §10.F。

---

## 4. 状态模型

```ts
// domain: 'role-chain', version: 1, layout: 'per-record'
global: {
  activeRoundId?: string
  nextSeq: number
}

tables: {
  // 一轮的全部事实
  rounds: Record<RoundId, RoundRecord>

  // 每条证据一行，便于按层查询
  evidence: Record<`${RoundId}#${number}`, EvidenceRecord>

  // 门禁问答历史
  gates: Record<`${RoundId}#${number}`, GateRecord>

  // 按失败签名累计（"同一个测试第 3 次失败"要靠它）
  failures: Record<`${RoundId}#${string}`, FailureCounter>
}

interface RoundRecord {
  id: RoundId
  goal: string
  openedAt: number
  openedBy: { sessionId: string; agentPreset?: string }
  budget: Budget                    // tokens / fixes / reruns / restarts
  baseline?: BaselineRecord         // 唯一 T0；一旦写入不可改
  counters: { fixes: number; reruns: number; restarts: number }
  closeout?: Closeout
  closedAt?: number
}

interface BaselineRecord {
  t0Id: string
  commit: string | null       // git rev-parse HEAD；非 git 项目为 null
  dirty: boolean              // git status --porcelain 非空
  hashManifest?: Record<string, string>  // 非 git 项目的退化方案
  frozenAt: number
  frozenBySession: string
}

interface EvidenceRecord {
  id: string
  roundId: RoundId
  t0Id: string                // 必须等于本轮 baseline.t0Id
  layer: 'command' | 'artifact' | 'self-report' | 'review'
  authorRole: 'plan' | 'work' | 'code' | 'review'
  authorSession: string
  at: number
  payload: CommandEvidence | ArtifactEvidence | SelfReportEvidence | ReviewEvidence
}

interface Closeout {
  version: { commit: string | null; tag?: string; artifact?: string }
  result: 'delivered' | 'partial' | 'blocked'
  uncovered: string[]          // 未覆盖项，必须非空（哪怕写"无"）
  cost: { tokens: number; estimate: boolean; note?: string }
  servicesStopped: boolean
}
```

### 为什么 failures 单独一张表

"同一个测试失败 3 次"必须按**签名**计数，不能只按总数。签名由调用方给（例如 `pytest::test_login`），插件只负责累计与越限判定。
`counters.fixes/reruns/restarts` 是"轮级"的总数，用于"2 次全量重跑 / 3 次服务重启"这类上限。

---

## 5. 服务接口（给四个角色的工具用，也是 review 的只读入口）

```ts
interface RoleChainService {
  openRound(input: {
    goal: string
    budget: Partial<Budget>
    exec: RoleExec                    // 谁在调
  }): Promise<RoundRecord>

  freezeBaseline(input: {
    roundId: RoundId
    exec: RoleExec
  }): Promise<BaselineRecord>         // 已冻结 → 抛 BASELINE_ALREADY_FROZEN

  checkBaseline(input: {
    roundId: RoundId
  }): Promise<{
    drift: boolean
    commitChanged: boolean
    changedFiles: string[]
    t0Id: string
  }>

  recordFailure(input: {
    roundId: RoundId
    kind: 'test' | 'rerun' | 'restart'
    signature: string                 // test 必填；rerun/restart 用 'full'
    detail?: string
    exec: RoleExec
  }): Promise<{
    signatureCount: number
    totals: RoundRecord['counters']
    limits: Limits
    exceeded: null | 'test' | 'rerun' | 'restart'
  }>

  recordEvidence(input: {
    roundId: RoundId
    layer: EvidenceRecord['layer']
    payload: unknown
    exec: RoleExec
  }): Promise<EvidenceRecord>         // 层与角色不匹配 → 抛 EVIDENCE_LAYER_MISMATCH

  askGate(input: {
    roundId: RoundId
    kind: 'scope' | 'budget' | 'rule' | 'accept' | 'force'
    question: string
    detail?: string
    options?: { label: string; description?: string }[]
    exec: RoleExec
  }): Promise<GateRecord>             // 非根 → 抛 ESCALATE_TO_PARENT

  closeRound(input: {
    roundId: RoundId
    closeout: Closeout
    exec: RoleExec
  }): Promise<{ closed: true; summary: string; gates: number; evidence: number }>
                                      // 校验不过 → 抛结构化错误，见 §7

  status(input: { roundId?: RoundId }): Promise<RoundStatus>
  exportAudit(input: { roundId: RoundId; path: string }): Promise<{ bytes: number }>
}

interface RoleExec {
  sessionId: string
  agentPreset?: string
  isRoot: boolean                     // 由 header.parentSession / delegationDepth 判定
  parentSession?: string
}
```

`RoleExec` 由工具层从 `ToolExecutionInput`（含 `agent` / `parent`）与 `SessionHeader`（`agentPreset` / `parentSession` / `delegationDepth`）组装，**不信任模型自述的角色**。

---

## 6. 工具契约

工具名带前缀 `chain_`，避免与既有工具撞名。

| 工具 | plan | work | code | review | 一句话 |
|---|---|---|---|---|---|
| `chain_open_round` | ✅ | — | — | — | 开一轮，定目标与预算 |
| `chain_freeze_baseline` | — | ✅ | — | — | 冻结唯一 T0（插件自己跑 git） |
| `chain_check_baseline` | ✅ | ✅ | ✅ | ✅ | 当前工作区 vs T0 的漂移 |
| `chain_record_failure` | — | ✅ | ✅ | — | 失败/重试/重启累计计数 |
| `chain_record_evidence` | ✅ | ✅ | ✅ | ✅ | 记一条分层证据 |
| `chain_gate` | ✅ | — | — | — | 阻塞式问人（仅根） |
| `chain_close_round` | ✅ | — | — | — | 校验后关闭，产出结论 |
| `chain_status` | ✅ | ✅ | ✅ | ✅ | 只读看板 |
| `chain_export_audit` | ✅ | — | — | — | 导出审计文件 |

### 各工具的参数与返回（骨架）

**`chain_open_round`**
- 入：`goal: string`；`budget?: { tokens?, fixes?, reruns?, restarts? }`
- 出：`{ roundId, openedAt, budget }`
- 校验：已有 activeRound 且未关闭 → 抛 `ROUND_ALREADY_OPEN`（必须先 close）

**`chain_freeze_baseline`**
- 入：`roundId`；`mode?: 'git' | 'hash'`
- 插件动作：`ctx.subprocess.spawn(['git','rev-parse','HEAD'])` + `git status --porcelain`；非 git 项目退化为文件哈希清单
- 出：`BaselineRecord`
- 校验：已有 baseline → 抛 `BASELINE_ALREADY_FROZEN`（这就是"唯一 T0"）

**`chain_record_failure`**
- 入：`roundId`；`kind`；`signature`；`detail?`
- 出：`{ signatureCount, totals, limits, exceeded }`
- 语义：`exceeded` 非空时**不阻断记录**，但会让 `close_round` 拒绝，除非存在一条 `kind:'force'` 的 gate 记录

**`chain_record_evidence`**
- 入：`roundId`；`layer`；`payload`
- 层与角色绑定：

| layer | 谁能写 | payload 必填 |
|---|---|---|
| `command` | work / code | `command`, `exitCode`, `outputDigest`（不存全文，存摘要 + 会话 id） |
| `artifact` | work / code | `path`, `bytes`, `sha256` |
| `self-report` | 任意 | `text`，明确标记"未经独立验证" |
| `review` | 仅 review | `verdict: 'pass'|'fail'|'partial'`, `scope: string[]`, `uncovered: string[]` |

**`chain_gate`**
- 入：`roundId`；`kind`；`question`；`detail?`；`options?`
- 内部：`ctx.userQuestions.ask({ questions: [...], agent: exec.agent })` 阻塞等人
- 出：`{ gateId, decision: string, answeredAt }`
- 非根：返回结构化错误 `{ code: 'ESCALATE_TO_PARENT', hint: '把问题带回 plan' }`，**不抛 DELEGATED_CALLER**

**`chain_close_round`** — 校验清单，任一不过即拒绝并列出缺什么：
1. `baseline` 存在
2. 每个 `counters.* > limit` 都有对应的 `force` gate
3. 至少 1 条 `command` 证据 + 1 条 `review` 证据
4. `closeout.uncovered` 存在（可为 `["无"]`）
5. `closeout.servicesStopped === true`
6. `closeout.version.commit` 与 `baseline.commit` 的关系已被 `checkBaseline` 记录
- 出：`{ closed, summary, gates, evidence }`
- `summary` 是给人看的定稿文本：版本 / 结果 / 未覆盖项 / 费用 / 停服确认

---

## 7. 六步 → 工具映射

| 步骤 | 谁做 | 工具 | 结构性保障 |
|---|---|---|---|
| ① 核对基线 | work | `chain_check_baseline` | 无 T0 时返回 `NO_BASELINE`，必须先 freeze |
| ② 收敛方案与授权 | plan | `chain_gate('scope'/'rule')` | 仅根可问人；决策入库 |
| ③ 连续实施（唯一 T0） | work / code | 无（正常干活）+ `chain_record_evidence` | 证据必须绑定 `t0Id` |
| ④ 限定修正 | work | `chain_record_failure` | 按签名计数；越限 → close 拒绝 |
| ⑤ 独立终审 | review | `chain_record_evidence('review')` + `chain_status` | 只有 review 能写 `review` 层 |
| ⑥ 交付并关闭 | plan | `chain_close_round` | 六项校验；结论由插件生成 |

---

## 8. 强制点：哪些是真拦，哪些只是记账

| 强制点 | 强度 | 说明 |
|---|---|---|
| 角色没有该工具 | **结构性** | 挂载位置决定，模型无法绕过（待 §10.F 验证） |
| review 不能改产品 | **结构性** | L1 已成立：无 write/edit，无 shell |
| T0 唯一 | **结构性** | 第二次 freeze 直接抛错 |
| 证据必须绑 T0 | **结构性** | t0Id 不匹配 → 拒绝写入 |
| 证据层与角色绑定 | **结构性** | review 层只有 review 能写 |
| 门禁只有根能开 | **结构性** | `DELEGATED_CALLER` 是运行时事实，不是约定 |
| 计数越限 → 关不掉 | **结构性** | close 校验，除非有 force gate |
| 结论字段齐全 | **结构性** | close 校验 |
| "证据是分层且互不扩大" | **半结构性** | 表结构保证不被混层，但"结论不能超出证据范围"仍需 review 自己写 `scope` |
| "实施要连续" | **软** | 插件不知道中间有没有换人，只能靠证据时间线 |
| "修正要限定（不许顺手改别的）" | **软** | 可以拿 `checkBaseline` 的 changedFiles 与 ticket scope 比对，但比对规则需可配置（P2） |

---

## 9. 与 L1 的叠加关系

- L2 **不替换** L1 的四个 preset，只在它们里面追加 1 个工具 row。
- preset 修订在会话创建时冻结 → 装完 L2 必须**新开会话**才生效（和 L1 一样）。
- L1 的 `protocol/ROUND-PROTOCOL.md` 保留，但降级为"人读的说明"；真正生效的是插件。两者内容必须一致，否则模型会读到一个、被另一个挡住。
- L1 的 `preset-work` 上的 `tool-ask-user`：L2 落地时建议**摘掉**（见 §1.1），改为"要拍板就上交 plan"。

## 10. 未验证项（实施前必须先跑通，否则设计要改）

- **A. 门禁真的能弹卡片吗**：需要在 plan 会话里真实调一次 `userQuestions.ask`，确认 UI 出卡片并返回答案。
- **B. preset 子行注册的工具是否 agent 作用域**：若不是（变成全局），则四个角色都能看见全部工具，退化为"工具内校验角色"。
- **C. preset 子行能否 `inject` 宿主全局服务**：若被 `isolate` 遮住，改为"一个全局 row 注册全部工具 + `ctx.tools.guard()` 按 `composedPreset` 拒绝"。这是 §10.B 的同一个备选。
- **D. 子代理的 sessionId 能否拿到**：`ToolExecutionInput.agent` 应有 session；若拿不到，`authorSession` 用 `parent` 兜底。
- **E. 热重载与 domain 单开**：Loader 重载插件时 `Domain.close()` 与再次 `open()` 的顺序，是否会出现 `already-open`。
- **F. 非 git 项目的 T0**：文件哈希清单的规模上限（大仓库会打爆存储），需要采样策略。

## 11. 分期

- **P0（最小可用，约 7 个工具）**：domain + `open_round` / `freeze_baseline` / `check_baseline` / `record_failure` / `record_evidence` / `close_round` / `status`。无 gate、无 UI。
- **P1**：`gate`（真实问人）+ `export_audit` + 侧边面板显示当前轮 / 计数 / 门禁。
- **P2**：费用自动汇总（跨 plan/work/code/review 四个 session 用 `tokenMeter.measure` 累加）、失败签名自动识别、scope 比对。

## 12. 决策（已锁定，v0.1 评审通过）

| 编号 | 问题 | 结论 | 影响 |
|---|---|---|---|
| D1 | gate 归谁 | **运行期按"是否根"判定** | `askGate` 收 `RoleExec.isRoot`；非根返回 `ESCALATE_TO_PARENT`，不抛 `DELEGATED_CALLER`。方式 B（work 当根）同样可用 |
| D2 | 审计落盘 | **每轮落 `.dsh/rounds/<roundId>.json`** | `closeRound` 成功后自动导出一次；domain 是权威副本，文件是审计副本 |
| D3 | 越限处理 | **允许 force，但必须经 gate 且理由入库** | `closeRound` 遇到 `counters.* > limit` 时查找 `kind:'force'` 的 `GateRecord`；无则拒绝并指出缺哪条 |
| D4 | 费用 | **`tokenMeter` 估算 + 人工可覆盖** | `closeout.cost.estimate` 为 true 表示来自 meter；人工填的覆盖值 estimate=false 并记 `note` |

这三条直接改写了服务签名，已反映在 §5 与 §6：

```ts
// D1：isRoot 由工具层从 SessionHeader 判定后传入，不由模型自述
// D3：closeRound 内部
const forced = gates.some(g => g.kind === 'force' && g.roundId === roundId)
if (!forced && exceeded) throw new CloseoutError('COUNTER_EXCEEDED', { which, count, limit })

// D4：closeRound 接受可选 costOverride
closeRound({ roundId, closeout, costOverride?: number })
```

## 13. 打包事实（写代码前必须遵守）

- **插件以 peerDependencies 声明 `@deepseek-ai/*`，自己不带**。`dsh-context@0.78.2` 的 `peerDependencies` 里有 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-session`、`@deepseek-ai/schemastery`，本地 `dependencies` 只有 `zod`。→ 宿主包由运行时提供，**不要**在 bundle 里 vendor 一份 `@deepseek-ai/*`。
- **`zod` 可直接依赖**：profile `node_modules\zod` 存在（4.x）。`@deepseek-ai/dsh-storage-domain` 的域值 schema 就用 `zod` 4.4.3 构建。
- **`defineDomain` 不是必需的**：`storageDomain.open()` 收的是纯 `DomainSpec`（`{name, version, tables: {k: {valueSchema, __key}}, global?}`）。P0 直接构造这个对象即可，少一个 import 依赖。
- **bundle 声明方式**仍是 `package.json` 里的 `dsh.bundle.patch`，patch 文件里用 `insert:`；L1 已验证这条路径可用（junction 安装，改完重载即生效）。
- **客户端 UI（面板）是另一套**：`dsh.client.inject` + `platform: 'web'` + `lib/client.js`。P1 的面板要单独打包，别混进 Host 插件行。

## 14. 下一步的执行边界

P0 会**真实写入你的 profile**（新增一个 bundle 依赖）。按规矩这需要你一句明确的话。你说"装"，我就：

1. 写 `lib/` 下 P0 的 7 个工具 + domain + service（约 700 行，纯 ESM，无构建步骤）；
2. `plugin_manager install_bundle` 安装，确认 `fiberPhase: active`；
3. 打开一个 `plan` 会话，跑 §10.A（gate 真弹卡片）与 §10.C（工具可见性）两个验证；
4. 用验证结果回改这份文档，再交给你。

---

## 15. P0 实施记录（2026-10-31，与上面的设计逐条对照）

### 实际落地的文件

```
package.json      @local/dsh-role-chain-protocol 0.1.0, type module, dsh.bundle.patch
cordis.patch.yml  1 个全局行：{ id: role-chain-protocol, name: '@local/dsh-role-chain-protocol' }
lib/index.js      name = 'role-chain-protocol'; inject = ['tools']
                  apply(ctx) → registerTools(ctx) + ctx.effect(释放)；日志 "[role-chain] 9 个 chain_* 工具已注册"
lib/roles.js      ROLES = ['plan','work','code','review']
                  resolveExec(ctx, exec) → { agent, role, preset, isRoot, sessionId, parentSession, delegationDepth, cwd }
                  角色来源优先级：SessionHeader.agentPreset → ctx.agentPresets.composedPreset(agentCtx)
                  isRoot = !header.parentSession && header.origin !== 'subagent'
lib/service.js    LIMITS / DEFAULT_BUDGET / LAYER_ROLES / GATE_KINDS / ChainError(错误码)
                  openRound · freezeBaseline · checkBaseline · recordFailure · recordEvidence
                  askGate · closeRound · status · exportAudit
lib/store.js      RoundStore：<cwd>/.dsh/rounds/state.json（tmp+rename 原子写）
                  mutate() 单实例串行读改写；forCwd(cwd) 保证同项目只有一个队列
lib/tools.js      9 个 chain_* 工具；define() 先判角色，再取 store，再执行
test/smoke.mjs    无宿主自测 21 条
```

### 与设计的偏差（三条，都是有意为之）

| 设计 | P0 实际 | 原因 |
|---|---|---|
| 状态进 `dsh-storage-domain`（§4、§13） | 纯 JSON 文件 `<cwd>/.dsh/rounds/state.json` | profile 的 `zod` 是 **3.25.76**，`@deepseek-ai/dsh-storage-domain` 要求 **zod 4.4.3**。要让 domain 可用就得往 bundle 里塞第二份 zod；P0 不这么做。附带好处：D2 的"审计副本"与权威副本是同一份文件，不会不一致 |
| 4 个 preset 子行各自注册本角色工具（§3、§8"结构性"） | **一个全局行**注册 9 个工具，工具内部按角色拒绝 | §10.B（子行工具是否 agent 作用域）与 §10.C（子行能否 inject 宿主全局服务）都未验证。先保证"错的角色调用会被拒"，而不是"看不见" |
| 越限判定用 `counters.* > limit`（§5、D3） | `>= limit` | "同一测试失败 3 次停下"指第 3 次就停，不是超一格才停。`testFailures` 也进 `budgetOf()`，可按轮覆盖 |

### 已验证

- `node --check`：`lib/index.js`、`roles.js`、`service.js`、`store.js`、`tools.js` 全部通过。
- `node test/smoke.mjs`：**21 passed, 0 failed**（开轮 → T0 唯一 → 分层证据 → 计数越限 → 关闭被拒 → force 门禁 → 关闭成功落盘 → 关闭后看板）。
- `plugin_manager install_bundle`：`application: applied`，pnpm exit 0。
- `plugin_manager list_plugins`：`include:role-chain-protocol` → `enabled: true, fiberPhase: "active"`。
- 激活日志：`[info] [role-chain] 9 个 chain_* 工具已注册 [host.kernel.role-chain-protocol] {"pluginId":"include:role-chain-protocol"}`。

### §10 未验证项的当前状态

| 项 | 状态 |
|---|---|
| A. 门禁真弹卡片 | ⏳ 待真实会话验证（见 ACCEPTANCE.md 第 3 步）；代码路径已通，失败会抛 `GATE_FAILED` 并带上宿主错误码 |
| B. 子行工具是否 agent 作用域 | ⏳ 未验证 → P0 因此走全局行 |
| C. 子行能否 inject 宿主全局服务 | ⏳ 未验证 → 同上 |
| D. 子代理 sessionId | ✅ 可用：`SessionHeader.id / parentSession / delegationDepth / agentPreset` 都能读到，`AuthorSession` 取 `header.id` |
| E. 热重载与单开 | ✅ 不适用了：P0 不用 domain，重载只是重新注册工具（`ctx.effect` 负责释放） |
| F. 非 git 项目的 T0 | ✅ 记 `mode:'no-git'`，`commit:null`，收尾 `version.commit` 写 `"(no-git)"`；哈希清单仍属 P2 |

### P1 迁移清单（按优先级）

1. bundle 自带 `zod@4`，状态迁回 `dsh-storage-domain`（`role-chain` v1、`layout: 'per-record'`）。
2. 工具注册下沉到 4 个 preset 子行（验证 §10.B/C 后），把"调了会拒"升级成"看不见"。
3. 侧边面板：当前轮 / 计数 / 门禁 / 证据层计数（客户端 bundle，独立于 Host 行）。
4. `tokenMeter.measure` 自动累加一轮费用（按四个 session 汇总），替换人工填的 `closeout.cost`。
5. `checkBaseline` 增加 `changedFiles`，与工单 scope 比对（P2 的"修正要限定"）。

