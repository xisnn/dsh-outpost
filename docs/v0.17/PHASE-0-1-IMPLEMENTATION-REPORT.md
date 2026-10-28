# P0-1 阶段 0/1 实施报告

| 项 | 值 |
|---|---|
| 分支 | `feat/v0.17` |
| 实现提交 | `da3e2cf`（阶段 0/1 实现、测试与报告） |
| 基线 | `06a33e1`（运行时代码等价于 `3349bbf`） |
| 实施范围 | 仅阶段 0（纯函数/状态机/指纹）与阶段 1（安全持久化层） |
| 状态 | **完成；等待下一阶段接线（ChatScreen/Store/App）** |
| 未做 | 未合并 `main`；未修改 `v0.16.7` 标签；未创建 GitHub Release |

---

## 1. 交付物

### 1.1 新增核心模块

`dsh-mobile/src/core/pendingSend/`：

| 文件 | 职责 |
|---|---|
| `types.ts` | `PendingSendRecord` / `PendingSendState` / `PendingSendBinding` / 限额与 TTL 常量 |
| `ids.ts` | requestId 生成：正常发送每次新 ID（时间戳+计数+随机段） |
| `fingerprint.ts` | 文本规范化、UTF-8 字节数、SHA-256、发送指纹、附件身份比较 |
| `state.ts` | 纯状态机、重启恢复、服务实例/授权上下文绑定校验 |
| `persistence.ts` | `KeychainPendingSendPersistence`：Keychain 单文档、Android `KeystoreAESGCM_NoAuth` 校验、错误分类 |
| `store.ts` | `PendingSendStore`：`hydrate/list/create/get/apply/retry/clearAll/prune/recoverAfterRestart/stats`；全部写操作串行化 |

### 1.2 新增测试

| 文件 | 项数 | 状态 |
|---|---|---|
| `tests/pending-send-state-spec.mjs` | 10 | PASS |
| `tests/pending-send-identity-spec.mjs` | 11 | PASS |
| `tests/pending-send-store-spec.mjs` | 13 | PASS |
| `tests/pending-send-persistence-spec.mjs` | 6 | PASS |
| `tests/pending-send-storage-perf.mjs` | 1 基准 | PASS |
| `android/app/src/androidTest/.../KeychainStorageValidationTest.kt` | 5 | PASS（模拟器） |

### 1.3 修改

- `dsh-mobile/package.json`：新增 `test:pendingSendState` / `Identity` / `Store` / `Persistence` / `Perf`，并接入 `npm test` 链。
- `dsh-mobile/package-lock.json`：锁定 `@noble/hashes@2.4.0`（MIT；integrity 见 lockfile）。
- `dsh-mobile/android/app/build.gradle`：增加 Android 仪器测试 runner 与 `androidx.test` 测试依赖（只进 androidTest APK）。
- `docs/v0.17/P0-1-PERSISTENT-SEND-PLAN.md`：按评审反馈修订。
- `docs/v0.17/ANDROID-SECURE-STORAGE-VERIFY.md`：Android 安全存储静态与实测报告。

---

## 2. 评审七点落实

1. **禁止按指纹自动复用**: `PendingSendStore.create()` 永远调用 `idFactory()` 生成新 ID；`retry()` 是唯一读取旧 ID 的入口。`pending-send-store-spec` 明确测试“连续两次完全相同文本 → 两个不同 requestId”。
2. **signOut/clearAuthorization 语义**: 设计文档已改为 `signOut` 保留记录、`clearAuthorization` 才清理并先提示；阶段 1 只提供 `clearAll()` 和绑定校验，UI 接线在阶段 2/4。
3. **绑定服务实例**: `PendingSendRecord.binding` 保存 `{baseUrl, gatewayId, authContextHash, identityQuality}`；`evaluatePendingSendBinding()` 拒绝地址/gateway/授权上下文任一不匹配，缺 gateway 时按 `server-identity-unverifiable` 拒绝重试。
4. **Android 验证**: `KeychainPendingSendPersistence` 在 Android 不传 `accessible`，显式传 `storage: KeystoreAESGCM_NoAuth`，并校验返回 storage；实测 5 项通过，详见 `ANDROID-SECURE-STORAGE-VERIFY.md`。
5. **容量/性能/并发/终止**: 单文档限 20 条/256 KiB；40 个并发 create 全部保留；20 条×8KiB create 多次运行 55–78ms（Node 内存后端）；重启恢复测试覆盖 `sending→unknown`、`preparing→failed`。
6. **@noble/hashes**: `2.4.0` 已锁定，MIT；`sha256Hex` 有已知向量测试。
7. **失败安全**: Keychain 写失败/回读不一致时 `create` 不落内存、不生成新记录；确认写入失败保持 `accepted`、requestId 不变；无网络调用（阶段 1 无网络层）。

