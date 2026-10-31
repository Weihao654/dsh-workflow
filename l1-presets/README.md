# 角色协作链 · L1 配置包（plan / work / code / review）

把「用户 ↔ plan → work → code → work → review → work → plan → 用户」这条链做成四个 DSH agent preset。
**纯配置**：没有一个 Host 插件、没有一行运行时 TypeScript，全部是 Loader YAML 里的 preset 声明。

---

## 一句话定位

- **做到了**：四个角色真实存在、互相只能通过既定通道派发、**谁能写文件是结构性的**（不是提示词约束）。
- **没做到**：六步流程本身没有状态机。T0 冻结、失败计数、证据分层、按轮预算、收尾结构，全靠提示词纪律 + 人工检查。要可审计就得升到 L2 协议插件。

---

## 文件

```
workflow-l1/
├── package.json              bundle 声明（dsh.bundle.patch 指向下面的 patch）
├── cordis.patch.yml          四个 preset 的全部定义（唯一有实质内容的文件）
├── protocol/
│   └── ROUND-PROTOCOL.md     六步协议正文，复制到你项目的 AGENTS.md
├── tools/
│   ├── asar-read.ps1         只读 asar 的小工具（开发期用来抄官方 preset，运行期不需要）
│   └── shipped-standard.patch.yml  官方 standard preset 的原文，改动时对照用
└── README.md
```

