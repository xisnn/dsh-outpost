# Android 安全存储验证报告（react-native-keychain 10.0.0）

| 项 | 值 |
|---|---|
| 验证日期 | 2026-10-28 |
| 验证对象 | `react-native-keychain` **10.0.0**（`dsh-mobile/package.json` / `package-lock.json` 锁定） |
| 验证设备 | Android Emulator `dsh_verify`（Android 15 / API 35 / x86_64，可写 workspace AVD） |
| 关联代码 | `dsh-mobile/src/core/pendingSend/persistence.ts` |
| 关联测试 | `android/app/src/androidTest/java/com/dshpocket/KeychainStorageValidationTest.kt` |

---

## 1. 结论摘要

1. **Android 实际加密**：`react-native-keychain` 10.0.0 的 Android 默认非认证存储是 `CipherStorageKeystoreAesGcm`，使用 **AES-256 / GCM / NoPadding**，密钥生成并保存在 **AndroidKeyStore**；密文（含 IV）以 Base64 写入 AndroidX DataStore 的 `RN_KEYCHAIN.preferences_pb`，不是明文 SharedPreferences。
2. **`accessible` 不是 Android 保证**：`accessible` 在类型定义中标注为 `@platform iOS, visionOS`；Android `KeychainModule` 只把它当作一个未使用的常量 key（`Maps.ACCESSIBLE`），没有读取该选项。**禁止把 `WHEN_UNLOCKED_THIS_DEVICE_ONLY` 当成 Android 的锁屏保证。**
3. **锁屏行为**：实际生成的 Keystore key 使用 `setUserAuthenticationRequired(false)`（非认证 AES-GCM），`KeyInfo.isUserAuthenticationRequired == false`。这表示 Keychain 本身没有“设备锁屏后必须认证”的门槛；任何能以本 App 身份运行、且设备已完成首次解锁的进程都可以解密。
4. **备份行为**：应用 Manifest `android:allowBackup="false"`；DataStore 位于应用内部 `files/datastore/`；KeyStore 密钥不可导出。系统备份不会带走这些数据。
5. **容量/性能**：实测 240 KiB 明文的加密、写入、读取、解密均成功；20 次 8 KiB 重写稳定（具体数据见第 4 节）。
6. **实现选择**：Android 侧显式传 `storage: KeystoreAESGCM_NoAuth`，并在 `setGenericPassword` 返回后校验 `storage` 一致；不一致则拒绝写入，避免静默降级到 AES-CBC 或认证存储。

---

## 2. 源码证据（静态核对）

| 事实 | 证据 |
|---|---|
| Android 使用 AES-GCM | `node_modules/react-native-keychain/android/.../cipherStorage/CipherStorageKeystoreAesGcm.kt`：`ENCRYPTION_TRANSFORMATION = AES/GCM/NoPadding`，`ENCRYPTION_KEY_SIZE = 256` |
| Key 存 AndroidKeyStore | 同文件：`KeyGenerator.getInstance(getEncryptionAlgorithm(), KEYSTORE_TYPE)`，`KEYSTORE_TYPE = "AndroidKeyStore"` |
| 非认证 cipher 不要求用户认证 | 同文件：仅 `requiresAuth` 为 true 时调用 `setUserAuthenticationRequired(true)`；默认 `KeystoreAESGCM_NoAuth` 的 `requiresAuth=false` |
| 密文落盘位置 | `DataStorePrefsStorage.kt`：`preferencesDataStore(name = KEYCHAIN_DATA)`，`storeEncryptedEntry()` 把 username/password 经 Base64 写入 DataStore |
| `accessible` 适用范围 | `node_modules/react-native-keychain/lib/typescript/types.d.ts:38-42`：`accessible?: ACCESSIBLE` 标注 `@platform iOS, visionOS` |
| Android 不读取 `accessible` | `KeychainModule.kt`：`Maps.ACCESSIBLE` 只在常量定义出现；`getAccessControlOrDefault()` 读的是 `accessControl`，`getSelectedStorage()` 读的是 `storage` |
| 备份关闭 | `dsh-mobile/android/app/src/main/AndroidManifest.xml:27`：`android:allowBackup="false"` |

> 说明：源码证据是静态结论；第 4 节为模拟器实测结果。

---

## 3. 动态验证方法

`KeychainStorageValidationTest.kt` 直接驱动 Android 实现，不依赖 React 渲染：

