# DSH Outpost 第三轮安全收尾修复 —— 最终报告

- 仓库：`https://github.com/xisnn/dsh-outpost`
- 基线：`main` @ `5d34541`（v0.16.2）
- 本轮工作区状态：**全部改动未提交、未推送、未打 tag、未发布**
- 执行日期：2026-10-25
- 验证环境：Windows 11 / Node v24.13.0 / JDK 21.0.8 / Android SDK 36

> **本报告只写实际做过的事。** 没有真机 = 真机项一律 `NOT RUN`；
> 构建被环境阻断 = 结论不升级为「APK 已构建」。没有任何一项是在没证据
> 的情况下写成的通过。
>
> **发布结论：B —— 代码已满足构建条件，但还需真机验收**
> （不是 C，因为本轮**没有**产出可交付 APK，见第 5 节）。

---

## 1. 本轮问题核查

六类问题**全部在原代码中实际存在**，且全部已修复并补测试。
没有为了产生代码改动而重复修复已经正确的地方 —— 第 1.7 节列出
「核查后确认本来就正确、只补了证据」的部分。

### 1.1 P0-1 撤销状态写入失败被吞掉 —— ✅ 确实存在

| 项 | 内容 |
|---|---|
| 位置 | `src/core/deviceRevocation.ts` `markApprovalRevoked()`（原 228–245 行） |
| 原实现 | 先 `cached = state`，再 `try { await AsyncStorage.setItem(...) } catch { /* 注释说「不阻塞本地清理」 */ }`，返回 `Promise<void>` |
| 真实缺陷 | ① `catch` 吞掉写入异常，**调用方无法得知落盘失败**；② 返回 `void`，语义上等于「撤销成功」；③ 原注释给出的兜底理由是「重启后服务端仍会用 4003 拒绝」，但这句话**只在服务端撤销成功时成立** —— 而「服务端撤销失败 + 本地落盘失败」时 4003 永远不会来，本地标记是唯一屏障 |
| 修复 | 双通道 + 回读校验；返回判别结果；不重试；不删标记 |
| 证据 | `tests/revocation-persistence-spec.mjs` 38 项 |

**修复要点**

1. `markApprovalRevoked()` 返回 `RevocationPersistResult { ok, persisted, memoryOnly, error? }`。
   `ok === true` **只**代表「至少一个存储写入并回读校验通过」，绝不代表「没抛异常」。
2. 主通道 AsyncStorage `@dsh/approvalRevoked`；失败后降级到 Keychain
   `CredentialKey.revocationMarker`（两套独立的底层存储，同时坏的概率远低于单套）。
3. 两个通道都**写完回读比对内容**（`AsyncStorage.setItem` / Keystore 在部分机型会「返回成功但没写」）。
4. **降级标记不随「彻底清除授权」被清掉**：`clearAllCredentials()` 刻意不清
   `revocationMarker` —— 它记录的是「用户已撤销」，删了等于把唯一的反向证据抹掉。
5. `loadRevocationState()` 只有在**两个存储都读成功且都确认无标记**时才返回
   `not-revoked`；任何「读不出来」都是 `unknown`（fail-closed）。
6. 发现一个隐蔽点：`secureStore.loadCredential()` 把「Keystore 读抛异常」塌缩成
   `undefined`，与「确实没有」无法区分。所以读到空值时额外探一次
   `isSecureStorageAvailable()`；探针失败则该通道判定为**不可读** → `unknown`。
   没有这一步，第 5 条只是名义上成立。
7. **明确的安全降级及其限制**（写在模块注释里）：两个存储都不可用时，
   **无法保证跨重启拦截**。此时采取的措施是：清掉网关 token + 明文副本
   （降低可被利用的凭据面），并把 `ok:false` 如实上报给界面 —— 由 UI 明确
   告知用户「本次运行有效，但重启后可能失效」，而不是假称成功。

### 1.2 P0-2 彻底清除授权时的虚假成功路径 —— ✅ 确实存在

| 项 | 内容 |
|---|---|
| 位置 | `src/App.tsx` `clearAuthorization()` |
| 原实现 | `let revokeFailed = false; try { if (cookie && (deviceId ?? serverDeviceId) && baseUrl) { ... revokeFailed = outcome === 'failed' } } catch { revokeFailed = true }` |
| 真实缺陷 | 读凭据的 `catch` 是**空注释**（`// 读不到就按「没凭据」处理`），于是：Cookie 读失败 / deviceId 缺失 / baseUrl 空 → `if` 整体为假 → **撤销被静默跳过，`revokeFailed` 保持 `false`** → 用户看到「全部成功」，而电脑上那条记录一直有效。手机丢了场景下这是致命的 |
| 第二个缺陷 | `already-gone` 被当成 `serverOk = true` —— 但服务端 404 也可能只是「这个 UUID 不属于这台服务器」，见 P1-1 |
| 修复 | 判别联合 + 分项提示；本地/服务端两半彻底分开 |
| 证据 | `tests/device-revoke-spec.mjs` 9 项、`tests/migration-race-spec.mjs`（静态顺序）、`tests/device-list-state-spec.mjs` 24 项 |

**修复要点** —— 结果类型（`App.tsx` 顶部，导出给测试与 UI 共用）：

```ts
type ServerRevokeResult =
  | { kind: 'revoked' }                                     // 服务端确认撤销成功
  | { kind: 'already-gone'; how: 'identity' | 'empty-list' } // 确认不存在且身份已验证
  | { kind: 'failed'; reason: string; status?: number }      // 撤销失败，授权可能还在
  | { kind: 'unconfirmed'; reason: string };                 // 没发出请求，无法确认

interface LocalCleanupResult {
  secureStorage: 'cleared' | 'failed';
  legacyPlaintext: boolean;                                  // 回读确认，不是「删了几次」
  cookieJar: 'cleared' | 'unavailable' | 'partial' | 'unverified';
  revocation: RevocationPersistResult;                       // P0-1 的落盘结果
}
interface ClearAuthorizationResult { server: ServerRevokeResult; local: LocalCleanupResult }
```

