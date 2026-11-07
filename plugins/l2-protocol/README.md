# L2 轮次协议 · 0.2.1-rc.20261107.40

## r2 人工预授权（尚未真实 Host 验收，不可部署）

在正式 Host 中选择真实根 plan 后，由用户直接发送 `/chain-authorize {"authorizationId":"用户指定的唯一授权ID","goal":"明确目标","budget":{"tokens":100000,"requests":16,"outputCap":4096,"wallMinutes":45,"fixes":1,"reruns":1,"restarts":0}}`。这是正式 Commands 服务的人工命令，不通过模型推理，不提供同名模型工具。示例数字不是授权。

授权与累计账本位于 Host 的 `DSH_PROFILE_DIR/role-chain-authority/<canonical-project-sha256>`，不在项目内；生产无 profile 则拒绝加载，不回退项目账本。命令在首次请求前绑定首轮，原授权 ID、总额度、次数和期限不能替换；跨轮、重建和复用累计。预授权写入后首次开轮失败可用同一命令恢复，但关闭过的项目不会因重复命令重开。模型工具禁止写出项目、修改 .dsh/.git 元数据；review 不可写，原生 shell/任意执行继续受控拒绝。保护边界是本插件管辖的模型工具和完整隔离计算，不是对同一 Windows 用户任意外部程序的安全隔离。

**兼容性影响：** 当前实现对整个加载本协议的 profile 强制预授权，普通未绑定 standard 也会在模型边界被拒绝；部署前必须明确批准此影响。缺失完整回执的已结束请求保留预留并阻断后续准入，不记零。输入预留仍是 JSON 字节估算，不能保证硬 token 总封顶；仅可观测流尝试计数，不包含提供商内部不可见重试。真实挂载上下文、Commands GUI、跨进程保护与权限最终证明仍须独立验收。

> 源码候选版，尚未重新加载当前 Host 或完成真实 GUI/Host 集成验收。当前安装的 Windows partial 隔离后端不满足计算条件，`chain_compute` 会拒绝启动。

## 角色与轮次

用户 ↔ plan → work → code → work → review → work → plan ↔ 用户。

- plan：目标/授权收敛、用户决策、交付；仅实际根 plan 可开轮和写角色模型设置。
- work：唯一执行协调者，沿原会话汇总与派发。
- code：源码/测试脚本/启动说明的写入者。work 仍须安排单一源码写入，按族复用不是跨族文件冲突锁。
- review：新建的独立只读审核，不追加产品修改或执行测试。

六步：核对真实基线 → 收敛授权 → 固定唯一 T0 连续实施 → 累计限定修正 → 独立分层终审 → 带退出证明收尾。

## 工具（14 个）

| 工具 | 行为 |
|---|---|
| `chain_open_round` | 根 plan 开启有明确验收目标的一轮，登记预算 |
| `chain_freeze_baseline` | work 读取真实 Git 事实并冻结唯一 T0/期限 |
| `chain_check_baseline` | 比较当前事实，不重冻、不续期 |
| `chain_dispatch` | plan→work；work→code/review（`.34` 起：持 command 证据的根 plan 可派 review 收尾）；返回执行 ID、generation 与会话 ID |
| `chain_stop` | 持久停止意图后取消确切执行，分别确认 Agent/job 退出 |
| `chain_compute` | 仅完整只读隔离 + 本机 Windows Job 后端；拒绝 partial/缺失隔离 |
| `chain_release` | 确认整个自有子树退出后移除名册；不删除轮次历史或取消屏障 |
| `chain_record_failure` | 按稳定签名累计失败及修正/重跑/重启 |
| `chain_record_evidence` | 记录实际角色、T0、执行代际和证据层级 |
| `chain_gate` | 具体新决策或最终验收；技术阻塞只暂停受影响阶段 |
| `chain_status` | 默认六字段短卡；`detail: full` 显式查看完整状态 |
| `chain_close_round` | 校验交付版本、命令/审核证据及其他执行退出后关闭并导出 |
| `chain_export_audit` | 显式导出最新持久状态；不要日常反复全量导出 |
| `chain_role_models` | 查看/修改项目角色模型及 reuse；手动选模优先 |

## 停止不是布尔值

