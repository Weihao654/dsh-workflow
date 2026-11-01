# L2 设计与保证边界（0.2.0-rc.1）

本文件取代早期 0.1 原型设计。旧版“任何续聊失败就新建”“名册删除即可重建”“tokenMeter 可当累计账单”等描述不再适用。候选版源码不等于当前 Host 已加载。

## 1. 状态与能力分开

- [store.js](<lib/store.js>)：按规范化项目根共享进程内队列，读取等待写队列，原子临时文件 fsync/rename；损坏或已见文件被删除时失败关闭，不静默生成空库存。没有跨进程/跨 Host 写锁。
- [runtime.js](<lib/runtime.js>)：round/execution/generation、会话绑定、原始期限、累计计数、停止意图与三态聚合。
- [controller.js](<lib/controller.js>)：持有实际 activation.dispose、Agent、父 Agent、AbortController、监督器与定时器能力。持久 ID 是定位信息，不是权限。
- [usage.js](<lib/usage.js>)：请求预留、回执、预规划日志收养、晚到回执与归属不确定性。
- [service.js](<lib/service.js>)：Git 基线、证据、门禁、收尾。

绑定身份为 `(roundId, executionId, generation, sessionId)`；作业额外绑定 nonce。晚到事件只能写原执行，不能信号新代际。旧历史退出未知时不迁移到新绑定制造“已停”。

## 2. 派发与复用

实际权限链只有 plan→work、work→code/review。仅本机 spawn provider，并要求 preset 能力；无远程替代。

新建前持久预留执行身份，进入 provider 前重新检查屏障/期限/阶段。启动返回太晚而已被撤销时，收割确切 handle，不给正常 ack。启动前明确失败可证明 not-started；已经进入 provider 的失败不能推断从未启动。

work 同轮 persistent；code 默认 family，也可 persistent；review 总 fresh。sameSlot 从轮次历史按实际父会话/角色/任务族决定，不依赖可删名册。忙碌子树任一 Agent/job 未证实退出则 CHILD_BUSY；停止历史拒绝恢复，fresh/policy/release 不能替换。续聊错误不 catch-all fallback spawn。

同会话复用可能发生冷恢复，不保证同一常驻 Agent。全局唯一源码写入仍由 work 安排：不同族不是自动文件互斥锁。

## 3. 停止分三个阶段

1. 内存屏障立即拒绝该执行/后代的新派发与请求。
2. 原因、目标、稳定 requestId 持久化为 **停止意图**，然后才发取消信号。
3. 分别取得原生启动封闭与 Agent/job 退出证据。

同 requestId 重试幂等，换目标/原因冲突拒绝。实际模型调用者必须匹配当前 live Agent；非根取消需要真实执行祖先关系，作业还需持有确切能力。真正人类 `/chain-stop` handler 使用模块私有授权，不接受模型伪造 user 对象或 HTTP header 授权。

`admission: persisted` 仅阶段 2。`nativeAdmission: pending` 和执行列表表示阶段 3 仍不完整。

### 原生锁与超时

[admission.js](<lib/admission.js>) 与 [Windows 监督器](<lib/windows-supervisor.ps1>) 使用同一独占文件。正常路径锁覆盖 Create+Resume 与停止标记提交；原生创建前/恢复前都重查标记和绝对期限。

锁超时不能被描述成已建立原生 fence：保持 nativeAdmissionPending，持久意图后取消确切监督器，等待以后拿锁写标记或可信范围 join。原生调用可能早已进入临界区，**没有“意图落盘瞬间所有 Create/Resume 都已停止”的异常路径保证**。新启动的 Host 准入仍被内存/持久屏障拒绝；已进入启动过程的资源作为竞态收割，退出不明则 pending。不会删未知 stale lock 来假装取得权限。

Agent 自然完成保持 completed；停止不把自然完成倒写成“成功取消”。activation.result 不足以证明清理成功，必须等 exact dispose；缺失 drain 目标不是尚在启动任务的退出证明。Agent.whenIdle 只证明该 Agent，不证明子进程。disposed 事件匹配 exact Agent 实例，不按同一 sessionId 扫描新代际。

## 4. Windows 作业与隔离

