# DSH Role Chain

用户 ↔ **plan → work → code → work → review → work → plan** ↔ 用户。

把角色协作与可验收轮次分开：L1 提供角色预设，L2 负责轮次、授权、停止、证据与预算状态。

## 当前状态

本仓库正在验证 **L2 0.2.0-rc.1**。这是源码候选版，不代表当前 DSH 已重新加载或完成生产验收。

- 停止先记录原因、范围和稳定请求 ID，再操作确切持有的 Agent/进程能力；`accepted`、`inactive`、名册为空都不是退出证明。
- work 同轮复用，code 默认按任务族复用，review 独立新建；忙碌或取消后不能用 `fresh`、改策略、删名册另开替身。
- 原始 T0 冻结一次，期限默认 90 分钟、允许缩短，不允许通过阶段切换、重试或控制器重建延长。
- 请求级账本统计可观察到的所有角色/重试请求；输入估算预留、输出限额、未结算用量保留 pending。**不是预付费绝对 token 上限，也不是账单。**
- 默认状态是六字段短卡；新范围、预算、业务规则或权限变更才要求用户决策。
- **当前安装的 Windows 隔离后端只承诺 partial，生产 `chain_compute` 因而拒绝启动。** Windows Job 只负责进程范围与期限，不是文件安全沙箱；不回退裸 shell 或远程计算。

## 两个包

| 包 | 用途 | 边界 |
|---|---|---|
| [L1 角色预设](<plugins/l1-presets/README.md>) | plan/work/code/review 及共同协议 | 可独立使用；没有 L2 时纪律主要依靠提示词与人工检查 |
| [L2 轮次协议](<plugins/l2-protocol/README.md>) | 14 个工具、持久状态、受控派发/停止、账本与模型设置卡 | 需要当前 Host API；候选版尚未完成真实 Host/GUI 集成验收 |

模型设置保留标准内置预设与 plan 的新会话入口，仅隐藏内部 work/code/review；手动选模优先于项目角色映射。effort 来自实际模型元数据，不硬编码档位。

## 使用与安装

先阅读 [L2 使用说明](<plugins/l2-protocol/README.md>)、[设计与限制](<plugins/l2-protocol/DESIGN.md>) 和 [验收范围](<plugins/l2-protocol/ACCEPTANCE.md>)。

安装/升级应通过 DSH 插件管理器，不能手工改 profile 配置。本仓库的两个包此前采用本地链接安装；历史上重新安装链接包曾清空源目录，**不要用重装链接包测试源码变更**。替换已加载 Host 模块需要受控重启后另做验收；本次没有执行重装、重启或替换 Web 服务。

关闭或停止的根 plan 会话不自动恢复推理。关闭工具返回收尾回执；下一轮目前要求新的根 plan 会话，不把关闭后的模型续请求当作授权。

## 验证

从 L2 包目录执行：

```powershell
node --test test/control.mjs test/usage.mjs test/git.mjs test/smoke.mjs test/dispatch.mjs
node test/routes.mjs
node test/api.mjs
node test/windows.mjs
```

前三类主要为真实控制器加假 Host/Agent 的确定性测试。Windows 原生短任务测试会启动真实监督器与子孙进程，但显式使用 **fake-full 隔离契约**，只检查原生 Job、期限、参数和停止竞态；不能据此证明安全隔离、真实 Host 崩溃恢复或生产可用性。测试结果与未覆盖项见 [验收说明](<plugins/l2-protocol/ACCEPTANCE.md>)。

Git 基线查询禁用已发现的过滤器及 fsmonitor/hook 回调，跳过子模块脏状态检查；该 dirty 结果只覆盖顶层工作树，可能不同于普通 Git status。

## 发布

仓库：[Weihao654/dsh-workflow](https://github.com/Weihao654/dsh-workflow)。市场提交：[PR #10945](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10945)；是否合并必须查看实际当前状态，不能由提交成功推断。

MIT。包内链路图标为本项目原创 SVG；架构说明图不是插件运行截图。