`requestId` 必须稳定，重试同一停止沿用它；换原因/目标不能复用。单个执行必须同时给原 `executionId` 与 `generation`。整轮停止仅实际拥有轮次的根 plan；work 可停止其真实后代，ID 本身不授予权限。

真正用户可通过 Host 斜杠命令操作，即使原父会话已不在线：

```text
/chain-stop <roundId> <requestId> <reason>
```

必须在同一项目工作目录的真实人类命令入口使用。模型不能通过构造 `kind: user`、猜会话 ID 或另开管理代理获得该权限。

回执的 `admission: persisted` **仅表示意图已持久化**。`nativeAdmission: pending` 表示原生启动封闭未确认；它与 `agentQuiescent`、`jobsQuiescent`、最终 stopped 状态分开。普通路径共享启动锁，在锁内提交停止标记；锁超时时，只能先持久意图、取消确切持有的监督器并等待锁/范围退出证明。**已进入原生创建区的操作可能仍在进行，不能承诺意图写入瞬间便不再 Create/Resume。**

缺失能力、身份不符、不可读回执、未 joined 的监督器、历史库存不明都保留 unknown/pending；不猜 PID、不把 Team 的同名 interrupt 工具当成原生管理通道。

## 复用与预算

默认 work=persistent、code=family、review=fresh；work 只能 persistent，code 可 family/persistent，review 只能 fresh。`fresh: true` 只允许 review。

复用由同轮不可删除的执行历史决定，不只看名册；忙碌、停止、策略切换或 release 后均不能另开同槽位替身。复用可能是同会话冷恢复，不保证同一个常驻 Agent 实例。关闭/停止后不自动续跑；新轮使用新的根 plan 会话。

T0 默认总期限 90 分钟（允许缩短），停机宽限包含在期限内。重试、阶段和控制器重建不重置期限。独立 Windows 监督器仅适用于实际获准启动的受控计算，不等于已验证 Host 崩溃恢复。

请求账本在可观察的 provider 调用前预留输入估算与输出 cap。默认输出 cap=2048，角色/重试请求独立编号；快照不重复相加；晚到回执写回原轮/原执行代际。开轮前根 plan 请求单独记账，开轮后只收养一次，不能倒推成已获预算授权。缺用量仍 pending、已有部分用量只是下界。金额未知保持 unknown，不写 0。隐藏的 provider 内部重试、估算误差、响应后才收到 usage，意味着这不是绝对预付费天花板或发票。

## 门禁与证据

新范围/预算/业务规则/权限必须包含具体 `change`、`originalAuthorization` 和 `whyNotCovered`。不变前提不重复问用户；`NOT_GATED` 不是安全批准。授权内技术问题由 work 处理，真实 blocker 暂停对应 phase，继续其他独立授权工作。`accept` 仅用于最终 closeout。

无回答、模糊回答不授新权。`force` 仅覆盖用户看到的失败计数快照，后续新增失败不自动继承；不重置停止、期限或 token 屏障。

command、artifact、self-report、review 分层。角色自述不能变成独立验证。关闭必须有命令证据和独立 review、实际其他 Agent/job 退出、版本、结果及非空未覆盖项；`servicesStopped: true` 不能替代过程证明。执行关闭工具的根 Agent 不在“其他执行”内，不能因此宣称整个 Host 已停。

## 状态、文件与部署

短卡固定六组：目标/T0，执行/停止，时间/token/费用/失败，关键交付，实际阻塞，下一步/责任角色。

项目内状态使用 `.dsh/rounds/`，模型映射使用 `.dsh/role-chain.json`。控制器保护模型工具对控制文件和 Git 元数据的直接写入，但这不是抵御操作系统同用户/管理员的安全边界。状态队列为进程内串行，尚未支持跨 Host 写入锁。

Git 固定查询禁用 fsmonitor/hook 和已发现的过滤器回调，忽略子模块脏状态；dirty 仅覆盖顶层工作树且过滤器关闭，不等于通常的 Git status。仓库外/同用户并发恶意配置变更不在已验证范围。固定 Git 查询仍是带超时和调用信号的 Host 查询，不是完整轮次计算作业。

关闭工具导出的审计是当时快照；晚到 usage 可能继续落入持久账本。需要最终状态时显式重新导出，不能把旧快照 pending 改写成 0。

