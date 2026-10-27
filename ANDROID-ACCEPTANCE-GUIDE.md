# Android 真机验收 —— 操作指南

> 目标：用 CI 已验证过的同一把私有证书，在本机构建签名 APK 并装到真机验收。
> 本文不含任何密码、密钥或敏感信息。

---

## 一、最少操作（3 步）

```powershell
cd E:\work\dsBot

# 1. 构建（会提示输入 keystore 路径与密码）
.\build-signed-apk.ps1

# 2. 装到手机（需先开 USB 调试）
adb install -r "_acceptance-apk\<上面输出的文件名>.apk"

# 3. 验完卸载（重要，见 §5）
adb uninstall com.dshpocket
```

脚本会**自动校验**证书指纹是否等于 CI 验证值 `191b16ce…736a`，
不一致会直接报错并说明原因。

---

## 二、脚本做了什么

| 步骤 | 说明 |
|---|---|
| 1 | 检查 gradlew / 定位 apksigner（读 `local.properties` + 常见路径） |
| 2 | 让你选 keystore 文件（可手输路径或弹文件框） |
| 3 | 交互式输入密码（**不回显、不进历史**） |
| 4 | 用 `ORG_GRADLE_PROJECT_*` 环境变量传给 gradle（**不走命令行参数**） |
| 5 | 构建完成后**立即清除**环境变量里的凭据 |
| 6 | `apksigner verify --print-certs` 比对证书指纹 |
| 7 | 复制到 `_acceptance-apk\` 并生成 SHA256SUMS |

### 密码安全设计

- ❌ **不会**作为 `-P` 参数传给 gradle（那会出现在进程列表、PowerShell 历史里）
- ✅ 只用 `Read-Host -AsSecureString` 读入，转 `ORG_GRADLE_PROJECT_DSH_*` 环境变量
- ✅ SecureString 用 `ZeroFreeBSTR` 释放
- ✅ 构建结束（无论成败）在 `finally` 里清空环境变量
- ✅ 脚本不写任何日志文件，不打印任何密码片段

### 非交互模式（可选）

如果你要重复构建，可以自己在 shell 里预设环境变量：

```powershell
$env:DSH_BUILD_STORE_PASSWORD = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
$env:DSH_BUILD_KEY_PASSWORD    = $env:DSH_BUILD_STORE_PASSWORD
.\build-signed-apk.ps1 -KeystorePath 'D:\keys\dsh-release.keystore'
Remove-Item Env:DSH_BUILD_STORE_PASSWORD, Env:DSH_BUILD_KEY_PASSWORD
```

---

## 三、证书校验标准

脚本比对的是 **GitHub Actions run 40467239206** 验证通过的值：

```
证书 SHA-256 : 191b16cebd6f39f64f8cbbe3fcbdd90e2d845a9d7b1fbe19ccdcd819293a736a
证书 DN      : CN=jingchanglong, OU=dshoutpost, O=xis, L=chengdu, ST=chengdu, C=cn
包名         : com.dshpocket
签名方案     : v2 = true（Android 7+ 必需）；v3 = false（可选）
```

脚本会同时拦截：若指纹等于公开 AOSP debug 证书 `fac61745…`，直接报错
（说明误用了仓库里的 debug.keystore）。

手动复核：
```powershell
& 'E:\Android\Sdk\build-tools\36.0.0\apksigner.bat' verify --print-certs `
  "dsh-mobile\android\app\build\outputs\apk\release\app-release.apk"
```

---

## 四、真机验收 12 项

