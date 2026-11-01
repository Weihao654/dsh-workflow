# L2 轮次协议 · 0.2.0-rc.1

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
| `chain_dispatch` | plan→work；work→code/review；返回执行 ID、generation 与会话 ID |
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

更多：[设计](<DESIGN.md>) · [验收与未覆盖项](<ACCEPTANCE.md>)。
