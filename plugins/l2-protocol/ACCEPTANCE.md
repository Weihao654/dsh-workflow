# 候选版验收记录 · 0.2.0-rc.1

日期：2026-11-01（Asia/Shanghai）。这是源码/短任务验收，不是已安装 Host 的生产验收。

## 本次结果

| 层级 | 命令/对象 | 实际结果 | 能证明的范围 |
|---|---|---|---|
| 确定性控制器 | `node --test test/control.mjs test/usage.mjs test/git.mjs test/smoke.mjs test/dispatch.mjs` | **36/36 通过** | 真实插件控制逻辑 + 假 Host/Agent；其中 Git 用真实临时仓库探测回调禁用 |
| 模型路由兼容 | `node test/routes.mjs` | **58/58 通过** | 路由、手动选择优先、设置读写及真实 effort 元数据校验逻辑 |
| 设置 API 兼容 | `node test/api.mjs` | **38/38 通过** | 假 WebServer/LLM 接口契约；不证明真实 GUI 的视觉/交互 |
| Windows 原生短任务 | `node test/windows.mjs` | **4/4 通过** | 真实监督器/Job/根进程及后代；Host 接口与 full 隔离契约是 stand-in |
| 源码检查 | 所有 lib JavaScript 的 `node --check`；`git diff --check` | 通过 | 语法/空白，不等于运行时兼容 |

原先 smoke 21、dispatch 51 条原型检查已由受控 fixture 替换，不保留“任意错误 fallback spawn”等错误期望。不要把旧计数与新测试相加。

### 控制与账本覆盖

- T0/90 分钟上限、重复冻结不续期、Git 错误不伪装 no-git、控制器重建固定期限。
- 同轮序列化复用、review 独立、忙碌拒绝、fresh/策略/release 不能建替身、续聊失败不另 spawn。
- 原因/范围/稳定 requestId 先持久化，再取消；重复/冲突/迟到启动/代际隔离/自然完成。
- Team/native 错通道、伪造 user/Agent 身份拒绝；真正用户离线父会话入口不等于退出证明。
- 旧 Agent disposal 不证明冷恢复的新 Agent；实际祖先可以停止 code 的作业。
- 缺失/partial 隔离不创建 Host job；隔离准备中取消不晚启动；未 joined 的文件回执保持 unknown。
- 原生锁超时只确认意图持久化，`nativeAdmission` 保持 pending，不能承诺意图时刻所有 Create/Resume 已停。
- 六字段短卡、控制文件/Git 元数据写保护、阶段性 blocker、无回答不批准、损坏/缺失库存失败关闭。
- 全角色/复用阶段/可观察重试累计、最新 usage 快照、重复回执、晚到原代际、未结算下界与剩余预留。
- 开轮前规划请求持久日志/一次收养；未知归属撤销受控后续但不取消无关流；响应后超额记录，不谎称绝对预算天花板。
- 收尾要求其他执行实际退出；金额未知不填零；force 显示并保存不可变计数快照，后续计数增加不被旧批准覆盖。

### 原生样本

机器可读样本：[Windows 结果](<test/results/windows.json>)。

1. 原生 Job 包含根进程与后代，停止后 ActiveProcesses=0；最近样本 signal→exit **39 ms**，请求→观察 **189 ms**。仅是一次短任务样本，不是延迟 SLA。
2. 去掉 Host 定时器后，监督器仍沿用原绝对期限，在期限前退出；signal→exit 样本 **31 ms**。这不是实际 Host 强杀测试。
3. 准备后持有共享启动锁并提交停止，原生结果 cancelled-before-create、launched=false、Job empty。
4. 空格/引号/反斜杠/中文参数往返、自然完成后迟到停止不改写结果、回执身份错保持 unknown。

每个原生样本均明确标记 **fake-full contract; OS isolation NOT verified**。真实生产 Windows provider 只提供 partial，插件实际会拒绝该计算路径。

## 独立复审

- 初次静态审核发现 5 项高/中问题：控制文件可被计算篡改、复用替身、旧 Agent 事件、原生启动竞态、祖先取消权限。对应修复已落入源码/回归。
- 第二次静态审核结论 FAIL，发现子模块过滤器和锁超时语义缺口。随后 status 改为忽略子模块并披露覆盖范围；停止意图与原生封闭确认分开，异常路径不再承诺即时 fence。
- 第三次限定复审结论 **bounded PARTIAL**：上述 Git/停止语义修复在源码层通过；发现 force 快照没有保证显示给用户。随后已把不可变快照加入真实 approval question、保存实际显示文本，超过 4000 字符拒绝请求，并加回归。
- 最后一项展示修复是作者修复 + 回归验证，**未另行独立复审**。不把原 partial 报告改写成独立全项 PASS。

审核均只读，没有启动测试/其他代理、改配置或管理历史 v15。源码复审不能扩大为真实 Host/安全隔离/崩溃验收。

## 尚未覆盖／阻塞

1. **生产计算能力阻塞**：安装的 Windows 隔离契约为 partial；没有实际可用的 full 只读后端。本轮选择拒绝而非绕过，不等于完整生产计算已交付。
2. 未重启/重新安装/重新加载当前 Host，未验证真实 subagents/jobs/subprocess/LLM hook 的端到端行为或当前 GUI。
3. 未复现 CreateProcessW 内部卡住超过锁超时的实际原生时序；确定性 fixture 只验证 pending 语义。已进入原生临界区的操作可能在停止意图持久后继续，直到拿锁/监督器取消/范围 join。
4. 未做真实 Host crash/机器故障、进程树逃逸、安全对抗、跨 Host 状态写入、远程/POSIX 执行。未知能力恢复不以文件或空库存证明已停。
5. Git dirty 只覆盖顶层工作树且过滤器关闭，忽略子模块；恶意外部并发配置、环境或管理员篡改不在保证内。固定 Git 查询不是完整登记的轮次计算 job。
6. 请求用量为可观察 hook + 估算/后响应回执；隐藏 provider 内重试与实际账单未验证。关闭审计可能先于晚到 usage，需要显式新导出。
7. 关闭/停止根会话不自动恢复模型推理或下一轮；目前用新根 plan，会有 close 工具后无法再生成普通总结的 UX 限制。
8. **旧 v15 停止仍未确认**；本次未恢复、接管或用测试替代它的退出证据。

## 部署、发布与资源

未改 profile、未重装本地链接包、未启动替代 Web 服务；不把源码测试说成当前页面已生效。市场 PR #10945 在本次认证只读查询中为 open、merged=false；没有推送候选版或修改该 PR。

候选包新增原创 SVG 图标与中英元数据。`npm pack --dry-run --ignore-scripts --json` 最终分发清单含 26 文件（包括文档引用的原生样本 JSON），已检查新运行模块/监督器/启动锁/patch/locale/icon/三份文档均在包内；SVG 为有效 XML、613 bytes。未安装，图标格式校验不等于当前 GUI 已渲染。

工具描述的 JSON footprint（14 个工具）为 **7103→7114 字符，9669→9690 UTF-8 bytes**。这是 schema JSON 代理指标，**没有真实第一轮 tokenizer token 测量**，不宣称 token 节省。

历史测试中出现过：Git filter 数量误假定为 2（实际继承全局键为 6，现按至少包含 fixture 键判断）；新增 fixture 错等所有尚活跃 Agent observation 导致挂起（已取消并修正清理）；NO_CONTROLLER 回执误当异常（已修正断言）。最终通过结果来自修正后的新运行，不隐藏这些失败，也不把被取消测试进程的退出当产品失败。