通过 DSH 插件管理器部署，不手改 profile。本地链接重装有过源目录被清空的历史，本次不重装/重启；当前 GUI 是否载入候选版未验证。模型设置卡及 preset 过滤 UI 保留原设计，没有在本次声称视觉验收。

## .25 的诚实性修正（对 .24 整体独立复审的处置）

- **符号链接回执用例改为 opt-in**：`node --test test/receipt-symlink.mjs`。无建链权限时报 `skipped`，不再让「文件整体 PASS、子用例未运行」冒充证据；默认入口不选它。
- **spawn 失败 = 证据缺失**：`run.mjs` 打印 `SPAWN ERROR` 并以 exit 2 结束；退出码语义仍是 0 通过 / 1 失败 / 2 证据不完整。
- **PE 规则未移动**：工作区外的 `exe/bat/cmd/ps1/vbs/msi` 按名拒绝；工作区内的 PE 故意放行给 guest 以证明无法回连 Windows（`bridge-live` R-E）。注释已改成与实现一致。
- **已知限制（不再声称已验证）**：`runBridge` 形状下只能拿到 `wsl.exe` 的退出码（生产链路由 runner 自己写 trailer），因此该路径上的 `JOB_EXIT_UNKNOWN` 不可达；回执无签名、依赖只读+full 隔离声明。

## .24 的回执必须来自已启动的进程（对 .23 独立复审的处置）

`.23` 对回执做了位置/类型/身份/内容校验，但没有读 `launched`。Windows supervisor 在 `CreateProcessW` 失败时会写
`jobEmpty=true, launched=false, reason=supervisor-error, exitCode=1`（`lib/windows-supervisor.ps1:183-184`），
于是「从未启动的命令」也能变成一条 command 证据并满足关轮门禁。`.24` 要求 `receipt.launched === true`，否则
`JOB_PROOF_INVALID`；夹具新增 `launched:false` 反向用例。

同时收紧两处不诚实/可绕过的实现：

- `translateArg`/`translateArgv` 在包含性判断前折叠 Windows 路径里的 `.`/`..`，避免 `<ws>\..\..\usr\bin\perl`
  通过前缀检查后在 guest 解析到 `/usr/bin/perl`（绕过可执行白名单）。
- `test/run.mjs` 的 skipped 分支改为按文档返回 2（不再是先被计成失败退 1），并更正头部「默认 in-process」的
  错误说明（默认为 spawn 模式，`--in-process` 才是降级）。

仍未解决（如实保留）：`wsl.exe` 自身的退出码仍被当作子进程退出码（`BRIDGE_EXIT child=<code>`），因此
`JOB_EXIT_UNKNOWN` 在 wsl 已启动但发行版不可用时不会触发；该路径在本机无法实测，列为 UNKNOWN。
## .23 的回执信任（收紧了 .22 的存在性检查）

`.22` 只验证「绝对路径 + 目录尾 + 文件存在」，因此同名目录、别处同名文件、内容被改写的文件都能通过。
`.23` 把回执判定集中到 `lib/receipt-proof.js`，命令证据与原生回执共用同一套判定：

- **位置**：必须是本 job 的可信路径 `<store>/executions/<roundId>/<executionId>/receipt.json`；别处同名文件一律 `JOB_PROOF_UNTRUSTED`。
- **形状**：`lstat` 必须是普通文件；符号链接、目录一律 `JOB_PROOF_UNTRUSTED`；`realpath` 必须仍等于可信路径（防链接换位）。
- **内容**：必须是可解析 JSON 对象（否则 `JOB_PROOF_CORRUPT`），且 `backend/roundId/executionId/nonce/generation` 与账本记录逐项相等、`jobEmpty===true`、退出码为整数且与记录一致、`checkedAt/exitAt` 可解析、T0 的 `deadlineAt/signalDueAt` 未被改写，否则 `JOB_PROOF_INVALID`。
- **可追责**：证据 payload 与处理函数都带上 `receiptDigest`（对回执原始字节取 sha256）与 `receiptCheckedAt/receiptExitAt`，事后改写文件可被比对发现；原生回执解析（`readJobProof`）与证据提交共用该模块，两条路径不再各写一套规则。

未覆盖（如实标注）：可信目录内若攻击者能任意写，仍可整体替换回执；本层只证明「记录与文件一致、来源位置正确」，不证明 Windows Job 内核语义（见 `test/windows.mjs` 与未完成的原生复审项）。

