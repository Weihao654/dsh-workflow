# DSH Role Chain

用户 ↔ **plan → work → code → work → review → work → plan** ↔ 用户。

默认选择 plan 后直接发送任务：plan 调研，work 协调 code 实施和 review 独立审核，再回到 plan 交付。无需先填额度、启动轮次或批准每一步，日常权限与执行沿用 DSH 原生行为。

## 当前状态

当前交付为 **L1 1.1.0-workflow.1 + L2 0.3.0-workflow.20261107.2**，已安装独立 vendor，209 项离线夹具测试与 api/routes 脚本通过。旧版本和授权账本保留；**重开后的真实 Host/GUI 加载与完整模型协作仍待验证**（安装与离线验证期间真实模型请求为 0）。

L1 提供原生协作角色；L2 提供默认 plan 工作流、角色模型设置，并识别、保留已有受控任务。新会话不创建授权账本，不受插件请求计数、收尾预留和强制 `chain_compute` 影响。旧受控任务不因升级续额或重置，新日常任务新建 plan 即可。

## 默认工作流

- 选择 plan，直接发消息。简单问答 plan 直接回答；实施任务按 plan → work → code → work → review → work → plan 回流。
- 不创建 L2 授权/用量账本，不套输出上限、请求计数、关轮预留，也不强制 `chain_compute`；加载状态未知时不临时禁用输入。
- 13 个受控工具通过官方 scoped `tools.restrict` 对新工作流隐藏，原生工具、权限与角色模型设置保持有效。
- plan/work 只读，code 写入，review 只读；这是提示词约定，不是文件系统隔离。
- 只有缺少关键资料、需要用户决定业务取舍或超出任务范围时才询问，不逐步批准内部工作。

## 显式受控轮次

以下机制只适用于已有授权或用户主动选择的受控轮次：

- 停止先记录原因、范围和稳定请求 ID，再操作确切持有的 Agent/进程能力；`accepted`、`inactive`、名册为空都不是退出证明。
- work 同轮复用，code 默认按任务族复用，review 独立新建；忙碌或取消后不能用 `fresh`、改策略、删名册另开替身。
- 原始 T0 冻结一次，期限默认 90 分钟、允许缩短，不允许通过阶段切换、重试或控制器重建延长。
- 请求级账本统计可观察到的所有角色/重试请求；输入估算预留、输出限额、未结算用量保留 pending。**不是预付费绝对 token 上限，也不是账单。**
- 默认状态是六字段短卡；新范围、预算、业务规则或权限变更才要求用户决策。
- 关轮预留分两个独立承诺：槽位只来自授权（`min(closeoutRequests, 请求数/4)`，不随估算重算），token 预留随输入估算单调不减并受半额预算封顶；每次关轮请求按"自身输入 + 输出上限"与该预留比较，不会透支。
- `chain_compute` 需要完整隔离才启动；当前桌面配置走 guest-runner（WSL bwrap），曾在隔离 profile 的真实闭环中验证过一次短作业，**不代表其他机器/配置同样可用**。Windows Job 只负责进程范围与期限，不是文件安全沙箱；不回退裸 shell 或远程计算。

## 两个包

| 包 | 用途 | 边界 |
|---|---|---|
| [L1 角色预设](<plugins/l1-presets/README.md>) | plan/work/code/review 及共同协议 | 可独立使用；没有 L2 时纪律主要依靠提示词与人工检查 |
| [L2 轮次协议](<plugins/l2-protocol/README.md>) | 默认 plan 工作流、14 个工具、受控派发/停止、账本与模型设置卡 | 需要当前 Host API；真实 Host/GUI 集成验收未完成 |

模型设置保留标准内置预设与 plan 的新会话入口，仅隐藏内部 work/code/review；手动选模优先于项目角色映射。effort 来自实际模型元数据，不硬编码档位。

## 使用与安装

先阅读 [L2 使用说明](<plugins/l2-protocol/README.md>)、[设计与限制](<plugins/l2-protocol/DESIGN.md>) 和 [验收范围](<plugins/l2-protocol/ACCEPTANCE.md>)。

安装/升级应通过 DSH 插件管理器，不能手工改 profile 配置。本仓库的两个包曾采用本地链接安装；历史上重新安装链接包曾清空源目录，**不要用重装链接包测试源码变更**。替换已加载 Host 模块需要受控重启后另做验收。

关闭或停止的根 plan 会话不自动恢复推理。关闭工具返回收尾回执；下一轮目前要求新的根 plan 会话，不把关闭后的模型续请求当作授权。

## 验证

从 L2 包目录执行：

```powershell
node test/run.mjs                 # 21 个夹具文件、209 例（默认每文件独立子进程）
node test/run.mjs --in-process    # 沙箱禁止 spawn 时的等价回退
node test/api.mjs
node test/routes.mjs
```

夹具以真实控制器 + 假 Host/Agent 为主，确定性执行，不产生付费模型请求。Windows 原生短任务测试会启动真实监督器与子孙进程，但显式使用 **fake-full 隔离契约**，只检查原生 Job、期限、参数和停止竞态；不能据此证明安全隔离、真实 Host 崩溃恢复或生产可用性。测试结果与未覆盖项见 [验收说明](<plugins/l2-protocol/ACCEPTANCE.md>)。

Git 基线查询禁用已发现的过滤器及 fsmonitor/hook 回调，跳过子模块脏状态检查；该 dirty 结果只覆盖顶层工作树，可能不同于普通 Git status。

## 版本历史

| 版本 | 内容 |
|---|---|
| 0.3.0-workflow.20261107.2 | 默认 plan 原生工作流（无授权卡/预算）；受控工具经 scoped filter 隐藏；209 例夹具 |
| 0.2.1-rc.20261107.40+scopefix.1 | 普通会话不再被要求轮次绑定；新增 session 位置校验 |
| 0.2.1-rc.20261107.40 | 无 `DSH_PROFILE_DIR` 时从安装路径推导 profile；失败即拒绝而非猜测 |
| 0.2.1-rc.20261106.39 | 关轮预留修正：槽位承诺固定、token 预留单调、关轮含当前输入 |
| 0.2.1-rc.20261106.38 | 真实短作业 + 独立 review 证据；关轮曾被预留拒绝（.39 修复） |
| 0.2.0-rc.1 | 受控轮次、派发/停止、账本项目与证据门禁 |

## 发布

仓库：[Weihao654/dsh-workflow](https://github.com/Weihao654/dsh-workflow)。市场提交：[PR #10945](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10945)；是否合并必须查看实际当前状态，不能由提交成功推断。

MIT。包内链路图标为本项目原创 SVG；架构说明图不是插件运行截图。
