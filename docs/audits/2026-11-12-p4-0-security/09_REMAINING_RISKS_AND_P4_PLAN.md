# 09 · 剩余风险与 P4 计划

- 状态：**结论性文档**。所有 FAIL/BLOCKED/NOT_RUN 项在此汇总并给出处置建议。
- 原则：本轮**只修 D-3**。其余缺陷一律「证据 + 根因 + 失败测试设计 + 修复方案」交第二方复核，
  **不擅自修改敏感模块**（设备控制、审批、凭据、持久化安全）。
- 证据索引：`03` 矩阵 #1–#44；`04`/`05`/`06` 分项；`07` §4 新增两项；原始日志在 `logs/`。

---

## 1. D-3 修复本身的剩余风险

| # | 风险 | 等级 | 说明 / 缓解 |
|---|---|---|---|
| R1 | **回滚即恢复漏洞** | 中 | `--revert` 后网关回到「只认 homedir、多实例共享注册表」。回滚不是安全中性操作；若必须回滚，应同时恢复 `deviceFile` 显式 pin 作为补偿控制（`08` §5.2）。 |
| R2 | `--revert` 不检查运行中实例 | 中 | 只还原 `lib/` 文件；运行中进程仍持旧代码与旧锁。手册要求先停实例，但工具未强制。建议后续给 apply/revert 加「锁持有者存活则拒绝」检查。 |
| R3 | 强杀留下陈旧 `.lock` | 低 | 正常退出由 exit hook 清理；SIGKILL/断电会残留。重新应用时按 pid 存活探测自动回收；错误信息提示手动删除。**未做自动删锁**（破坏性操作不应擅自执行）。 |
| R4 | 上游未合并 | 中 | 修复在本地分支 `fix/p4-0-device-file-isolation`（`9d26cb9`），**未推送上游**。安装版靠受控补丁维持；上游一旦发新版，白名单需重新评审（G2/G3 会失败关闭，不会误打）。 |
| R5 | 锁只防「同文件多活所有者」 | 低 | 不防「同一进程内逻辑错误地复用两个 registry 对象」；同 pid 可重入是**有意设计**（合法组件共享）。跨进程共享已被 fail-closed 拒绝（真实第二实例验证）。 |
| R6 | 单活锁引入新的启动失败面 | 低 | 锁文件损坏/不可读/被活进程持有 ⇒ 插件加载失败（fail-closed）。这是安全取舍：宁可不起，不可共享。已在 `02` 用负向用例覆盖。 |

**正式数据零风险**：全部步骤前后正式注册表与 gateway state 的 SHA-256、mtime、size 逐字节一致；
正式 home 无 `.lock`；正式 DSH 进程从未停止/打补丁/写入。

---

## 2. P1 设计缺口（FAIL，静态确认；只交方案）

按影响排序。行号以 HEAD `c4c067b` 为准（P1 之后原生代码零改动）。

| 矩阵# | 缺口 | 安全方向 | 修复方案要点（待复核） |
|---|---|---|---|
| 5 | tap/scroll/key **不消费 screenId**：屏幕世代只生产不校验 | 危险（可对过期屏幕做手势） | 在 `OAS:168,369,381` 动作入口比对「当前 screenId == 审批/快照时的 screenId」，不等则 `STALE_SCREEN` 拒绝；补 JVM/设备级失败测试 |
| 6 | `type` 仅比 packageName，**同包换屏仍盲写** | 危险（文本进错输入框） | `OAS:220-230` 增加焦点节点/屏幕世代绑定；位置回退路径（`:228-230,244`）一并收紧 |
| 9 | `phone_open` **先拉起后判敏感** | 危险（敏感页已被打开） | `PhoneTools.kt:147-190` 改为事前校验目标是否敏感/锁屏，敏感则不 launch；保留事后守卫作第二层 |
| 17 | **原生审批无 TTL** | 中（过期审批仍可被用） | 对齐 butler `local-approvals.js:11,87` 的过期语义；在 `AgentRuntime.kt:629-631` 加 issuedAt+TTL 校验 |
| 22 | **无 SCREEN_ON/USER_PRESENT 恢复** | 可用性（息屏后 run 不恢复） | 明确产品语义：要么补恢复路径，要么在 UI 明示「息屏即终止」；当前两者都不做，用户预期落空 |
| 23 | `AgentService` **无 onTimeout/自限时** | 中（API36 dataSync 系统上限行为未知） | 加应用层 deadline + `onTimeout` 优雅收尾；真机长时实测 API36 上限 |
| 25 | **取消为协作式**：进行中 tool 跑完才停 | 中（取消延迟不可控） | 给 tool 执行加可中断边界；至少对网络/长任务提供 abort 信号 |
| 15 | 敏感词**子串误报**（shipping⊃pin） | 安全方向正确但误报 | 改为词边界/语义匹配；**不得**为了消除误报而放宽 fail-closed |
| 44 | `test:p3/p4/localRuntime` **不在 npm test** | 覆盖缺口 | 纳入 `test:chain` 或 CI 独立 job；本轮未擅自改链（只加了隔离套件） |