## 测试入口与平台范围（.18）

一条可重复运行的回归入口：

- `node test/run.mjs` —— 夹具组（14 个测试文件 + `api.mjs`/`routes.mjs` 脚本，共 116 例）。`.24` 起默认**逐文件子进程**并比对每个文件的期望测试数；不需要真实 job、不需要 WSL、不发模型请求，但**需要宿主允许创建子进程**。沙箱拒绝 spawn 时入口打印 `SPAWN ERROR …` 并以 exit 2 结束（证据不完整，不算通过）。
- `node test/run.mjs --native` —— 追加原生组（`git.mjs`、`windows.mjs`、`evidence-native.mjs`、`bridge-live.mjs`、`guest-boundaries.mjs`）：真实 Windows Job + supervisor + 原生回执、真实 WSL/bwrap。需要宿主允许 spawn 孙进程且存在 `Ubuntu` 发行版；仍然不发模型请求。
- `node test/run.mjs --in-process` —— 受限沙箱的回退：全部文件在单进程内 import 后执行，**不能**逐文件校验期望计数（早退或用 `process.exit(0)` 的夹具可能掩盖失败），只能作为次一级证据。

平台范围：原生组仅 Windows（`windows.mjs`/`evidence-native.mjs` 在非 win32 打印 `UNCOVERED` 并 exit 2；`bridge-live`/`guest-boundaries` 需要 WSL）。POSIX 只覆盖夹具层，原生隔离未在 POSIX 验证，不作承诺。

`.21` 的加固：

- **跳过的测试不再算通过**。`test/run.mjs` 在 `--native` 与 `DSH_BRIDGE_LIVE=0` 同时出现时打印 `# INCOMPLETE` 并 **exit 2**；`--spawn` 模式逐文件解析 `skipped` 计数，任一文件有跳过则打印 `SKIPPED … skipped evidence is not a pass` 并以 exit 2 结束。退出码语义：0 通过 / 1 失败 / 2 证据不完整。
- **环境变量载荷边界有原生证据**（`test/guest-boundaries.mjs` G-H）：把选项形状的值塞进 `--setenv`（`R5P='a --chdir /'`）后 guest 的 `pwd` 仍是 `/srv`，证明该值没有被重新切分成 bwrap 选项；带换行的 env 值**被拒绝**（`BRIDGE_UNSAFE_ARGV`）——早先的"`'a\nb'` 单值到达"观察已作废，见 `.22` 之后的守卫收紧；`.20` 仅靠"工作区路径含空格仍通过"间接推断的空档由 G-H 的选项形状子用例补上。
- **`$` 替换语义降级为 unknown 并继续拒绝**。离线实测出现互相矛盾的观察：一次 `--exec printf 'A$HOME'` 输出 Windows 主目录路径，随后矩阵测试（`A$HOME`/`$HOME`/`p$HOMEq`/`${HOME}`/`A$USER`）全部**原样输出**；`sh -c` 里出现展开时那是 guest 自己的 shell 行为。既然主机语义无法稳定证明，`$`/反引号/CR/LF/NUL 仍一律 `BRIDGE_UNSAFE_ARGV`（过窄属过度拒绝，方向安全）。
- 工作区绑定源含 `$` 时实测绑定的是**字面目录**（构造 `probe3$HOME/c/Users/...` 诱饵文件后，guest 只看到字面目录内容），没有发生替换或目录置换；仍不把"绑定源含 `$`"当作受支持配置。

`.28` 的两处收紧（对 `.27` 整体复审的处置）：

- **关轮不接受无法校验的 command 行**：`.27` 对缺 `jobId` 或 `receiptDigest` 的行直接跳过，这类行仍能满足"至少一条 command 证据"；`.28` 把它们计入拒绝理由（`CLOSEOUT_REJECTED`，`cannot be re-verified`）。
- **原生回执用例有计数守卫**：`test/evidence-native.mjs` 增加 `test()`，断言两个用例都执行并通过；删除用例不再静默通过。

`.27` 的回执与真值收紧：

