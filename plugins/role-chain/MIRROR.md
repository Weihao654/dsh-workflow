# 伞包的镜像结构与生成约束

本文件是 `dsh-role-chain` 的维护者文档：说明包内复制品从哪来、为什么长这样、怎么重新生成和验收。
产品介绍与安装说明见 [README.md](README.md)。

## 目录结构与生成约束

```
package.json         # dsh.bundle.patch 两个文件；dsh.client 让设置卡挂载
presets.patch.yml    # 字节复制自 plugins/l1-presets/cordis.patch.yml
cordis.patch.yml     # 复制自 plugins/l2-protocol/cordis.patch.yml，仅把行名改为 './lib/index.js'
lib/ bridge/ locale/ icon.svg   # 复制自 plugins/l2-protocol/，保持与其包内相同的相对路径
scripts/sync-umbrella.mjs       # 生成器 + 漂移检查（不随包发布）
test/                           # 同步/工具/布局测试（不随包发布）
MIRROR.md                       # 本文件（不随包发布）
```

`lib/`、`bridge/`、`locale/` 采用**扁平镜像**而不是 `vendor/l2/` 子目录，是因为 L2 的
`lib/profile-dir.js` 用自身模块位置推导 profile：`<profile>/node_modules/<包名>/lib/index.js`。
若放进 `vendor/l2/`，在**不导出 `DSH_PROFILE_DIR`** 的桌面 Host 上会以
`AUTHORITY_LOCATION_REQUIRED` 失败（`test/layout.test.mjs` 同时钉住"可用形状"与"不可用形状"）。

## client bundle 的模块 id

`lib/client.js` 是与 L2 之间**唯一**的字节差异。L2 的 client bundle 以 `dsh-role-chain-protocol`
注册模块 id，而 client 装载器用 **Loader 行的包名**（这里是 `dsh-role-chain`）作为工厂 id。
照抄 L2 的 id 会让该行被判为"未注册"，装载器随即回退到包内 URL 再执行同一脚本，第二次注册触发：

```text
client-modules: duplicate factory registration for "dsh-role-chain-protocol"
```

整个 web boot 失败（本机桌面版实测）。因此生成器只改写 `id:`、`name:` 与日志文案三处为
`dsh-role-chain`，`test/generated.test.mjs` 钉住"恰好一处 id、一处 name，且 L2 源文件保持原样"。

## 开发与验收

```bash
node scripts/sync-umbrella.mjs          # 重新生成镜像与两个 patch
node scripts/sync-umbrella.mjs --check  # 只检查漂移，非 0 退出
node test/run.mjs                       # 新增测试（每文件独立进程）
node test/run.mjs --in-process          # 沙箱禁止派生进程时的降级模式（较弱）
```

L2 的完整回归仍在原处：`cd ../l2-protocol && node test/run.mjs --in-process`。

**发布前必须**：先跑 `--check` 确认无漂移，再用 `npm pack --dry-run` 核对打包清单里包含
`lib/`、`bridge/`、`locale/`、`icon.svg`、两个 patch、`LICENSE`。当前包为 33 个文件。

## 版本记录

`package.json` 的 `dsh.roleChain.contents` 记录本镜像来自哪两个源码版本；源码版本变化时
运行 `sync-umbrella.mjs` 写入模式会自动更新该字段，`--check` 会报告漂移。