---

## 3. 测试结果

### 3.1 Node 单元/回归测试

执行时间：2026-10-28 14:4x（Asia/Shanghai）

| 命令 | 结果 |
|---|---|
| `npm run test:idem` | 12 通过，0 失败 |
| `npm run test:retry` | 9 通过，0 失败 |
| `npm run test:pendingSendState` | 10 通过，0 失败 |
| `npm run test:pendingSendIdentity` | 11 通过，0 失败 |
| `npm run test:pendingSendStore` | 13 通过，0 失败 |
| `npm run test:pendingSendPersistence` | 6 通过，0 失败 |
| `npm run test:pendingSendPerf` | PASS；20×8KiB create 55–78ms（多次运行）；200 次 list 72–100ms；文档 173,665 bytes |
| `npm run typecheck` | PASS（tsc --noEmit 无输出） |

### 3.2 Android 仪器测试

设备：`dsh_verify` AVD（Android 15 / API 35 / x86_64）
App：`com.dshpocket` debug
命令：`am instrument -w ... com.dshpocket.test/androidx.test.runner.AndroidJUnitRunner`

结果：**OK (5 tests)，Time: 7.103s**，所有断言通过：

- AES-256/GCM 密文 != 明文；KeyInfo.keySize=256，`isUserAuthenticationRequired=false`。
- DataStore `RN_KEYCHAIN.preferences_pb` 内部存储，密文 round-trip = 明文，文件不含明文。
- `allowBackup=false`。
- 240 KiB payload：加密 194.06ms / 写 906.43ms / 读 341.88ms / 解密 274.26ms。
- 20×8KiB 重写：3401.84ms。
- **锁屏读取测试**：设置 PIN 后 `showing=true`、`screenState=SCREEN_STATE_OFF`、`interactiveState=INTERACTIVE_STATE_SLEEP`；同一 round-trip 测试仍通过（1.024s），证明非认证 AES-GCM 没有锁屏认证门槛。

> 安全结论：Android 上的保护是“KeyStore 密钥 + 密文 DataStore + allowBackup=false”的静态保护；**不是** iOS `accessible` 语义的锁屏 UI 门禁。若需要锁屏认证，应改用 `ACCESS_CONTROL.DEVICE_PASSCODE` 并接受系统认证/短有效期 UX 成本。

### 3.3 完整 `npm test` 说明

`npm test` 在 `test:mgwPatch` 处停止（23 通过、1 失败：`补丁使文件变大（确实注入了代码）`）。原因是本机已安装的 `C:\Users\xis\.dsh\profiles\web\node_modules\dsh-plugin-mobile-gateway\lib\index.mjs` 已经包含 `DSH_OUTPOST_MGW_AUTH_PATCH` 标记，测试无法再次注入；这是本机插件已被先前流程打过补丁的环境状态，不是 P0-1 代码回归，也不影响本次新增/相关的 61 项断言结果。

如需完整绿跑，应在干净插件副本上执行 `npm test`，或先恢复未被补丁的插件文件；本阶段未修改该外部插件。

---

## 4. 已知限制（阶段 1 范围）

1. 尚未接入 `ChatScreen` / `Store.sendPending` / `App` 启动、退出登录流程；下一阶段才会改变实际发送行为。
2. `PendingSendStore` 的串行化是**进程内**队列；App 单进程场景满足；若未来多进程共享同一 Keychain item，需要进程间锁或独立 storage。
3. Android 仪器测试直接驱动 `CipherStorageKeystoreAesGcm` + `DataStorePrefsStorage`，没有走完整 React Native JS bridge 的 `setGenericPassword` Promise；但静态核对确认 `KeychainModule` 正是组合这两个组件。
4. 模拟器没有 TEE/StrongBox，`KeyInfo` 只能证明 AndroidKeyStore AES-256/GCM + 非认证；真机硬件安全等级需在目标设备复测。
5. 未实现墓碑清理（阶段 4）、未实现附件上传/重传（阶段 3）、未实现 UI 状态气泡（阶段 2）。

---

## 5. 下一阶段进入条件

- 阶段 1 Android 验证已通过。
- 需评审/确认：`PendingSendStore` 与 `Store.sendPending` 的接线方式、UI 状态文案、`authContextHash` 的实际来源（服务端 device UUID + 客户端 device id + cookie 上下文）以及 `clearAuthorization` 的未确认记录提示交互。
- 通过后进入阶段 2：发送编排 + `ChatScreen` 恢复 UI + `App` hydrate/prune。

---

*报告生成：2026-10-28 · 阶段 0/1 · 测试结果以本报告和终端日志为准*