- `isFullyClear()` 是**唯一**的「可以报全部成功」判据，集中在函数里，
  避免各处自己拼条件时漏掉某条路径。
- `notifyClearResult()` 按结果分项列出问题（服务端 / 明文 / cookie / 撤销标记），
  文案明确区分「电脑上的授权可能仍然有效」和「无法确认」，不含任何凭据原文。
- 顺序不变：**先读凭据 → 再撤销服务端 → 再清本地**（M3 的顺序不变式仍在，
  且静态断言守着）。
- 本地清理成功**不等于**服务端成功：用户主动清本地永远不被阻塞，但结论分开报。

### 1.3 P1-1 服务端 UUID 与服务器身份未关联 —— ✅ 确实存在

| 项 | 内容 |
|---|---|
| 位置 | `src/core/secureStore.ts`（`gatewayServerDeviceId`）、`src/core/deviceAuth.ts`（`revokeOwnDevice`）、`src/core/approvalGateway.ts`（学习 UUID 处） |
| 真实缺陷 | `gatewayServerDeviceId` 是**全局凭据**，没记录它属于哪台服务器。用户换服务器（电脑 A → B）、A 重装插件（注册表重建）、同一 IP 换机器（DHCP）时，旧 UUID 打过去得到 **404**，而 `revokeOwnDevice` 把 404 归类成 `already-gone` → 上层当成撤销成功 → **新服务器上这台设备的授权其实还在**，手机丢了也踢不掉 |
| 修复 | 新增 `serverIdentity.ts`，绑定 `{baseUrl, gatewayId, deviceId}`，三者同时匹配才算确认 |
| 证据 | `tests/server-identity-binding-spec.mjs` 32 项 |

**先回答「服务端到底有没有可用的实例身份」（不虚构字段）** ——
查了真实插件 `dsh-plugin-mobile-gateway` 源码：

| 字段 | 出处 | 稳定性 | 能否当身份 |
|---|---|---|---|
| `gatewayId` | `lib/gateway-state.mjs`，独立状态文件，首次创建用 `linkSync` 保证**永不覆盖**已有身份 | **跨重启、跨设备撤销都稳定** | ✅ 采用 |
| `gatewayInstanceId` | `lib/index.mjs:2294` `crypto.randomUUID()` | **每次进程启动都变** | ❌ 明确排除 |

`gatewayId` 出现在 `paired` 帧、`hello` 帧、`GET /mgw/status`、`POST /mgw/pair`
payload（都是 `...gatewayIdentity`），所以「UUID 属于哪台服务器」**能被真实验证**。

**六种结论（判别联合，不是布尔值）**

| 情况 | 结论 | 能用已存 UUID | 404 能算成功 |
|---|---|---|---|
| baseUrl + gatewayId 都匹配 | `confirmed` | ✅ | ✅ |
| 没绑定（全新安装 / 老版本） | `unbound` | — | ❌（除非列表确认空且无来源不明 UUID） |
| baseUrl 变了 | `foreign` | ❌ | ❌ |
| 同地址但 gatewayId 变了（注册表重建） | `foreign` | ❌ | ❌ |
| 只有 baseUrl 对上（老协议无 gatewayId） | `assumed` | ✅ | ❌ |
| 读不到 / 数据损坏 | `unverifiable` | ❌ | ❌ |

**关键实现细节**：撤销前会**主动问一次** `GET /mgw/status` 拿当前 `gatewayId` ——
不能只拿存储里的绑定跟自己比，那样只能发现「地址变了」，
发现不了「同一地址换了服务器 / 注册表重建」，而后者恰恰最危险（baseUrl 一个字符都没变）。
问不到就退化为 `assumed`，此时 404 不采信（方向安全）。
另：`foreign` 绑定**禁止**把存储 UUID 发出去，避免对无关服务器执行破坏性操作。

**协议限制（诚实声明）**：老版本插件不发 `gatewayId`，此时无法确认身份。
选择是「仍允许发请求（否则老用户永远撤不掉），但拒绝把 404 报成成功」。
这意味着老协议的服务器上，撤销可能得到「无法确认」而非「已撤销」——
宁可让用户去电脑上核对，也不给假成功。

### 1.4 P1-2 `lastCookie` 迁移的异步竞争 —— ✅ 确实存在

| 项 | 内容 |
|---|---|
| 位置 | `src/App.tsx` 启动流程（原 327–332 行） |
| 原实现 | `const migration = await migrateLegacyCredentials(); ... if (migration.fromLastCookie) { void setLoginIntent('signed-out'); }` |
| 两个缺陷 | ① **`void` 掉了** —— 不等待、不检查结果；② **顺序反了** —— 迁移先删掉 `@dsh/lastCookie`（那是「旧版里用户主动断开过」的**唯一证据**），退出意图才去落盘 |
| 致命窗口 | lastCookie 已删 → signed-out 未写 → App 被杀 → 下次启动读不到意图键 → `loadLoginIntent()` 返回 `active`（升级兼容语义）→ **自动登录** |
| 修复 | 先读证据 → 先落意图 → 再迁移；写失败则移除可自动登录的凭据 |
| 证据 | `tests/migration-race-spec.mjs` 20 项（含静态顺序断言） |

**修复要点**

1. 新增 `peekLegacySignedOutEvidence()`：在迁移**动手之前**先读一次
   （只读键是否存在，**不读取也不返回它的值** —— 那是完整可用的凭据）。
2. 意图写入 `await` 并检查结果，存进 `exitIntentPersisted`。
3. **写失败 → 移除 `CredentialKey.cookie`**：这样即使意图丢了，也没有东西能自动登录；
   用户重新扫码即可，而「以为退出了、其实没退」不会发生。
   这与 P0-1 的「持久化失败就移除可自动恢复的凭据」是同一策略。
