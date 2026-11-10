# dsh-role-chain（伞包 / umbrella bundle）

**给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 装上会分工的 AI 团队 —— 一个 bundle 装齐。**

选择 `plan`，说一句需求；规划、协调、实现、独立评审自动发生，最后由 plan 向你交付。

本包把 [L1 预设](../l1-presets/)（`plan / work / code / review` 四个席位，纯配置）与 [L2 协议](../l2-protocol/)（14 个 `chain_*` 工具、受控轮次账本、门禁、隔离计算、设置卡）合成**一次安装**。L1、L2 仍是唯一源码，本包内的所有协议文件都由 `scripts/sync-umbrella.mjs` 从它们生成，不用手改。

当前版本：`0.1.0`，内含 `dsh-role-chain-presets@1.1.0-workflow.1` + `dsh-role-chain-protocol@0.3.0-workflow.20261107.2`（记录于 `package.json` 的 `dsh.roleChain.contents`）。

> 完整的产品介绍、架构图与版本历史以[仓库根 README](../../README.md)为准；本文只讲"这个包怎么装、怎么生成、验证到哪一步"。

## 这是什么

DSH 原生只有"一个会话对一条消息"。**Role Chain 把它变成一个 4 人小组**：

| 角色 | 职责 | 关键约束 |
|:--:|---|---|
| 🧭 **plan** | 拆解任务、派发、汇总、面向用户交付 | 唯一能对用户讲话的角色；只读 |
| 🛠 **work** | 协调执行、把任务派给 code / review、回收结果 | 同轮复用；只读 |
| ⚙️ **code** | 写代码、跑验证、回报真实结果 | 唯一可写角色 |
| 🔍 **review** | 独立判断，给出 verdict / scope / uncovered | 每次新建、独立上下文；只读 |

默认是 **plan 原生工作流**：

- 不用先填额度、启动轮次或逐步批准，也不创建授权/用量账本；
- 需要证据与可核验关轮时，才走**显式受控轮次**（`/chain-authorize`，Host 命令，不产生模型请求）；
- plan/work 只读、code 写入、review 只读 —— 这是**提示词约定，不是文件系统隔离**。

> [!NOTE]
> 当前为 **PARTIAL / 试用版**。离线夹具与脚本全绿；真实 Host 的完整模型协作仍属未验证，见文末[明确未验证](#明确未验证)与根 README 的"已知限制"。

## 安装

```bash
dsh plugin --profile <profile> add github:Weihao654/dsh-workflow#path:/plugins/role-chain
```

然后让 profile 的 `dsh.profile.bundles` 出现 `dsh-role-chain`，重启 Host。市场条目为 `Weihao654/dsh-workflow#role-chain`（搜 `role-chain`）。

### 从两个旧 bundle 迁移（必须按此顺序）

> **迁移时必须先移除旧条目，再启用伞包。** 旧的两个 bundle 与伞包插入同一批 loader 行（`preset-*` ×4、`role-chain-protocol`）。同时启用在本机实测仍能启动、无报错、API 正常，但重复 id 是**静默覆盖**：保留哪一份取决于 `dsh.profile.bundles` 的顺序（实测把伞包排在最后，伞包的 `client` 生效；排在前面则旧包的 `client` 生效）。因此不要依赖顺序，先移除旧条目再启用伞包。

1. 备份 profile 的 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`。
2. 从 `dsh.profile.bundles` 中删除 `dsh-role-chain-protocol` 与 `dsh-role-chain-presets`。
3. 删除这两个包的依赖/`node_modules` 链接（旧的 `vendor/` 副本可先保留，回退时再用）。
4. 安装并启用 `dsh-role-chain`，重启 Host。
5. 验证：`/role-chain/api/table` 返回 `{"ok":true,...}`，设置卡出现，`plan` 席位可用。

回退：还原第 1 步的三份文件，删除 `node_modules/dsh-role-chain`，重新装回两个旧包，按旧方式启用。

## 目录结构与生成约束

```
package.json         # dsh.bundle.patch 两个文件；dsh.client 让设置卡挂载
presets.patch.yml    # 字节复制自 plugins/l1-presets/cordis.patch.yml
cordis.patch.yml     # 复制自 plugins/l2-protocol/cordis.patch.yml，仅把行名改为 './lib/index.js'
lib/ bridge/ locale/ icon.svg   # 复制自 plugins/l2-protocol/，保持与其包内相同的相对路径
scripts/sync-umbrella.mjs       # 生成器 + 漂移检查（不随包发布）
test/                           # 同步/工具/布局测试（不随包发布）
```

`lib/`、`bridge/`、`locale/` 采用**扁平镜像**而不是 `vendor/l2/` 子目录，是因为 L2 的 `lib/profile-dir.js` 用自身模块位置推导 profile：`<profile>/node_modules/<包名>/lib/index.js`。若放进 `vendor/l2/`，在**不导出 `DSH_PROFILE_DIR`** 的桌面 Host 上会以 `AUTHORITY_LOCATION_REQUIRED` 失败（已由 `test/layout.test.mjs` 同时钉住"可用形状"和"不可用形状"）。

`lib/client.js` 是与 L2 之间**唯一**的字节差异。L2 的 client bundle 以 `dsh-role-chain-protocol` 注册模块 id，而 client 装载器用 **Loader 行的包名**（这里是 `dsh-role-chain`）作为工厂 id；照抄 L2 的 id 会让该行被判为"未注册"，装载器随即回退到包内 URL 再执行同一脚本，第二次注册触发 `client-modules: duplicate factory registration for "dsh-role-chain-protocol"`，整个 web boot 失败（本机桌面版已实测）。因此生成器只改写 `id:`、`name:` 与日志文案三处为 `dsh-role-chain`，`test/generated.test.mjs` 钉住"恰好一处 id、一处 name，且 L2 源文件保持原样"。

## 开发

```bash
node scripts/sync-umbrella.mjs          # 重新生成镜像与两个 patch
node scripts/sync-umbrella.mjs --check  # 只检查漂移，非 0 退出
node test/run.mjs                       # 新增测试（每文件独立进程）
node test/run.mjs --in-process          # 沙箱禁止派生进程时的降级模式（较弱）
```

L2 的完整回归仍在原处：`cd ../l2-protocol && node test/run.mjs --in-process`。

**发布前必须**：先跑 `--check` 确认无漂移，再用 `npm pack --dry-run` 核对打包清单里包含 `lib/`、`bridge/`、`locale/`、`icon.svg`、两个 patch、`LICENSE`。

## 明确未验证

- 真实市场的一键安装（本仓库的包未发布到 npm；GitHub 子目录条目的安装 spec 未实测）。
- 隔离 Host 中的 GUI 渲染（席位/设置卡）；目前只有组合树、启动成功与 client 入口作为证据。
- 与旧两个 bundle 同时启用时，重复行被静默覆盖已实测（按 bundle 顺序后者生效），但"运行期到底实例化了几份插件"未直接观测到。

## 延伸阅读

| 文档 | 内容 |
|---|---|
| [仓库根 README](../../README.md) | 产品介绍、架构图、验证范围、版本历史 |
| [L2 使用说明](../l2-protocol/README.md) | 工具与受控轮次的具体行为 |
| [L2 验收范围](../l2-protocol/ACCEPTANCE.md) | 每个版本变了什么、验证了什么、没验证什么 |

## License

MIT，见 [LICENSE](LICENSE)。内含的 L2 代码同样为 MIT（`plugins/l2-protocol/package.json`）。