- **关轮会重读回执**。命令证据记录时保存 `receiptDigest`；关轮时逐条重读并校验（身份、`jobEmpty`、`launched`、退出码），digest 不符即 `CLOSEOUT_REJECTED`。这覆盖"记录之后、关轮之前"被改写的窗口，但不防同用户伪造（回执无签名）。
- **`completed` 只表示记录结束**。`readJobProof` 现在返回 `launched`；supervisor-error 回执是 `launched:false` + `outcome:'supervisor-error'`，表示进程从未启动，命令证据仍拒绝它。
- **`evidence-index.json` 的 `status` 按 `.27` 实测重写**，不再携带 `.16` 时代的 `verified:true` 行；历史证据只在 `_reports/` 与 HANDOFF 中。

`.20` 的加固：

- `buildWslArgs()` 现在校验 distro 名（`BRIDGE_BAD_DISTRO`），并对"预构造 `guestArgs`"的调用路径重新对 `--` 之后的 guest argv 执行 `assertSafeArgv`，避免 `runConfined()` 被新调用方用来绕过守卫。
- 冻结工具与独立校验脚本的排除集对齐（`test/results/**`、`.api-test/**`、`.routes-test/**`）；`excluded` 字段写入 manifest 供审计。
- 空 planning 轮不得 `delivered` 的断言进入夹具（`test/smoke.mjs`）。
- 已知未决风险：`--` 之前的 bwrap 载荷（工作区绑定源、`--setenv` 值）里的空格不被拒绝。实测本机工作区路径本身含空格（`C:\Users\Weihao Chen\…`）而 `bridge-live` 10 个用例全部通过，说明 `--exec` 在当前 WSL 版本上保留了参数边界；但这是主机行为而非代码保证，仍列为残余风险。

`.18`/`.19` 的接口与传输收紧：

- command 证据必须绑定产生它的已结算 job（`jobId` 填 `chain_compute` 返回的 jobId 或 executionId）；无 `jobId` 的自填 `command`+`exitCode` 一律 `COMMAND_BINDING_REQUIRED`——自述不能当回执。记录同时保存 `argv`（请求意图）、`executedArgv`（交给 supervisor 的受限 argv）、`executedCommand`（展示串）与 `ownerSessionId`/`parentExecutionId`（来源）；补齐字段与记录不一致即 `EVIDENCE_MISMATCH`。
- `.18` 的旧式 `wsl.exe -d <distro> -- <argv...>` **不保留 argv 原样**：它把参数拼成命令行后交给发行版默认 shell 解析，`$VAR`/`${}`/`$(...)`/反引号会展开，且**无空格参数里的 `;`/`|`/`&&` 也会被当作命令分隔符**。实测 `sh -c 'echo literal RC=$?'` 变为 `literal RC=0`、`$0` 为 `/bin/bash`；`printf 'A2_OK;' 'rm' '-rf' … '&&' 'touch' '/tmp/x'` 能在 bwrap 之外创建文件（已复现）。

`.19` 的传输与入口修正：

- 桥接层改用 `wsl.exe --exec /usr/bin/bwrap …`（不经发行版默认 shell），两处 spawn 点（`bridge/wsl-bwrap.mjs` 的 `runBridge`、`bridge/runner.mjs` 的 `runConfined`）统一走 `buildWslArgs()`。实测 `--exec` 下 `printf 'x;touch /tmp/probe'` 原样输出且**不创建文件**，`;`/`|`/`&&`/引号恢复为字面 guest argv；`--exec bwrap --version` 可解析（bubblewrap 0.11.1）。
- `$`、反引号、CR/LF 与 NUL 仍被拒绝（`BRIDGE_UNSAFE_ARGV`），但**原因是 UNPROVEN 而非已证实的替换**：`.19` 曾观察到 `printf 'A$HOME'` 输出 Windows 主目录，`.21` 的 25 形态 argv dump 又全部字面，无法把该观察归因于 wsl.exe，故按"无法证明稳定"继续拒绝——失败方向是过度拒绝，而不是宣称已被 `full` 隔离。
- 同轮跨会话引用 job **允许**（同一轮次、同一预算与工作区），payload 保留 `ownerSessionId`/`parentExecutionId`；跨轮引用一律 `JOB_WRONG_ROUND`。
- `test/api.mjs`、`test/routes.mjs` 不再调用 `process.exit()`，失败折叠为 `process.exitCode`，in-process 的 `test/run.mjs` 不会被脚本抢先退出（复审 F1）。
- 空的 planning 轮不得以 `result:'delivered'` 关轮（无 T0、无命令/复审证据时只能 partial/blocked）。