4. 读证据失败（`unknown`）→ 同样按「未确认」处理并降级，不替用户猜。
5. 迁移报告 `fromLastCookie` 再兜一层，两条路径都覆盖。
6. 崩溃场景：迁移各阶段（intent / migration / cookie-removal）模拟崩溃 + 重启，
   以及连续崩溃 3 次，都不产生自动登录。

**旧版本覆盖升级兼容**：正常登录态（有 `@dsh/cookie`、无 lastCookie）仍然自动登录，
不制造大规模重新登录。

### 1.5 P1-3 旧明文凭据迁移的错误报告 —— ✅ 确实存在

| 项 | 内容 |
|---|---|
| 位置 | `src/core/credentialMigration.ts` `migrateLegacyCredentials()`（原 146–155 行） |
| 原实现 | `try { await AsyncStorage.multiGet(...) } catch { return report; }`，而 `report` 默认 `status:'clean'` |
| 真实缺陷 | **「读不到」被报成「确认没有」**。数据库被锁 / 磁盘满 / 文件损坏时，明文很可能还在磁盘上，只是看不见；上层看到 `clean` 就放心自动登录 |
| 修复 | 状态从 4 种扩到 7 种；删除后回读校验；新增 `shouldBlockAutoLogin()` |
| 证据 | `tests/credential-migration-spec.mjs` 35 项（原 16）、`tests/credential-migration-crash-spec.mjs` 17 项（新） |

**严格区分的状态**

| 状态 | 含义 |
|---|---|
| `clean` | 读成功，确认没有历史凭据 |
| `migrated` | 找到并安全迁移 + 明文回读确认删除 |
| `already-secure` | 安全存储已有值，明文副本回读确认删除 |
| `failed` | 找到明文但迁移失败（明文留在原地待重试） |
| `read-failed` ★ | **读不到存储 → 是否存在明文未知** |
| `clear-failed` ★ | 删除失败 / 回读见残留 |
| `verify-failed` ★ | 删后回读校验本身失败 → 无法确认为已删除 |

- 报告新增 `readSucceeded` 与 `clearVerified` 两个**独立**字段，
  不靠 `status` 反推「结论所依赖的前提成不成立」。
- `shouldBlockAutoLogin()` 用 `switch` + `const exhaustive: never` 做穷尽检查，
  将来新增状态会**编译报错**而不是静默放过；`default` 返回 `true`（fail-closed）。
- 风险门控已在 `App.tsx` 启动流程接上：明文存储状态未知/迁移失败 → 不自动登录 + 提示。
- 顺序不变式**严格保留**：写 Keychain → 回读校验 → 才删明文。

### 1.6 P1-4 Cookie 清理结果不可信 —— ✅ 确实存在

| 项 | 内容 |
|---|---|
| 位置 | `src/core/cookieJar.ts` |
| 原实现 | 返回 `Promise<boolean>`；`getAll` / 复核的 `catch` 是空的，注释写「按不确定处理，保持 ok 的现值」—— 即**复核失败时沿用之前的 `true`** |
| 真实缺陷 | 清理失败 / 无法验证 / 原生模块不可用三种完全不同的结局压在一个布尔值里；复核失败还被当成成功 |
| 修复 | 四态判别联合；异常分类不吞；只读 cookie **名**不读值 |
| 证据 | `tests/cookie-cleanup-spec.mjs` 29 项 |

```ts
type CookieCleanupResult =
  | { kind: 'cleared' }
  | { kind: 'unavailable'; reason: string }  // 平台根本没有第二个存储（不是失败）
  | { kind: 'partial'; remaining: number }   // 复核确认有残留
  | { kind: 'unverified'; reason: string };  // 无法确认 —— 绝不当成功
```

`clearNativeCookieJar()` 保留为薄包装（`cleared`/`unavailable` → true，
`partial`/`unverified` → false），既有调用方与测试不受影响。

**一个改变实现方向的真实平台发现**：Android 上 `getAll()` **永远 reject**
（`CookieManagerModule.java` → `GET_ALL_NOT_SUPPORTED`）。只用 getAll 复核会让
**每次** Android 清理都返回 `unverified` —— 一个用户很快学会忽略的常驻警告。
因此补了 `get(url)` 兜底复核，并有专门测试钉住；
在 Android 上没有 baseUrl（无法枚举）时，诚实的答案确实就是 `unverified`。

### 1.7 核查后确认本来就正确 —— 只补证据，不重复修

按「不得为了产生代码改动而重复修复」的要求，以下方向**核查后确认前两轮已正确处理**，
本轮没有改动，只确认其测试仍绿：

| 方向 | 结论 |
|---|---|
| `unknown` 禁止自动配对 | ✅ `ApprovalGateway.connect()` 已拦；`revocation-unknown-spec` 19 项全绿 |
| `dsh-auth.` 子协议前缀 | ✅ 已正确；`protocol-contract-spec` 守住 |
| 4003 按 reason 分类 | ✅ `isDeviceRevokedClose()` 精确匹配，不会把 `authentication enabled` 误判为撤销 |
| 旧连接回调不覆盖新状态 | ✅ generation 机制已在；`gateway-recovery-spec` 13 项全绿 |
| 设备列表失败不伪装成空列表 | ✅ `DeviceListResult` 判别联合已在；24 项全绿 |
| 普通网络失败不丢有效 Token | ✅ 已正确；本轮集成测试确认 |
| 设备 UUID 从 `paired`/`hello` 帧学习 | ✅ 已正确；本轮只在此基础上**追加**绑定写入 |
| 明文迁移「先写后删」顺序 | ✅ 已正确；本轮未改动顺序 |

---

## 2. 实际修改内容

### 2.1 新增文件

