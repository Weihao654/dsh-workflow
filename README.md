# dsh-workflow · 角色链的工作流插件

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的两个 bundle，把 `plan → work → code → work → review → work → plan` 这条角色协作链从"团队约定"变成"可由机器执行的纪律"。

```
用户 ↔ plan → work → code → work → review → work → plan → 用户
```

每轮六步：**核对基线 → 收敛方案与授权 → 连续实施（唯一 T0）→ 限定修正（失败/重试/重启累计计数）→ 独立终审（分层证据不得互相扩大）→ 交付并关闭**（版本 / 结果 / 未覆盖项 / 费用 / 停自有服务）。

![角色链与一轮六步](assets/architecture.png)

---

## 两个部分

| 目录 | 是什么 | 状态 |
|---|---|---|
| [`plugins/l1-presets/`](./plugins/l1-presets/) | **纯配置**：四个 preset（plan / work / code / review）的人设与工具矩阵，外加 `protocol/ROUND-PROTOCOL.md` 可抄进项目 `AGENTS.md`。零宿主代码 | v1.0 已装 |
| [`plugins/l2-protocol/`](./plugins/l2-protocol/) | **协议插件**：9 个 `chain_*` 工具 + 轮次状态机，把 T0 唯一、计数越限、证据分层、门禁阻塞、收尾校验变成硬约束，并把每轮落盘成审计文件 | v0.1（P0）已装，21 条自测通过 |

分开是有意的：L1 决定"谁有什么工具"，L2 决定"事实必须成立"。L2 依赖 L1（按角色判定），L1 不依赖 L2（不装 L2 也能用，只是纪律靠自觉）。

## 装

顺序：先 L1，后 L2，然后**新开会话**（preset 与工具集在会话创建时冻结）。

从本仓库直接装，不需要发布到 npm（`#path:` 选子包）：

```
plugin_manager install_bundle target: github:Weihao654/dsh-workflow#path:/plugins/l1-presets
plugin_manager install_bundle target: github:Weihao654/dsh-workflow#path:/plugins/l2-protocol
```

本地开发时也可以直接指向目录：

```
plugin_manager install_bundle target: <本仓库>/plugins/l1-presets
plugin_manager install_bundle target: <本仓库>/plugins/l2-protocol
```

两者都是普通 DSH bundle（`dsh.bundle.patch` 指向各自的 `cordis.patch.yml`），安装后可在插件列表确认 `fiberPhase: active`。详细前置、卸载与验证见各自 README。

## 开始：新会话只剩 plan

装好后新建会话，**预设选择器只显示 `plan`**：

- L1 把预设注册表的默认值改成 `plan`——新会话默认就落在链路里，不用挑。
- L2 带一个客户端半身，把 New Session 的预设控件换成一个静态 `plan` 标签。DSH 的预设名册没有"从选择器隐藏"的字段，所以这是唯一不改宿主代码的做法（单槽位按优先级遮蔽，官方也允许这么干）。

work / code / review 因此**只能由 plan 派发**，符合链路本意。仍要单独开 work 或 review 会话（旧的"方式 B / 方式 C"），两条路：

1. 设置 → Agent presets → 把默认改成 work 或 review；或
2. 去掉 `plugins/l2-protocol/package.json` 里的 `dsh.client` 段，重装（或重启）后官方选择器回来。

两种做法都是**故意让根会话跑在非 plan 角色上**，这时 `chain_*` 工具仍按角色拒绝，不会假装它是合法入口。

## 一眼看懂差别

不装 L2 时，"这一轮只有一个 T0"是一句提示词，模型忘了就忘了；
装了 L2，`chain_freeze_baseline` 第二次调用直接抛 `BASELINE_ALREADY_FROZEN`，且 T0 是插件自己跑 `git rev-parse HEAD` 得到的，不听模型自述。

同理：同一个测试失败第 3 次会 `exceeded`，越限的轮子 `chain_close_round` 关不掉（除非有用户批准的 `force` 门禁），关掉的轮会自动产出 `.dsh/rounds/<roundId>.json`。

## 诚实声明

- "角色看不见不该有的工具"在 L1 是**结构性**的（工具没挂），在 L2 的 P0 是**代码拒绝**（`ROLE_DENIED`）——迁移计划见 `plugins/l2-protocol/DESIGN.md` §15。
- `work` 的只读是**软的**：它需要 shell 跑验证命令，所以仍能重定向写文件。
- 门禁弹卡这一条只能在你自己的会话里验证，步骤见 `plugins/l2-protocol/ACCEPTANCE.md`。

## 关键词

`deepseek-harness` `dsh` `cordis` `plugin` `agent-preset` `workflow` `round` `audit` `role-chain` `subagent`