`.22` 的加固（复审 `.21` 的发现）：

- 回执引用必须是**磁盘上真实存在的** `<roundId>/<executionId>/receipt.json` 绝对路径（`windows-job-empty:` 前缀 + 结尾匹配 + `existsSync`），裸前缀、不存在的绝对路径或别的轮次的回执一律 `JOB_PROOF_MISSING`；夹具改为创建真实回执文件，并有对应用例证明这条规则。
- 传输守卫覆盖**整个 payload**（不再只查第一个 `--` 之后），`--setenv` 的值与 guest argv 同等对待（`BRIDGE_UNSAFE_ARGV`）；预构造 `guestArgs` 无法再借选项或环境值夹带替换形态。
- 修掉两条"不可能失败"的真实 WSL 用例：R-C 更名为它实际检查的系统目录，R-E 的前置 `whoami.exe` 缺失时改为失败而非静默通过，R-F 显式断言 `/mnt` 不可达。
更多：[设计](<DESIGN.md>) · [验收与未覆盖项](<ACCEPTANCE.md>)。

### .30 closing sequence

The reserve must fund the whole closing sequence, not only the final tool call: the plan closing
call, the review run, the evidence write and the close. Until `.34` a plan could only dispatch work,
so the reserve covered a review that was **already dispatched** and never the dispatch itself; since
`.34` a plan that already holds command evidence may also dispatch the missing review from the
reserve (see the .34 section). A review execution — or a plan that already holds
command evidence — may draw on the reserve once ordinary room is gone; work and code never can. Draws
are counted in `round.usage.closeout` and the round ceiling is `limits.requests + reserve`, so a loop
is refused instead of draining the closing budget. `test/closeout-reserve.mjs` runs these paths
against a real authority root.

### .29 review fixes

Independent review #15 rejected the first .29 freeze: the request-slot reserve was off by one, the time reserve could be lowered, and a .28 grant would have become `AUTHORIZATION_CORRUPT` on upgrade. All three are fixed (`lib/usage.js`, `lib/service.js`, `lib/authorization.js`) and the tree was refrozen (62 entries; the digest lives in `FILE-FINGERPRINTS.json`). For the `.29` record only: that version kept `closeoutRequests` slots and `closeoutTimeMs` free and let only a plan holding both a command and a review row spend them. `.30` replaced that rule — see the closing-sequence sections above.

## .34 的关轮保证（closing guarantee）

这一节回答一个问题：**在什么情况下，一轮在额度用尽时仍然一定能通过工具路径合法结束？**

1. **谁能派发 review**：正常路径是 `plan → work → code/review`；`work` 是唯一能在常规流程里派发 review 的角色。`.34` 增加**收尾例外**：当且仅当该轮**已经登记了 command 证据**时，根 plan 可以自己派发一次 review 来完成收尾（`lib/controller.js` 的 `closesWithReview`，`DISPATCH_DENIED` 在证据缺失时仍然生效）。因此“review 从未被派发、且 work 已结束”的死路，在 command 证据存在时被打开。
2. **谁能用预留**：`review` 执行体，或“已持有 command 证据的 plan”。`work`/`code` 永远不能花预留——否则它们可以无限吃掉收尾额度。
3. **准入规则（可直接执行）**：在普通额度还够时先把 command 证据做出来并**立刻**派发 review；不要等到预留生效才让它去派发。若 review 还没派发、普通额度或剩余时间已经见底，plan 的关轮回合仍在预留内可准入（`.34` 收尾例外 + 预留），但**前提是 command 证据已登记**。
4. **明确不可关的情形（合法停止条件）**：以下情形**没有**合法关轮路径，正确做法是停止并保持轮次未关闭（与 `.28` 的 R-1 相同），**不得**伪造 partial/blocked 关轮：
   - 该轮（非空）没有 command 证据，且普通额度/时间已经耗尽（关轮门禁对任何非空轮次都要求 command + review 两层证据，`blocked` 不豁免）；
   - 该轮已有 command 证据，但 review 在预留耗尽前都没有派发且 plan 也无法再准入。