| 文件 | 职责 |
|---|---|
| `dsh-mobile/src/core/serverIdentity.ts` | **P1-1 核心**：服务端实例身份绑定 `{baseUrl, gatewayId, deviceId}`；六态解析；`GET /mgw/status` 主动探身份；归一化与安全取字段 |
| `dsh-mobile/tests/server-identity-binding-spec.mjs` | P1-1 回归测试（32 项） |
| `dsh-mobile/tests/migration-race-spec.mjs` | P1-2 回归测试（20 项） |
| `dsh-mobile/tests/revocation-persistence-spec.mjs` | P0-1 回归测试（38 项） |
| `dsh-mobile/tests/cookie-cleanup-spec.mjs` | P1-4 回归测试（29 项） |
| `dsh-mobile/tests/credential-migration-crash-spec.mjs` | P1-3 崩溃/中断测试（17 项） |
| `dsh-mobile/APK-BUILD-REPORT.md` | 构建结果与失败分类（12 节） |
| `RELEASE-ACCEPTANCE-CHECKLIST.md` | 真机验收清单（12 章 57 项） |
| `FINAL-SECURITY-FIX-REPORT.md` | 本报告 |
| `BUILD-LOG-*.txt`（8 个） | 完整构建/探针日志 |

> 注：`src/core/cookieJar.ts`、`credentialMigration.ts`、`deviceRevocation.ts`、
> `loginIntent.ts` 是**上一轮**新增但一直未提交的文件，本轮在其上修改。

### 2.2 修改的源码文件

| 文件 | 改动 | 对应问题 |
|---|---|---|
| `src/core/deviceRevocation.ts` | `markApprovalRevoked` 返回 `RevocationPersistResult`；双通道 + 回读校验；`loadRevocationState` 真正 fail-closed；`clearApprovalRevoked` 双删 + 校验 | P0-1 |
| `src/core/cookieJar.ts` | 新增 `clearNativeCookieJarDetailed` + `CookieCleanupResult` 四态；异常分类；`get(url)` 兜底复核 | P1-4 |
| `src/core/credentialMigration.ts` | 状态 4→7；`readSucceeded` / `clearVerified` 字段；删除后回读校验；`shouldBlockAutoLogin()`；`clearLegacyCredentialStorageVerified()` | P1-3 |
| `src/core/serverIdentity.ts` | **新建** | P1-1 |
| `src/core/deviceAuth.ts` | 新增 `RevokeDetail` 精确联合 + `revokeOwnDeviceDetailed` / `revokeDeviceDetailed`；`revokeOwnDevice` 保留三值签名委托；404 语义改为「需身份确认」 | P0-2 / P1-1 |
| `src/core/approvalGateway.ts` | 新增 `rememberServerDevice()`：从 `paired`/`hello` 学 UUID 时**同时**写身份绑定 | P1-1 |
| `src/core/secureStore.ts` | 新增 `CredentialKey.gatewayServerBinding` / `revocationMarker`；`clearAllCredentials` 清绑定但**刻意不清**撤销标记 | P0-1 / P1-1 |
| `src/core/store.ts` | `revokeOwnApprovalAuthorization` 返回 `RevocationPersistResult`（原 `void`） | P0-1 |
| `src/App.tsx` | `clearAuthorization` 全面改写（判别联合 + 分项提示 + 回读校验）；`revokeOwnApproval` 用 detailed API；启动流程 P1-2 顺序修正 + `shouldBlockAutoLogin` 接入 | P0-2 / P1-2 / P1-3 / P1-1 |
| `dsh-mobile/package.json` | 新增 5 个 test script 并接入 `npm test` 链（42 个条目，全部校验存在） | 测试记账 |
| `.gitignore` | 忽略构建期沙箱的 `GRADLE_USER_HOME` 等可写重定向目录（约 4.66 GB 缓存）与探针产物 | 工程整洁 |

### 2.3 修改的测试文件

| 文件 | 变化 |
|---|---|
| `tests/support/fake-dsh.mjs` | 增加 `gatewayId`（`paired`/`hello` 帧）与 `GET /mgw/status` 路由，**对齐真实插件** |
| `tests/integration-product.mjs` | 补 CJS `require` hook（Keychain shim）+ `seedCookie` 重置安全存储 |
| `tests/credential-security-spec.mjs` | 魔数切片 → 真实函数体切片；接受 `clearLegacyCredentialStorage*` |
| `tests/device-revoke-spec.mjs` | 魔数切片 → 真实函数体切片；断言改为「行为」而非「`revokeFailed` 变量名」 |
| `tests/security-review-fixes-spec.mjs` | C1 / M3 两处魔数切片修复（**均收紧**，未放宽） |
| `tests/credential-migration-spec.mjs` | 16 → 35 项 |
| `tests/README.md` | 更新测试清单与计数 |

### 2.4 明确的「没有做」

- 未修改 `applicationId`（仍为 `com.dshpocket`）、未改签名身份
- 未升级 AGP / Gradle / NDK / Kotlin / RN
- 未大规模重构架构、未改无关 UI
- 未删除任何既有测试、未放宽任何安全断言
- 未修改模拟网关去迎合客户端错误行为（相反：`fake-dsh` 被**加强**以对齐真实插件）
- 未提交、未推送、未打 tag、未发布

---

## 3. 安全状态机最终说明

### 3.1 授权状态（审批通道）

```
                    ┌──────────────────────────────────────┐
                    │  首次使用 / 无 token / 无撤销标记      │
                    │  revocation = not-revoked            │
                    └───────────────┬──────────────────────┘
                                    │ 自动申请配对码
                                    ▼
                          ┌──────────────────┐
              ┌──────────►│   授权成功 online │◄─────────┐
              │           │  有 gateway token │          │
              │           └────────┬─────────┘          │
              │                    │                    │
   用户扫码/重新授权           ①用户主动撤销         网络恢复
   （显式动作）              ②服务端 4003          服务端重启
              │                    │            切前后台
              │                    ▼                    │
              │        ┌────────────────────────┐       │
              │        │  主动撤销 / 撤销失败     │       │
              │        │ revocation = revoked   │───────┘（都不允许自动重连）
              │        └───────────┬────────────┘
              │                    │
              │                    ├── 本地落盘成功 → 跨重启仍拦截 ✅
              │                    └── 本地落盘失败 → 本次运行仍拦截 ✅
              │                        但重启后可能失效 ⚠️ → 必须告知用户
              │
              └────────────── 任何「读不出来」────────────────┐
                                                              ▼
                                              ┌──────────────────────────┐
                                              │ revocation = unknown     │
                                              │ 禁止自动配对（fail-closed）│
                                              │ 慢速重试等存储恢复         │
                                              └──────────────────────────┘
```