1. `CipherStorageKeystoreAesGcm` 加密固定明文，检查密文 != 明文。
2. 从 `AndroidKeyStore` 取 key，读取 `KeyInfo`，断言 `keySize=256`、`isUserAuthenticationRequired=false`。
3. `DataStorePrefsStorage.storeEncryptedEntry()` 写入后读取，再解密回明文，验证 round-trip。
4. 检查 `files/datastore/RN_KEYCHAIN.preferences_pb` 存在、非空、文件内容不含明文。
5. 检查 `ApplicationInfo.FLAG_ALLOW_BACKUP == 0`。
6. 240 KiB 大 payload 与 20 次 8 KiB 重写性能测试。

运行命令（模拟器）：

```powershell
adb -s emulator-5584 shell am instrument -w \
  -e class com.dshpocket.KeychainStorageValidationTest \
  com.dshpocket.test/androidx.test.runner.AndroidJUnitRunner
```

---

## 4. 动态验证结果

执行环境：

- AVD：`dsh_verify`（Android 15 / API 35 / x86_64，workspace 内可写 AVD）
- 应用：`com.dshpocket` debug（`versionCode=1`，`versionName=1.0`）
- 测试包：`com.dshpocket.test`
- 运行命令：`adb -s emulator-5584 shell am instrument -w -r -e class com.dshpocket.KeychainStorageValidationTest com.dshpocket.test/androidx.test.runner.AndroidJUnitRunner`
- 结果：**OK (5 tests)，Time: 7.103s，INSTRUMENTATION_CODE: -1（AndroidJUnitRunner 成功结束码）**

| # | 测试 | 结果 | 证据/备注 |
|---|---|---|---|
| 1 | AES-256/GCM 密文 != 明文 | **PASS** | `CipherStorageKeystoreAesGcm` 加密后 ciphertext ≠ UTF-8 明文；KeyInfo.keySize=256、key.algorithm=AES |
| 2 | KeyInfo.keySize=256、isUserAuthenticationRequired=false | **PASS** | 实测非认证 `KeystoreAESGCM_NoAuth`；**没有锁屏认证门槛** |
| 3 | DataStore 密文 round-trip = 明文 | **PASS** | `DataStorePrefsStorage.storeEncryptedEntry()` → `getEncryptedEntry()` → `decrypt()` 得到原明文（含中文/emoji） |
| 4 | DataStore 文件不含明文 | **PASS** | 测试断言 `files/datastore/RN_KEYCHAIN.preferences_pb` 存在、非空、内容不含测试明文；tearDown 后条目清除，文件回到 0 bytes |
| 5 | allowBackup=false | **PASS** | `ApplicationInfo.FLAG_ALLOW_BACKUP == 0` |
| 6 | 240 KiB 加解密/读写性能 | **PASS** | 实测 `encrypt=194.06ms write=906.43ms read=341.88ms decrypt=274.26ms`（模拟器软件环境） |
| 7 | 20×8 KiB 重写稳定 | **PASS** | 实测 `20 次 × 8KiB total=3401.84ms`（平均约 170ms/次，模拟器软件环境） |
| 8 | 锁屏状态下读取 | **PASS** | 设置 PIN 后 `dumpsys window policy`：`showing=true`、`screenState=SCREEN_STATE_OFF`、`interactiveState=INTERACTIVE_STATE_SLEEP`；同一 round-trip 测试仍通过（1.024s）。这说明非认证 AES-GCM **没有阻止锁屏下 App 进程读取/解密** |

> 实测环境为无硬件安全模块的模拟器；`KeyInfo` 报告 key 使用 AndroidKeyStore AES-256/GCM，但不代表每台真机都有 TEE/StrongBox。安全结论按“软件 Keystore 最低保证”表述。

---

## 5. 对 P0-1 实现的影响

- **必须做**：Android 使用 `KeystoreAESGCM_NoAuth`，并用 `setGenericPassword` 返回的 `storage` 做断言；不能只传 `accessible`。
- **必须承认的边界**：Keychain 提供的是“文件/备份被拷走后无法解密”的静态保护，不是“锁屏后 UI 无法读取”的运行时门禁。若产品要求锁屏认证，需要改走 `ACCESS_CONTROL.DEVICE_PASSCODE`/生物识别，并接受每次读写触发系统认证或短有效期带来的 UX 成本；P0-1 不采用。
- **补充边界**：`allowBackup=false` 是应用级备份控制，不能替代 Keychain 加密；两者需同时存在。

---

*报告状态：动态验证完成（2026-10-28）· 5/5 Android 仪器测试通过 · 锁屏读取实测通过*