**共同约束**：以上任何修复都不得削弱「默认拒绝、审批绑定用户所见、敏感屏 fail-closed」三条不变量。

---

## 3. 本轮新增缺陷（只交方案）

### 3.1 N1 · 原生 cookie 容器：清理路径无超时 + 读超时被吞（敏感：凭据/认证）

- 证据：`07` §4；`logs/regression/emulator-core-regression.txt` R2/R3。
- 根因：`cookieJar.ts:212-283` 全链路无超时 ⇒ 原生不回调时 `loginWithToken` 永久 hang（症状 B，零网络请求）；
  `transport/index.ts:328-342` 的 5s 读超时被空 catch 吞掉 ⇒ 误导性 `HTTP 401`（症状 A）。
- 失败测试设计：
  1. 注入一个**永不 resolve** 的 CookieManager mock ⇒ 断言 `loginWithToken` 在有限时间内以**明确错误**失败（当前会 hang，RED）。
  2. 注入 `get` 超时 mock ⇒ 断言错误信息区分「原生容器不可用」与「服务端 401」（当前混为 401，RED）。
  3. 回归：正常 mock 下配对仍成功（GREEN 保持）。
- 修复方案要点：给 `listDshCookies/clearByName/clearAll` 统一加 `Promise.race` 超时；
  超时归类为 `unverified`/`unavailable` 并**向上抛出可识别错误**，不再落进 401 分支；
  保留「jar 有 cookie 才算成功」的判据与清 jar 前置（认证不变量不动）。
- 处置：**敏感模块，交第二方复核后实施**。

### 3.2 N2 · 死胡同工作区弹层（产品 UI）

- 证据：`07` §4.4；`evidence/reg-02-control-state.png`、`reg-03-after-restart.png`。
- 根因：`HomeScreen.tsx:93-98` `onCancel={() => {}}` + 未传 `allowCancel`（默认 false）；
  背板无 onPress；BACK 走同一 no-op；butlerMode 持久化 ⇒ 跨重启仍在。
- 失败测试设计：渲染 `butlerMode && desktop && !butlerSessionId && workspaces=[]` ⇒
  断言存在可点击的退出 affordance 且 BACK 能关闭（当前 RED）。
- 修复方案要点：空工作区时允许取消并回落到「本机管家」或配对页；或提供「去新建工作区」入口。
  不得用「自动创建默认工作区」绕过（会引入未经用户同意的项目绑定）。
- 处置：产品 UI，交复核；非敏感安全模块，但影响可用性兜底，建议与 N1 同批。

---

## 4. BLOCKED / NOT_RUN：需要什么才能推进

| 项 | 现状 | 解锁条件 |
|---|---|---|
| #29 后台虚拟屏 / Shizuku | BLOCKED | 启动 Shizuku 服务并在 Emulator/真机授权；涉及系统级权限，需单独评审 |
| #37 本地 DSH runtime 全链路 | BLOCKED | 默认构建缺 `libproot.so` ⇒ `hasBundledRuntime=false`。需 `-PDSH_RUNTIME_NATIVE_DIR/-PDSH_RUNTIME_ASSETS_DIR` 注入或正式打包路径；**不得**为测试伪造门控 |
| #30/#39 设备级异常退出/越权 | BLOCKED（设备级） | 依赖 #37 解锁 |
| #4/#7/#8/#16/#18/#19 设备级动作与悬浮卡 | NOT_RUN | 需在动作时刻保持非敏感前台/触发悬浮卡；建议用隔离测试 App 作靶（章程要求负向先打虚构 UI） |
| #43 androidTest 7 项 | NOT_RUN | 任何 CI job 都不跑；`RuntimeInstallerChecks.java` 为孤儿（0 @Test、无调用者）。建议加 CI job 或删除孤儿文件（二选一，交复核） |
| 真机项（API36 FGS 上限、OEM 后台杀、息屏恢复） | 待真机验证 | **vivo V1981A 已连接但本轮刻意不用**：个人手机上驱动设备控制不可安全恢复。需专用测试真机或用户明确授权 |