| 状态 | 触发 | 自动配对 | 凭据处理 | UI |
|---|---|---|---|---|
| **授权成功** | 配对成功 / `dsh-auth.*` 握手通过 | ✅ | 存 token + UUID + 身份绑定 | 已连接 |
| **主动撤销** | 用户点撤销 | ❌ | 停网关、清 token、置标记（双通道） | 已撤销授权 + 重新授权入口 |
| **撤销失败** | 网络/鉴权/服务端错误 | ❌（本地已停） | 服务端记录仍在 | **明确提示**「电脑上授权可能仍有效」 |
| **本地持久化失败** | 标记写不进任何存储 | ❌（本次运行） | 仍清 token + 明文 | **明确提示**「重启后可能失效」 |
| **授权状态未知** | 存储读失败/损坏 | ❌ | **不动任何凭据**，等恢复 | 「暂时无法确认」+ 自动重试 |
| **凭据失效** | 服务端明确拒绝（401/4003-revoked） | ❌ | 清 token/标记 | 需重新授权 |
| **用户重新授权** | 扫码 / 点「重新授权」 | ✅ 恢复 | `clearApprovalRevoked()` 双删校验 | 恢复连接 |
| **服务器切换** | baseUrl 变 / gatewayId 变 | 新服务器正常配对 | 旧 UUID **禁止**复用；绑定更新为新服务器 | 正常（不误报撤销成功） |

### 3.2 退出意图状态（登录）

| 意图 | 含义 | 自动登录 |
|---|---|---|
| `active` | 正常登录 / 键不存在（升级兼容） | ✅（且需有 baseUrl + cookie） |
| `signed-out` | 用户主动断开过 | ❌，配对页给「直接继续」 |
| `unknown` | 读失败 / 数据损坏 | ❌（fail-closed） |

**写失败降级**：写入失败**且**本机有可用 cookie → 移除 `CredentialKey.cookie`，
使「意图丢失」也无法导致自动登录。用户重新扫码即可。

**迁移顺序不变式**（不可回退）：
```
peek 旧证据 → 落 signed-out（await + 校验）→ 迁移 → 判定是否自动登录
```

### 3.3 撤销结果判定矩阵（P1-1 × P0-2）

| 身份绑定 | 服务端返回 | 结论 | 对用户 |
|---|---|---|---|
| `confirmed` | 200 `{revoked:true}` | `revoked` | 已撤销 ✅ |
| `confirmed` | 404 | `already-gone` | 已撤销（本来就是） ✅ |
| `confirmed` | 列表空 | `already-gone` | 已撤销（本来就是） ✅ |
| `assumed` | 404 | `failed` | **无法确认**，去电脑核对 ⚠️ |
| `foreign` | 任意 | 不发请求 / `failed` | **无法确认** ⚠️ |
| `unverifiable` | 任意 | `failed` | **无法确认** ⚠️ |
| 任意 | 401/403/5xx | `failed` | 撤销失败，授权可能还在 ❌ |
| 任意 | 缺 cookie/deviceId/baseUrl | `unconfirmed` | **没发请求**，无法确认 ⚠️ |

> 只有前三行可以展示「所有授权已成功撤销」。

---

## 4. 测试结果

### 4.1 执行命令

**注意**：本项目标准命令是 `npm test`（走 `tsx`）。**本轮 `tsx`/esbuild 被沙箱阻断**
（`TransformError: spawn EPERM`，esbuild 启动时要 spawn 子进程），
因此改用项目**自有文档记载**的备用引导（见 `dsh-mobile/tests/README.md`
「工具链起不来时的备用跑法」）：

```bash
cd dsh-mobile
node --experimental-transform-types \
     --import ./tests/support/node-ts-bootstrap.mjs \
     tests/<file>.mjs
```

| 项 | 标准命令 | 本轮实际命令 |
|---|---|---|
| 单元/静态测试 | `npm test`（tsx） | 上述 node 引导（**逐文件**） |
| 类型检查 | `npx tsc --noEmit` | `node node_modules/typescript/bin/tsc --noEmit`（✅ 通过） |
| 集成测试 | `npm run test:integration` | 同左但把 tsx 换成 node 引导 |
| 差异 | — | **仅替换转译器**，测试文件与断言完全相同；`npm test` 因 spawn EPERM 在第一项即失败，本轮**未能**用原始命令跑通 |

### 4.2 结果合计

| 层 | 文件数 | 通过 | 失败 | 跳过 | 退出码 |
|---|---|---|---|---|---|
| 单元 / 静态 spec | **41** | **774** | **0** | 0 | 全部 0 |
| 协议集成 | 3 | 39 | 0 | 0 | 0 |
| 产品集成 | 1 | 16 | 0 | 0 | 0 |
| 重连集成 | 1 | 6 | 0 | 0 | 0 |
| `tsc --noEmit` | — | ✅ 无错误 | 0 | — | 0 |
| Metro 生产打包 | — | ✅ 成功 | 0 | — | 0 |
| **合计（可自动验证）** | **46** | **835** | **0** | **0** | — |

### 4.3 本轮新增断言（准确记账，不混淆口径）