5. **token 侧边界**：预留 token 的封顶是 `max(单个请求估算, ⌊轮预算/2⌋)`。所以当轮预算小于约 `2 ×（plan 输入估算 + outputCap）` 时，预留可能等于甚至大于整轮预算——此时 plan 自己的请求会被 `CLOSEOUT_RESERVE_PROTECTED` 拒绝。是否还能关轮取决于是不是已经派发过执行体：**从未派发**的轮次仍会以 `abortedEmpty` 的 partial/blocked 关轮（关轮工具本身不受预留限制，前提是当次关轮调用已在准入的回合里）；**已经派发 work 却拿不到 command 与 review 证据**的轮次才无法关轮，只能停止并保持未关闭。
6. **仍然不是保证**：预算是字节估算，真实结算可越界；授权不可变、证据不可跨轮复用；真实 Host 时序、流式中断、`wsl.exe` 被杀后 guest 进程存活等边界仍未实测。


## .40 的 profile 定位兼容修正（对桌面 Host 启动失败的修复）

.39 在桌面 profile 启动失败：桌面 Host 不导出 `DSH_PROFILE_DIR`，插件加载即抛
`AUTHORITY_LOCATION_REQUIRED`（真实启动日志 `desktop-next-2026-11-07.0.jsonl`）。.40 保留
"启动器变量优先"，并新增一条受限回退：仅当本包以实体副本安装在
`<profile>/node_modules/dsh-role-chain-protocol` 时，从 `import.meta.url` 推导 profile 目录，
且要求 `<profile>/package.json` 声明 `dsh.profile.bundles`。Windows 目录 junction 会保留自身路径，因此
照常推导到拥有该 junction 的同一 profile（实测）；`link:` 符号链接、pnpm 虚拟目录与无来源一律
按原样 fail closed，不猜测账本位置。判据、额度与门禁均未改变。新增
`test/profile-dir.mjs` 4 例；夹具组共 116 例 / 14 个文件。

## .39 的关轮预留修正（对 P1 真实失败的处理）

P1 真实轮次 `R-e214c77e` 已经产生真实短作业、command 证据与独立 review，但合法关轮被
`CLOSEOUT_RESERVE_PROTECTED` 拒绝，而当时只用了 800,000 token 中的 235,937。该轮保持未关闭、未补写；
原始账本、回执与转录都未修改。用冻结账本回放后，问题定位在预留记账而不是额度：

- `.38` 把预留请求数算成 `floor(tokens / perRequest)`。输入估算一涨，承诺的槽位反而减少，即使某个
  收尾回合已经按更大的槽位数被准入过——"取最大值"的估算与固定槽位承诺被同一段算术绑死。
- review 的首次准入发生在任何 review 估算存在之前，所以只取 `max(plan, review)` 仍撑不起首次 review
  支取（P1 的 review 估算是 72,755、plan 是 43,314；plan 只有 8,192 的轮次，预留 61,440，而一次 review
  支取要 94,096）。
- 某次收尾支取自身把输入估算推高时，判定用的仍是支取前的 perRequest，累计支取可以超过预留，而没有任何
  单次支取显得"太大"。

`.39` 把两件事拆开：`requests` 只由授权决定，是固定槽位承诺，不随估算重算；`tokens` 是 token 预留，
随估算单调不减，仍以轮预算的一半封顶且不低于一次请求；每次收尾支取按"包含本次待记输入"的预留判定
（`closeoutReserveOf(round, pendingInput)`）。轮预算、授权 envelope 与半额封顶都没有放宽，没有新增准入
路径；"关轮必须搭在已准入的回合上"这一前提不变。

验证：`test/closeout-reserve.mjs` 由 14 例增至 18 例（固定槽位 + token 单调、P1 真实收尾形状、review
首次/新最大值与重启恢复、封顶时的诚实拒绝与不透支）；夹具组 112 例 / 13 个文件。真实账本回放（在原账本
的临时副本上、只回退事后写入的 deadline stop；原文件 sha256 前后一致）复现 `.38` 的原始拒绝文案，并在
`.39` 上准入 257,704 ≤ 384,255（请求 19→20）。**未验证**：`.39` 没有真实 Host 工具入口与真实模型轮次；
下一次真实闭环仍需单独批准 Key Host 与模型请求。`.31`/`.34` 中"请求数按可用 token 重算"的表述以本节
为准；半额封顶的表述仍然成立。