---

## 5. 测试设施与 CI 维护项

| 项 | 说明 | 建议 |
|---|---|---|
| 上游 8 个环境性失败 | Windows mode 位/EPERM symlink/python3/cloudflared/asar | 在 CI（Linux）上应全绿；本地保留签名比对，**不削弱断言** |
| `test:p3/p4/localRuntime` 不在链上 | 覆盖缺口（#44） | 纳入链或独立 CI job |
| androidTest 不在 CI | #43 | 加 job 或清理孤儿 |
| actions Node 20 deprecation | checkout/setup-node/setup-java/cache/upload-artifact v4 | 升级到 v5/v6 系列（维护性，非本轮范围） |
| ubuntu-latest → Ubuntu 26（2026-10-19） | runner 迁移警告 | 迁移前跑一次全量 CI 确认 |
| 本地 Node 24 vs CI Node 20 | 已分别验证双绿 | 保持「本地绿 ≠ CI 绿」的双跑纪律 |

---

## 6. 是否具备进入 P4（性能/架构）的条件

**结论：有条件具备，但有两个前置门槛。**

- **具备的理由**：D-3 已修复且负向证明充分；P2/P3 全部回归绿；远程 CI 绿；
  安全骨架（fail-closed 审批、digest 绑定、敏感屏接管、FGS、取消与持久化）在真实 Emulator 上成立；
  正式数据零触碰；回滚可验证。
- **前置门槛 1（安全）**：N1（cookie 容器 hang/误导 401）落在**凭据/认证路径**，
  且 #5/#6/#9 三个设备控制缺口是**可对错误目标产生真实副作用**的设计缺陷。
  建议 P4 开工前先由第二方复核并修复这四项，否则性能/架构改动会建立在仍会误动作的地基上。
- **前置门槛 2（验收完整性）**：#37 本地 runtime 全链路 BLOCKED、#43 androidTest NOT_RUN、
  真机项未验证。P4 若涉及 runtime/后台架构，必须先解锁 #37，否则改的是无法端到端验证的代码。
- **不建议**在 P4 做大规模重构：本轮已确认 P1 之后原生代码零改动、行号稳定，
  适合「小步、可回滚、带失败测试」的修复节奏，而非整体重写。

---

## 7. 明确未验证清单（不得宣称已验证）

1. 真机（含 API 36）上的 FGS dataSync 系统上限、OEM 后台查杀、息屏/解锁恢复行为。
2. 本地 DSH runtime 全链路（#37）与依赖它的设备级异常退出/越权（#30/#39）。
3. Shizuku 后台虚拟屏（#29）。
4. `phone_tap/scroll/key` 在**非敏感前台**的真实手势执行（#4/#7/#8）与悬浮审批卡覆盖他应用（#18）。
5. androidTest 7 项（#43）在任何环境的执行。
6. 上游修复被上游接受/合并（R4）。
7. N1/N2 修复后的行为（本轮只交方案，未改代码）。
8. 公网/云模型路径：本轮**全程未调用收费云模型**，公网门以配置与 status 断言验证，未做真实公网穿透测试。

---

## 8. 停止边界（本轮遵守情况）

- 未合并 main（main 仍 `e835782`，与 origin/main 相同）。
- 未创建 Tag（本地/远端均 63 个，无新增）、未创建 Release、未签名发布（CI release job skipped）。
- 未修改正式 DSH / Magpie / 用户凭据 / 正式设备注册表。
- 未自动调用收费云模型（全程本地确定性桩）。
- 未为测试削弱认证、审批或安全限制。
- 未开始大规模重构。