| 文件 | 断言数 | 性质 |
|---|---|---|
| `revocation-persistence-spec.mjs` | 38 | 新增文件 |
| `server-identity-binding-spec.mjs` | 32 | 新增文件（Lead） |
| `cookie-cleanup-spec.mjs` | 29 | 新增文件 |
| `migration-race-spec.mjs` | 20 | 新增文件（Lead） |
| `credential-migration-crash-spec.mjs` | 17 | 新增文件 |
| **新增小计** | **136** | 5 个新 spec 文件 |
| `credential-migration-spec.mjs` | +19（16→35） | 已有文件扩写 |
| **新增断言总计** | **155** | |

> ⚠️ 口径澄清，避免三种数字混用：
> - **spec 文件数**：37 → **41**（新增 5，其中上一轮新增的未提交文件已被计入 37）
> - **测试用例（spec 内的 check 项）数**：680 → **774**（+94）
> - **新增断言条目（含新文件全部 + 旧文件净增）**：**+155**
>
> 774 − 680 = 94 是「spec 内 check 项」的净增；155 是「新增断言条目」，
> 包含被合并/改写后不再单独计数的旧项。两个数都对，但**口径不同，不能互换引用**。

### 4.4 复现过的「假失败」（已定位，非缺陷）

| 现象 | 真因 | 处理 |
|---|---|---|
| PowerShell 循环里跑 spec 出现 exit 1 但摘要全绿 | `2>&1` 把 Node 的 stderr 警告转成 `NativeCommandError` 记录 | 每个 spec 独立 pwsh 调用 + 立即读 `$LASTEXITCODE`，全部 0 |
| `security-review-fixes-spec` 报「没有停网关」 | `slice(i, i+3000)` 魔数切片，`clearAuthorization` 变长后截断 | 改为按真实函数体截取；**收紧**而非放宽 |
| `credential-security-spec` 报「没有清理旧版明文副本」 | 同上，且断言只认 `clearLegacyCredentialStorage(` | 改为 `/clearLegacyCredentialStorage(Verified)?\(/` |
| `integration-product` 4 项失败「状态没变成 online：unknown」 | **测试脚手架缺口**：该文件只注册 ESM loader hook，没挂 CJS hook，而 `secureStore.ts` 用裸 `require('react-native-keychain')` → 加载真实 RN 包 → Flow 语法 `SyntaxError` → 凭据全读不到。P0-1 之前「读不到」被静默当成「没有」，所以缺口一直没暴露 | 补 CJS hook；**未改产品代码**。真机 Metro 打包时 `require` 一直在 |
| 同文件后续 2 项失败「首次连接没成功」 | 同一缺口修好后的次生现象：Keychain 真的能存了 → 上一个测试的 token 残留到下一个测试 | `seedCookie()` 里同时重置安全存储（该 helper 契约本就是「保证走全新配对」） |

### 4.5 未完成的验证（诚实列出）

| 项 | 状态 | 原因 |
|---|---|---|
| `npm test` 原始命令 | ❌ 未跑通 | `tsx`/esbuild `spawn EPERM`（沙箱） |
| Android 真机全部 12 章 57 项 | ❌ `NOT RUN` | **无真机** |
| `assembleDebug` 产生 APK | ❌ 失败 | 见第 5 节（环境限制，已证明） |
| iOS 构建 | ❌ 未尝试 | 无 macOS 环境 |
| 原生 C++ 层（new arch/hermes/各 native module） | ❌ 未验证 | 构建在 CMake 阶段被阻断 |
| `e2e.mjs`（连真实 DSH） | ❌ 未跑 | 需真实 DSH 服务 |

---

## 5. APK 构建结果

**结论：`assembleDebug` 失败，本轮未产出可交付 APK。失败原因是已证明的环境限制，
不是项目代码、不是依赖问题、不是 SDK/NDK 配置错误。**

详见 `dsh-mobile/APK-BUILD-REPORT.md`。摘要：

### 5.1 构建命令与结果

```powershell
$env:JAVA_HOME='D:\Jdk21'; $env:ANDROID_HOME='E:\Android\Sdk'
$env:GRADLE_USER_HOME='E:\work\dsBot\_gradle-home'
cd dsh-mobile\android; .\gradlew.bat --no-daemon --console=plain --stacktrace assembleDebug
```

```
> Task :app:configureCMakeDebug[arm64-v8a] FAILED
FAILURE: Build failed with an exception.
BUILD FAILED in 31m 56s
GRADLE_EXITCODE=1
```

### 5.2 实际失败阶段与根因（已用最小用例证明）

失败任务：`:app:configureCMakeDebug[arm64-v8a]`（原生库配置阶段，APK 打包之前）。

**根因：当前沙箱禁止父进程通过管道捕获子进程的 stdout。** 实测：

```
node spawnSync('cmd',['/c','echo hi'],{stdio:'pipe'})     -> status=null  error=EPERM
node spawnSync('cmd',['/c','echo hi'],{stdio:'ignore'})   -> status=0
node spawnSync('cmd',['/c','echo hi'],{stdio:'inherit'})  -> status=0
```

`ninja` **无条件**通过管道捕获子进程输出，因此：

```
ninja --version                                        -> exit 0   ("1.10.2")   ← 不 spawn 子进程
ninja 构建规则 command = cmd /c echo hi > out          -> exit -1  (无任何输出)
ninja 构建规则 command = clang.exe --version > out     -> exit -1  (无任何输出)
```

这解释了 Gradle 的报错为什么只到 `-- Detecting C compiler ABI info` 就断：
CMake 的编译器**识别**步骤成功（`CMakeOutput.log` 明确写了 `succeeded`，
`CMakeCCompilerABI.c.o` 确实产出了），紧接着 `try_compile` 的**链接**步骤交给
ninja，ninja 试图管道 spawn 链接器 → EPERM → 退出 -1 且错误串为空，
所以 Gradle 只能报 `[CXX1429] error when building with cmake`，拿不到底层诊断。

### 5.3 失败分类（四选一）