[managed-jobs.js](<lib/managed-jobs.js>) 先持久身份，再准备隔离/后端，Host jobs.start 预检后登记实际 Job 并 ack。只有 sandbox.confine 返回 `full` 且策略为 read-only，才把包裹后的目标 argv 交给监督器；partial、缺失、异常全部拒绝，不回退裸 shell。

当前安装 Windows provider 声明 partial，所以当前生产计算是 **不可用/拒绝**，不是降级可用。Windows Job 不是安全隔离。独立监督器保留写权威回执所需权限，目标进程须由完整只读隔离限制，防止修改控制文件；不声称抵御同用户外部程序或管理员。

监督器使用 KILL_ON_JOB_CLOSE、原子 JOB_LIST 分配、显式 HANDLE_LIST、悬挂创建后恢复；原始绝对期限与内部宽限不重置。轮询停止、期限与输出上限，退出要求原生 ActiveProcessCount=0。

Host 端同时等待 done 与 waitForExit；只有 exact live capability 的 providerJoined 与身份匹配的 native receipt 同时成立，才能确认作业退出。文件 nonce 不是独立认证，未 join 或重启后缺能力不能只读文件就证明退出。signalAt、exitAt、latency、deadlineMet 分开；范围空但超时不等于按时停止。

## 5. 期限、token 与费用

T0 只冻结一次，默认 90 分钟，可缩短，不可延长。宽限在预算内；控制器重建沿用原绝对时间。监督器能独立执行时间检查，不等于已做真实 Host 强杀/机器故障测试。

每个可观察 llm/stream attempt 唯一 Qid；provider I/O 前写入输入估算和输出 cap 预留。账本累加所有角色、阶段与重试，不用上下文 tokenMeter 代替累计量。最新 usage 快照覆盖同次 attempt，不逐块相加；cache/reasoning 是总量子集。

中断/缺 usage 保留 pending，已知部分是下界，预留剩余不被释放成零费用。无法归属的 stream 标记受控轮次 uncertainty 并撤销后续执行，不擅自取消无关 stream。

根 plan 开轮前请求先持久 planningUsage，首次匹配开轮只收养一次；晚到回执写回原轮，不追随新代际。开轮前请求标明尚未获本轮预算，不能倒推成预算保护。

输出 cap 在 agent/request 限定，不修改冻结的 stream options。输入估算、隐藏 provider 内重试、后响应 usage 都限制了绝对控制能力。超过预算会记真实观察值并关闭后续准入；不承诺每次账单都不超。金额未知始终 unknown。

## 6. 门禁、基线与证据

门禁只收具体的新 scope/budget/business-rule/new-authority，要求变更、原授权和缺口；明确肯定才授权。force 捕获提问时计数快照，新增失败不自动沿用旧批准；不能清停止/期限/token 屏障。

技术 blocker 只暂停相关 phase；NOT_GATED 是分类结果，不是安全许可。accept 只用于已有独立终审的 closeout。

固定 Git 查询有 5 秒超时并观察调用信号；禁用 fsmonitor/hooks/已发现 filter，status 使用 `--ignore-submodules=all`。dirtyCoverage 明确只覆盖顶层、过滤器关闭的工作树。不会把 Git 出错冒充 no-git；只识别明确 not-a-git-repository。尚未把固定 Git 查询统一登记为完整受控计算 Job；恶意外部并发配置/环境与 Host 崩溃不在验收范围。

command/artifact/self-report/review 不互相扩大。收尾检查其他执行真实退出，根 Agent 因正在执行 close 工具而除外；这不是“整个 Host 已停止”。导出是当时快照，晚到 usage 仍更新持久账本，可显式重新导出。

## 7. 部署与剩余验收

模型工具 guard 使用真实定义/execute 身份与参数形状，不按同名 Team/native 工具猜管理通道；默认拒绝未审核能力。直接控制文件及 Git 元数据写入受保护，但不构成 OS 安全沙箱。

关闭或停止的根 plan 不能自动推理续跑，下一轮当前要求新根会话；因此 close 工具回执是收尾输出，不能承诺模型关闭后再生成普通总结。

本次不重装链接包、不改 profile、不启动替代 Web 服务。当前 Host/GUI 是否重新载入源码未验证；完整限制与测试层级见 [验收说明](<ACCEPTANCE.md>)。