| # | 步骤 | 预期 |
|---|---|---|
| 1 | 旧 debug 签名版上直接装新包 | 系统弹「应用未安装」/ `INSTALL_FAILED_UPDATE_INCOMPATIBLE`。**这是系统报错，不是 App 提示** |
| 2 | 卸载旧版 → 装新包 | 安装成功 |
| 3 | 启动，扫码配对 | 配对成功，进入会话列表 |
| 4 | 电脑运行 `setup-gateway.ps1` | 自动打补丁并报「补丁已就绪」 |
| 5 | **重启 DSH**（`start-dsh-web.ps1`） | 显示「网关认证补丁：已生效」 |
| 6 | 触发需审批的工具调用 | 手机收到审批卡片，可允许/拒绝 |
| 7 | 同网段另一设备 `POST /mgw/pair` | **401**，拿不到配对码 |
| 8 | 断网 10 秒再恢复 | 出现可读断开提示（**不会自动重连**，需手动重进会话） |
| 9 | 面板启动 → 停止 → 再启动隧道 | 三个按钮都生效 |
| 10 | 启动隧道后退出程序 | 面板显示已停；`Get-Process cloudflared` 为空 |
| 11 | 我的 → 设备管理 → 撤销旧设备 | 撤销成功，旧设备无法再连 |
| 12 | （可选）App 内更新器遇签名不一致 | 显示中文 `SignatureMismatchError` 文案 |

**注意步骤 1 和步骤 12 是两条不同代码路径**：直接装 APK 走系统安装器
（报错由 Android 生成，App 改不了）；App 内点更新才走 `SignatureMismatchError`。

---

## 五、⚠️ 验收后必须卸载

构建用的 `versionCode = 916204`，远高于正式版本（约 1.6 万）。
Android **不允许 versionCode 降级**，留着测试包会导致后续正式版装不上：

```
INSTALL_FAILED_VERSION_DOWNGRADE
```

```powershell
adb shell dumpsys package com.dshpocket | Select-String 'versionCode'
adb uninstall com.dshpocket
adb shell pm list packages | Select-String dshpocket   # 应无输出
```

卸载会清掉配对凭据，重装后需重新扫码（这与签名迁移的数据影响一致）。

---

## 六、产物位置

| 内容 | 路径 |
|---|---|
| 交付 APK | `E:\work\dsBot\_acceptance-apk\DSH-Outpost-TEST-0.0.0-verify.local-<时间戳>.apk` |
| 哈希文件 | `E:\work\dsBot\_acceptance-apk\SHA256SUMS-<时间戳>.txt` |
| 原始构建产物 | `E:\work\dsBot\dsh-mobile\android\app\build\outputs\apk\release\app-release.apk` |

`_acceptance-apk\` 已在 `.gitignore` 中忽略，不会误提交。

---

## 七、Windows 程序

### 可用产物

```
dsh-outpost-desktop\release\DSH-Outpost-Desktop-0.16.4-win-x64.zip   139.7 MB
dsh-outpost-desktop\release\win-unpacked\DSH Outpost.exe             228.0 MB
```

zip 是完整可用的便携版（解压即用），已验证包含：
- `resources/scripts/gateway-patch-gate.ps1`
- `resources/patches/mobile-gateway-mgmt-auth/{apply.mjs,patch.mjs,README.md}`

### portable .exe 未能在 CI 沙箱内构建

```
⨯ mkdir ...\electron-builder\Cache\nsis\<随机数字>: Access is denied
```

我已排查：
- 父进程能创建同名目录 ✅
- `app-builder.exe --help` 能正常运行 ✅
- 手动预置 `nsis` 与 `nsis-resources` 包后，**又出现新的随机目录名**（第三方依赖）

结论：NSIS 打包需要 `app-builder` 反复创建缓存子目录，而本会话沙箱限制
其对**子进程文件操作**的权限。**不是代码或配置问题。**

**你自己在终端里构建 portable 即可**（无沙箱限制）：

```powershell
cd E:\work\dsBot\dsh-outpost-desktop
npm run dist
```

产物：`release\DSH-Outpost-Desktop-0.16.4-portable.exe`

---

## 八、本轮改动

| 文件 | 说明 |
|---|---|
| `build-signed-apk.ps1` | 新增：一键构建 + 自动校验证书 |
| `.gitignore` | 新增 `_acceptance-apk/` |

未修改任何生产代码、未改 gradle 配置、未动 CI。