| 类别 | 判定 | 证据 |
|---|---|---|
| 项目代码错误 | ❌ 不是 | Metro 生产打包成功（2,102,992 B，SHA256 `E0187884…F6017`），`tsc --noEmit` 干净 |
| 依赖解析问题 | ❌ 不是 | 配置阶段 `:app:tasks` **BUILD SUCCESSFUL in 4m 20s**，完全离线跑通（缓存已预置） |
| SDK/NDK 配置问题 | ❌ 不是 | 工具链健康：`clang --version` / `-c` 编译 / Android 全链接参数 `-shared` 均 **exit 0 并产出文件**；`llvm-ar` exit 0；CMake `execute_process` 管道捕获 rc=0 |
| **环境权限问题（沙箱）** | ✅ **是这个** | 上面的 `stdio:'pipe'` → EPERM；ninja 手工重跑其三命令全部 exit 0，同样的命令经 ninja 必挂 |

> 另有**次要**发现：`gradlew.bat` 首次报
> `FileNotFoundException: ...gradle-8.14.3-bin.zip.lck (拒绝访问)`。
> 经写探针证明原因是 `C:\Users\xis\.gradle` 不可写（工作区之外），
> **不是 wrapper 坏了** —— 把 `GRADLE_USER_HOME` 指到工作区内即 exit 0。
> 这是独立于 CMake 的第二层沙箱限制。

### 5.4 未规避的原因（刻意的）

CMake + ninja 是 AGP `externalNativeBuild` 的既定路径，RN 0.81 `newArchEnabled=true`
必须有它（`libappmodules.so`、`libreact_codegen_*.so`、hermes 等）。
用 `CMAKE_TRY_COMPILE_TARGET_TYPE` 之类绕过 ABI 探测只会让 configure 过而
真实编译依旧全挂；改用 ndk-build 属于本轮明确禁止的大规模架构变更。
**不做这些规避**，因为产出的包既不真实也不代表构建机能产出的东西。

### 5.5 可以断言的事实（无需构建）

| 项 | 值 | 来源 |
|---|---|---|
| `applicationId` | **`com.dshpocket`（未变）** | `android/app/build.gradle:82` |
| `namespace` | `com.dshpocket` | 同上 `:80` |
| `versionCode` | 默认 `1`，来自 `findProperty('DSH_VERSION_CODE') ?: '1'` | 本轮**未传** `-PDSH_VERSION_CODE` |
| `versionName` | 默认 `1.0`，来自 `findProperty('DSH_VERSION_NAME') ?: '1.0'` | 本轮**未传** `-PDSH_VERSION_NAME` |
| 签名 | debug 用 `signingConfigs.debug`；release 仅在传 `-PDSH_STORE_FILE` 时用正式密钥（本轮未传） | `build.gradle:97–102,115,118` |
| 构建模式 | Debug / 测试构建 | `assembleDebug` |

### 5.6 ⚠️ 现有 APK 是陈旧的

`dsh-mobile/android/app/build/outputs/apk/debug/app-debug.apk`
**137,286,513 B @ 2026-10-23 19:12:31** —— 早于本轮所有源码改动，
**不得**作为本轮产物交给测试人员。本轮**未删除、未覆盖**它。

### 5.7 真实构建机需要做的

在有网络、`HOME` 可写、允许父子进程管道的标准 Android 构建环境上执行：

```bash
cd dsh-mobile/android
./gradlew assembleDebug -PDSH_VERSION_CODE=<n> -PDSH_VERSION_NAME=<v>
```

预期产物：`app/build/outputs/apk/debug/app-debug.apk`，`applicationId=com.dshpocket`。

---

## 6. 剩余风险

### 6.1 必须修复的安全问题（阻塞发布）

**无。**

六类问题全部修复，全量自动化测试 0 失败。
需要说明的是：「修好」的证明力上限是自动化测试 + Metro 打包，
**真机行为尚未验证**（见 6.2），所以这不等于「已验证无阻塞问题」。

### 6.2 需要真机验证的问题（发布前必须做）

| # | 项 | 为什么必须真机 |
|---|---|---|
| 1 | Keystore / Keychain 在真机上的实际行为 | 测试用的是内存替身；「写成功但读不回」「锁屏后密钥失效」只有真机才有 |
| 2 | 双通道降级（AsyncStorage 坏 → Keychain） | 需要真实的存储故障才可能触发 |
| 3 | 原生 CookieManager 复核路径 | `getAll()` 在 Android 恒 reject，`get(url)` 兜底**只在真机成立** |
| 4 | 撤销后不自动重连（等 60 秒） | 涉及真实 WS + 退避定时器 |
| 5 | 换服务器 / 注册表重建后的身份绑定 | 需要真实 `gatewayId` 变化 |
| 6 | 旧版 APK 覆盖安装 + 明文迁移清理 | 需要真实旧版本与 adb |
| 7 | 后台被杀 / 崩溃窗口 | 涉及系统进程管理 |

→ 全部列在 `RELEASE-ACCEPTANCE-CHECKLIST.md`，共 **12 章 57 项**，
阻塞项已在清单末尾单独标出。

### 6.3 可以接受的已知限制

| 限制 | 说明 | 影响 |
|---|---|---|
| 两个存储同时不可用时，无法保证跨重启拦截 | 物理限制：没有可写的持久化介质就没有跨重启状态 | 已**明确告知用户**（`ok:false` + 专门文案）；凭据面已降到最低 |
| 老协议服务器（无 `gatewayId`）撤销可能报「无法确认」 | 协议缺陷，不能虚构身份 | 用户需去电脑上核对一次；不会假成功 |
| Android 无 baseUrl 时 cookie 清理返回 `unverified` | `getAll()` 不可用且无法枚举 | 正常路径（清除授权）都带 baseUrl，实际不会遇到 |
| 撤销标记不用「删标记」来解决存储错误 | 删标记等于放弃用户决定 | 已按需求禁止 |

### 6.4 不影响发布的工程整洁度问题

