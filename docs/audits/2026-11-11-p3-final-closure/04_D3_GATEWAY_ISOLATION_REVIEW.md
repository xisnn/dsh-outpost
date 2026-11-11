# 04 · D-3 网关注册表隔离调查（只调查 + 负向测试，不改生产路径）

- 状态：**PASS（调查完成；负向测试已执行并复现缺陷；修复方案与测试设计已给出；未实施生产修复）**
- 证据级别：STATIC_REVIEW + UNIT_TEST（虚构数据子进程负向测试）。**未启动任何服务、未占用端口、未触碰真实注册表。**
- 产物目录：`E:/work/p3-android-e2e/d3-isolation/`（脚本、stdout/stderr、虚构 fixtures、只读核对记录）

## 1. 根因

插件 `dsh-plugin-mobile-gateway` 0.10.3 在 `apply()` 内**内联**解析默认路径，只认 `os.homedir()`：

- `lib/index.mjs:2255` `options.deviceFile || path.join(os.homedir(), '.dsh', 'mobile-gateway-devices.json')`
- `lib/index.mjs:2265` `gatewayStateFile` 默认 `` `${deviceFile}.gateway.json` ``
- `lib/index.mjs:3220` `cloudflareStateFile` 默认 `` `${deviceFile}.cloudflare.json` ``
- schema 默认空串：`:230` / `:218` / `:240`

全插件仅 2 处 `os.homedir()`（另一处 `:974` 为目录浏览），**0 处** `DSH_HOME` 引用。而 DSH 核心早有权威解析器 `@deepseek-ai/dsh-home-paths`（优先级：显式配置 > `$DSH_HOME` > `~/.dsh`，空白 env 视为未设），插件未依赖它。

**上游缺陷，非本地补丁引入**：安装包内 `lib/index.mjs.orig:2255` 与安装版逐字一致；本地 Outpost 补丁插在 2704 行之后。

## 2. 六问

1. **默认忽略 DSH_HOME？** 是，`index.mjs:2255`（另两处派生自它）。
2. **哪些路径读正式数据？** `~/.dsh/mobile-gateway-devices.json`（`devices.js:62`，构造即 `load()` `:98`；启动日志 `index.mjs:2691` 打印 devices=35）、同名 `.gateway.json`（`gateway-state.mjs:19,34`）、`.cloudflare.json`（`cloudflare-tunnel.mjs:29,66`）。
3. **会写正式数据吗？会。** 写盘统一走 `devices.js:52-58`（tmp+rename）：`:85` 仅加载即重写（version≠3 或含 v1 明文 token）；`:170` 配对成功；`:186/:193` 认证补 clientDeviceId/改名；`:204` **lastSeenAt（手机一连就写）**；`:219` 吊销。网关状态 `gateway-state.mjs:20-30,50-55`（管理端切模式、temporary 超时自动 disabled）。本轮正式注册表 sha256 未变是因为它已是 version=3 且全 tokenHash（`:85` 不触发）且本轮没有手机连到正式实例——**一次连接或改名就足以改写正式文件**。
4. **跨实例授权/状态混淆？会，已执行复现（S7）。** 两实例同文件 ⇒ 共享 gatewayId；各自内存快照 + `save()` 全量覆盖 ⇒ A 的 lastSeenAt 被 B 回滚；A 吊销后 **B 仍接受已吊销 token**（`devices.js:177` 只查内存）；`setMode` 用 rename 无 `linkSync` 保护 ⇒ 磁盘 disabled 而 A 内存 persistent。
5. **向后兼容的默认隔离设计：** 把 `:2255` 抽成导出函数 `resolveDeviceFile(options)`，优先级 `options.deviceFile`（非空）> `$DSH_HOME`（非空白）> `os.homedir()/.dsh`；优先 import 核心 `dshHomePath`，不可解析时回退内联读 env。`:2265/:3220` 保持派生自 deviceFile（S2 证明只 pin deviceFile 即级联隔离 cloudflare 状态）。
6. **老用户迁移？无需迁移。** DSH_HOME 未设时解析结果与今日逐字节相同（S5 断言通过）。且**不应**把正式注册表复制进 DSH_HOME（会复制凭据）；隔离实例应空表启动（devices=0）。

## 3. 负向测试（已执行，44/44 断言通过，exit 0）

`d3-negative-test.mjs`，8 个场景各在独立子进程、env 指向虚构目录：

- **S1 RED**：虚构正式 home + 虚构 DSH_HOME。核心解析到隔离 home，插件仍解析到正式 home；真实 `createRegistry` 读出 2 台虚构设备、共享虚构 gatewayId；`connected()`/`setMode()` 确实改写虚构正式文件（父进程独立字节比对佐证）。
- **S2 CONTROL**：按隔离 profile pin `deviceFile`/`gatewayStateFile` 后路径隔离、count=0、独立 gatewayId、写入落在隔离文件、虚构正式文件字节不变。
- **S3** 无 DSH_HOME 的今日基线；**S4/S5/S6** 提案解析器预览（隔离生效 / 老用户逐字节兼容 / 空白 env 视为未设）。
- **S7** 跨实例覆盖与吊销失效；**S8** v2/v1 虚构注册表**仅构造 createRegistry 即被重写**、version 升 3、明文 token 抹除。

真实代码 vs 转录：`devices.js`、`gateway-state.mjs` 为直接 import 的生产模块；核心解析器从 asar 只读逐字节提取（`vendor/dsh-home-paths.index.mjs`，校验一致）；仅 `index.mjs:2255/2265/3220` 三行因内联不可导出而逐表达式忠实转录，脚本头部已标注漂移风险——**修复后必须改为断言真实导出函数**。

## 4. 修复用测试设计（待实施）

插件仓库新增 `test/home-isolation.test.mjs` 并挂入其 test 脚本：注入虚构 home/DSH_HOME → RED 默认落 `homedir()/.dsh`、读到虚构正式设备、共享 gatewayId；GREEN 落 `$DSH_HOME`、count=0、独立 gatewayId、虚构正式文件字节不变；无 DSH_HOME 时与旧默认全等；空白 DSH_HOME 视为未设；显式 deviceFile 优先；cloudflare/gateway 派生跟随。全部 `fs.mkdtempSync` 虚构目录 + 子进程 env，不触真实 `~/.dsh`、不启服务、不占端口。

## 5. 安全核对

- 正式注册表只读形状核对：version=3 / 35 设备 / 全 tokenHash / 无明文；与 `logs/formal-registry-baseline.sha256` 比对 **MATCH**（调查前后两次一致，mtime 未变；摘要值未打印）。
- `production-untouched-check.txt`：插件与 profile mtime 未变、git 工作区当时干净。
- 附带发现：`DSH_STATE_DIR` 在核心 `@deepseek-ai` 全包 0 命中，`start-isolated-dsh.sh` 里该变量是空操作；隔离实际靠 DSH_HOME + pin。

## 6. 本轮边界

只交付调查结论、修复方案与测试设计。**未修改任何生产数据路径，未删除/迁移/重置任何真实设备注册表。**