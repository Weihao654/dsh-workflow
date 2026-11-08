# dsh-role-chain（伞包 / umbrella bundle）

**一个 bundle 装齐 role-chain**：本包把 [L1 预设](../l1-presets/)（plan / work / code / review 四个席位，纯配置）和 [L2 协议](../l2-protocol/)（14 个 `chain_*` 工具、受控轮次账本、门禁、隔离计算）合成**一次安装**。L1、L2 仍是唯一源码，本包内所有协议文件都由 `scripts/sync-umbrella.mjs` 从它们生成。

当前版本：`0.1.0`，内含 `dsh-role-chain-presets@1.1.0-workflow.1` + `dsh-role-chain-protocol@0.3.0-workflow.20261107.2`（记录于 `package.json` 的 `dsh.roleChain.contents`）。

## 安装

把本目录作为 profile bundle 启用即可（需要在 profile 的 `dsh.profile.bundles` 里出现 `dsh-role-chain`，并让本包可被 profile 的 `node_modules` 解析）。

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

## License

MIT，见 [LICENSE](LICENSE)。内含的 L2 代码同样为 MIT（`plugins/l2-protocol/package.json`）。