| 问题 | 现状 |
|---|---|
| `npm test` 在受限环境跑不了（`tsx` spawn EPERM） | 已提供并文档化 Node 原生引导（`tests/support/node-ts-bootstrap.mjs`）；建议后续评估 `tsx` 替代或给 CI 加 `--experimental-transform-types` 路径 |
| 5 处静态检查仍在扫源码 | 已加注释说明「为什么必须静态」+ 禁止魔数切片 |
| 仓库根目录有 8 个 `BUILD-LOG-*.txt` | 是本轮构建证据；如需精简可移入 `docs/` 或删除 |
| 构建期产生约 4.66 GB 沙箱缓存（`_gradle-home/` 等） | 已加入 `.gitignore`；**未删除**（删除属破坏性操作，留给用户决定） |
| Node 每个 spec 都打印 `ExperimentalWarning` / `MODULE_TYPELESS_PACKAGE_JSON` | 纯噪音，不影响退出码；加 `"type":"module"` 会波及产品代码加载方式，本轮不动 |
| 上一轮未提交改动仍在工作区 | 按要求**全部保留**，未 reset / 未 clean |

---

## 7. 发布结论

### **B. 代码已满足构建条件，但还需真机验收**

理由（逐条对应证据）：

| 等级 | 判定 | 依据 |
|---|---|---|
| A. 仍存在阻塞性代码问题，不建议构建 | ❌ 不选 | 六类问题全部修复；774 项单测 + 61 项集成测试 0 失败；`tsc` 干净；Metro 生产打包成功 |
| **B. 代码已满足构建条件，但还需真机验收** | ✅ **选这个** | 代码层已验证；真机 57 项全部 `NOT RUN`（无真机）；构建环境缺陷已证明与代码无关 |
| C. APK 已构建成功，待真机验收 | ❌ 不能选 | **本轮没有产出 APK**。`assembleDebug` 失败于 `:app:configureCMakeDebug`，根因是沙箱的子进程管道限制（已用最小用例证明），不是代码问题，但**产物确实不存在**。现有 `app-debug.apk` 是 2026-10-23 的陈旧包 |
| D. 全部验收通过，具备发布条件 | ❌ 不能选 | 真机零验证 |

> **为什么不是 A**：构建失败的原因已被证明在环境侧（工具链健康、依赖解析通过、
> 项目 JS/TS 打包通过、最小用例复现 EPERM）。把它记成「代码有问题」会误导下一轮。
>
> **为什么不是 C**：没有 APK 就是没有。不能因为「只差环境」就把 B 说成 C ——
> C 的定义是「APK 已构建成功」，本轮不成立。

### 下一步（不在本轮范围）

1. 在标准 Android 构建机执行 `assembleDebug`，产出本轮 APK
2. 按 `RELEASE-ACCEPTANCE-CHECKLIST.md` 做 12 章 57 项真机验收（阻塞项必须全 PASS）
3. 真机通过后再决定是否升到 C / D
4. 本轮所有改动仍未提交 —— 是否提交、如何拆分 commit、是否打 tag，由人工决定

---

## 附录 A：验证命令速查

```bash
cd dsh-mobile

# 类型检查
node node_modules/typescript/bin/tsc --noEmit

# 单个 spec（受限环境下的备用引导）
node --experimental-transform-types \
     --import ./tests/support/node-ts-bootstrap.mjs tests/<name>-spec.mjs

# 本轮新增的 5 个安全 spec
node --experimental-transform-types --import ./tests/support/node-ts-bootstrap.mjs tests/revocation-persistence-spec.mjs
node --experimental-transform-types --import ./tests/support/node-ts-bootstrap.mjs tests/cookie-cleanup-spec.mjs
node --experimental-transform-types --import ./tests/support/node-ts-bootstrap.mjs tests/server-identity-binding-spec.mjs
node --experimental-transform-types --import ./tests/support/node-ts-bootstrap.mjs tests/migration-race-spec.mjs
node --experimental-transform-types --import ./tests/support/node-ts-bootstrap.mjs tests/credential-migration-crash-spec.mjs

# 集成测试
node tests/integration-transport.mjs
node tests/integration-gateway.mjs
node tests/integration-long-session.mjs
node --experimental-transform-types --import ./tests/support/node-ts-bootstrap.mjs tests/integration-product.mjs
node --experimental-transform-types --import ./tests/support/node-ts-bootstrap.mjs tests/integration-gateway-reconnect.mjs

# Metro 生产打包（验证真实 Babel 管线）
npx --no-install react-native bundle --platform android --dev false \
  --entry-file index.js --bundle-output <out>/index.android.bundle \
  --assets-dest <out>/res --max-workers 1
```

在**不受限**环境（`npm test` 可用）下，上面的 spec 已全部接入 `package.json`：

```bash
npm test                    # 含 5 个新 spec + typecheck
npm run test:revpersist     # 单独跑某个
```

## 附录 B：关键常量 / 键名一览

| 键 / 值 | 用途 | 是否秘密 |
|---|---|---|
| `@dsh/approvalRevoked` (AsyncStorage) | 撤销标记主通道 | 否 |
| `dsh.revocationMarker` (Keychain) | 撤销标记降级通道 | 否（不含凭据） |
| `@dsh/loginIntent` (AsyncStorage) | 登录意图 | 否 |
| `dsh.cookie` (Keychain) | 会话 Cookie | **是** |
| `dsh.gatewayToken` (Keychain) | 审批长期 token | **是** |
| `dsh.gatewayDeviceId` (Keychain) | 客户端安装标识 | 否 |
| `dsh.gatewayServerDeviceId` (Keychain) | 服务端注册表 UUID | 否 |
| `dsh.gatewayServerBinding` (Keychain) | **本轮新增**：`{baseUrl, gatewayId, deviceId}` | 否 |
| `@dsh/cookie` / `@dsh/lastCookie` / `@dsh/gatewayToken` / `@dsh/gatewayDeviceId` | 旧版本明文键（迁移后删除） | **是** |