`tools/` 整个目录与运行期无关，可以删：`asar-read.ps1` 是拆 `app.asar` 用的，`shipped-standard.patch.yml` 是从 `app.asar` 里 `node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 抽出来的官方原文，留着方便对照插件名与配置键。

---

## 安装

已在本机装好并通过 Loader 校验（见下方「验证」）。换机器重装：

```powershell
# 在 DSH 里（对话方式）：
# plugin_manager  action: install_bundle  target: <本目录绝对路径>
```

`install_bundle` 会自己跑 pnpm、把包加进 profile 的 `dsh.profile.bundles`、重载 Loader，不需要手工编辑任何 profile 文件。

本机装完的实际落点（可用于排查）：

| 什么 | 在哪 |
|---|---|
| 依赖登记 | `C:\Users\Weihao Chen\.dsh\profiles\desktop\package.json` → `"@local/dsh-role-chain-presets": "link:C:/Users/Weihao Chen/Desktop/DSH/workflow-l1"` |
| bundle 顺序 | 同文件 `dsh.profile.bundles` 最后一项 `@local/dsh-role-chain-presets` |
| 安装形态 | `profiles\desktop\node_modules\@local\dsh-role-chain-presets` 是指向本目录的 **Junction** |

因为是链接而不是拷贝，**改 `cordis.patch.yml` 不需要重装**——重载 Loader 或重开会话即可生效。

### 卸载

```powershell
# plugin_manager  action: remove_bundle  target: @local/dsh-role-chain-presets
```

四个 preset 随 bundle 一起消失。已经**创建过**的会话不受影响（preset revision 在 Agent 创建时冻结），但下次开新会话就选不到了。

---

## 四个角色

| preset id | 名字 | 定位 | 派发能力 |
|---|---|---|---|
| `plan` | plan | 收敛方案、确认改动位置、向 work 派发 | `dispatch_work` → work |
| `work` | work | 唯一执行协调者，管 T0 / 预算 / 证据 | `dispatch_code` → code，`dispatch_review` → review |
| `code` | code | 唯一源码写入者 | 无（不能继续派发） |
| `review` | review | 独立只读审核 | 无 |

链路是单向的：plan 只能叫 work，work 只能叫 code 和 review，code 和 review 叫不动任何人。`allowedAgentPresets` 把每个派发工具钉死在一个 preset 上，plan 想直接叫 code 是**没有工具可用**的，不是「被劝住」。

### 工具矩阵

| 工具 | plan | work | code | review |
|---|:--:|:--:|:--:|:--:|
| `read` / `grep` / `glob` | ✅ | ✅ | ✅ | ✅ |
| `write` / `edit` | ❌ | ❌ | ✅ | ❌ |
| `pwsh` / `bash` | ❌ | ✅ | ✅ | ❌ |
| `jobs`（后台任务） | ❌ | ✅ | ✅ | ❌ |
| `todo` | ✅ | ✅ | ✅（可并行） | ✅ |
| `ask_user_question` | ✅ | ✅ | ❌ | ❌ |
| `web_search` / `web_fetch` | ✅ | ❌ | ✅ | ❌ |
| `present` | ✅ | ✅ | ❌ | ❌ |
| 子代理派发 | `dispatch_work` | `dispatch_code` / `dispatch_review` | ❌ | ❌ |
| plan mode（`exit_plan_mode`） | ✅ | ❌ | ❌ | ❌ |

四个 preset 都挂了 `agent-instructions`，所以项目根的 `AGENTS.md`（放 `ROUND-PROTOCOL.md` 的内容）对四个角色同时生效。

---

## 结构性 vs 仅提示词（诚实分档）

**结构性**——由工具集和派发关系决定，模型再想违反也没有工具可用：

1. plan 改不了文件（无 write/edit/shell）。它只能交方案。
2. review 改不了产品、加不了测试（无 write/edit/shell）。
3. work 也不写源码（write/edit 关闭）。
4. code 是唯一写入者，且不能再派发别人——不会出现 code 自己叫 code 递归。
5. 派发方向被 `agentPreset` + `allowedAgentPresets` 钉死，plan 越级叫 code、review 反向叫 code 都没有工具。
6. 一个 DSH 会话的 preset 在创建时冻结（revision 固化），不存在「本轮写到一半把 review 改成可写」这种事。

**仅提示词**——写在 persona 和 `ROUND-PROTOCOL.md` 里，模型可能打折执行，没有强制：

1. **唯一 T0 冻结**：没有东西阻止 work 中途看到别的 commit 就悄悄换基线。
2. **失败/重试/重启累计计数**：没有计数器对象，全靠模型自己数。
3. **证据分层**：没有结构化字段区分「命令输出 / 代码自述 / review 结论」。
4. **按轮记录预算**：`token-meter` 是 Host 级的，不给某一轮记账。
5. **固定收尾结构**（版本/结果/未覆盖项/费用/停服务）：靠人设里的汇报格式。
6. **review 的独立性**：review 确实改不了东西，但它读到什么、有没有真读，L1 保证不了。

**半个结构性**——值得单独说：

- work 有 shell。它是「只读 fs」但 shell 能写文件（`Set-Content`、重定向）。这是刻意留的：work 要跑验证命令。代价是 work 的只读只是默认路径，不是硬墙。真正想让 work 物理不可写，只能等 L2 用 sandbox 策略按 preset 收紧，或干脆不给 work shell（那就没人能跑验证）。
- code 有 shell 也有全量 fs——它本来就是唯一写入者，无冲突。

---

## 怎么真的把这条链跑起来

### 方式 A：最省事，全手动切角色（推荐先这么试）

DSH 的 preset 是**新建会话时**选的，不是会话中途切的。所以：

1. 新建会话，选 `plan`。跟它说目标。它只读调研、写方案、需要你拍板时用 `ask_user_question` 问你。
2. 认可方案后，让 plan `dispatch_work` 起 work。work 会自己去叫 code 和 review。
3. plan 拿到 work 的汇总，给你三块结论：能交付什么、未覆盖什么、花了多少。

注意：work / code / review 是被 plan 派出去的**子代理**，你看不到它们的对话，只看到 plan 转述的结果。要审细节就要求 plan 把 review 原文贴出来。

### 方式 B：一个会话里当协调台

新建会话选 `work`，自己充当 plan 的角色：说清方案、授权边界、T0，然后让 work 派 code / review。适合你已经想清楚要做什么、只需要有人督工。

### 方式 C：从 review 反向用

新建会话选 `review`，把它当「只读审计员」用：给它一个目录或一组改动，让它出「通过范围 / 未覆盖项 / 阻断项」。这是四个 preset 里**单独用最划算**的一个——它改不了东西，所以你可以放心让它看任何东西。

### 派发深度上限

Host 的 `subagent.maxDepth` 默认是 1，而 plan → work → code 是三层，所以本包的派发工具都写了 `maxDepth: 2`。如果你在别的地方又套了一层（比如在 workflow 里再派 plan），第三层会直接报深度超限——这是设计行为，不是 bug。

---

## 六步在 L1 怎么落地

| 步 | 谁做 | L1 靠什么 | 缺口 |
|---|---|---|---|
| 1 核对基线 | plan | persona 要求先读后说；只读工具齐全 | 没有强制「必须先读」的机制 |
| 2 收敛方案与授权 | plan | plan mode + `exit_plan_mode` 是人类审批门 | 审批内容是否完整靠人看 |
| 3 连续实施 · T0 | work | 派发记录 + 单一 code 写入 | T0 不持久化，会话崩了就没了 |
| 4 限定修正 | work | persona 里的阈值（3 次失败 / 2 次重跑 / 3 次重启） | 计数在模型脑子里，不复核 |
| 5 独立终审 | review | review 物理不可写，只能读 | 读到什么不可证 |
| 6 交付并关闭 | plan | persona 里的固定汇报格式 | 费用数据要人自己看 |

阈值和汇报模板写在 `protocol/ROUND-PROTOCOL.md`，放项目 `AGENTS.md` 里四个角色都会读到。

---

## 验证（我实际跑过的）

| 检查 | 方法 | 结果 |
|---|---|---|
| bundle 能装 | `plugin_manager install_bundle` | `stage: enable, changed: true, application: applied`，pnpm exit 0 |
| YAML 能被 Loader 解析 | `Config.listConfigs name=@deepseek-ai/dsh-agent-preset` | 目录从 4 条变 8 条，新增 `preset-plan/-work/-code/-review` |
| 四行真的挂上了 | `plugin_manager list_plugins` | `include:preset-plan` 等四条均 `enabled: true, fiberPhase: active` |
| 引用的插件模块名都对 | 把本包 `cordis.patch.yml` 里所有 `name:` 与官方 `standard.patch.yml`（见 `tools/shipped-standard.patch.yml`）比对 | 本包用到 17 个模块名，**全部**出现在官方在跑的 preset 里；无自造模块名 |
| 子插件是否全部激活 | —— | **未验证**，见下 |

**没验证到的**：没有新建过任何会话，所以「选 plan 后 persona 生效、`dispatch_work` 出现在工具列表、code 真的能写文件」这条端到端路径是推断，不是实测。原因是我作为当前会话的 Agent 无法创建另一个 Agent 的会话，本地 GUI 的 HTTP 接口需要授权令牌。

**你花 30 秒就能补上这个缺口**：新建会话 → 打开 preset 选择器 → 应该能看到 `plan / work / code / review` 四个 → 选 `plan` → 看它有没有 `dispatch_work` 和 `exit_plan_mode`、有没有 `write`。有就说明整条链的装配是对的。

---

## 已知缺口（L2 才补）

1. **人机门禁无法脚本化**：workflow 一次调用跑到黑，等不到人批准。所以 gate 只能是工具调用返回对话，或 goal 续轮。
2. **没有轮次状态机**：T0、计数、预算、证据、未覆盖项都是「模型自己记着」。会话被压缩或续轮后可能丢。
3. **没有按轮记账**：token-meter 只给会话总量。
4. **收尾结构不可审计**：交付格式对不对，只能人看。
5. **preset 中途不可改**：改 persona 只影响之后新建的 Agent。想做「本轮中途收紧纪律」，L1 做不到。
6. **work 的只读是软的**（有 shell）。

L2 的形态：一个 Host 插件，提供 `round_open` / `baseline_freeze` / `dispatch` / `gate` / `record_evidence` / `close_round`，用 `dsh-storage-domain` 落盘轮次状态，加一个 UI 面板显示当前轮、门禁和预算。那时 `workflow` 只负责一轮内的扇出，六步交给状态机。

---

## 改这个包

改 `cordis.patch.yml` 之后：

1. 不需要重装（装的是 Junction 链接，见上文「安装」）。重载 Loader 或重启 DSH 让新 YAML 生效。
2. **新建会话**才看得到改动——已存在的会话保留旧 revision。

改 persona 时注意 YAML 缩进：`prefix: |` 是块标量，正文里所有行都要和它对齐（本文件里是 14 空格）。
