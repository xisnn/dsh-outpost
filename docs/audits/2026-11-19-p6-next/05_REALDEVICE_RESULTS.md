# 05 — 真机验收结果（vivo V1981A / Android 12 / API 31）

日期：2026-11-20。授权与边界见 04_REALDEVICE.md。隔离包 com.dshoutpost.p1.p6next
（release + JS 内置 + debug 签名，versionCode 916204）；Shizuku v13.6.0 ADB 模式。

## 1. 真机真成绩（run1，am instrument 直跑，OK (12 tests) = 7 过 + 5 诚实 skip）
| 类 | 结果 | 说明 |
|---|---|---|
| KeychainStorageValidationTest | 5/5 | 真机 Keystore（StrongBox/TEE）读写/别名/清理 |
| RuntimeInstallerChecksTest | 1/1（19 组） | 安装器安全检查真机执行 |
| ScreenStaleFailClosedTest | 1 过 + 1 skip | failClosedDecision 真机过；changedScreen… 因无障碍服务实例未绑定 skip（vivo 对 settings put 启用无障碍不自动绑定，需设置 UI 确认） |
| RealDeviceGatesTest | 4 skip | run1 时 Shizuku 未授权隔离包（已授权 0 个应用），assumeTrue 诚实 skip |

## 2. 副屏真手势门：BLOCKED-on-vivo（环境，非代码断言失败）
- run2（补 Shizuku 授权后）：Shizuku 管理页占前台 + 隔离 App 进程 D 状态，用例挂死。
- run3：instrument 会话静默死亡；vivo 限制 logcat（仅 9 行）、dropbox 无崩溃记录，盲诊断不可行。
- run4（单用例有界尝试）：>355s 无产出，挂死，kill。
- run5（前置全齐：Shizuku 授权 checked=true、server 活、管理器关、a11y 真绑定
  Bound=[收藏, DSH Outpost]）：am instrument 下 App 进程仍 D 状态、副屏未建（dumpsys display
  仅 displayId=0）、前台桌面；但 force-stop 后 **monkey 直起 App 进程 S 状态健康、MainActivity
  正常聚焦**。对照 run1（Shizuku 未授权时 instrument 能跑、Keychain 5/5 过）。
- 收窄根因：**vivo 上 Shizuku 已授权的隔离包在 am instrument 启动路径下挂死**（疑似 Shizuku
  UserService bind 与 instrumentation 启动的 binder 死锁），monkey 路径正常。属设备控制敏感
  模块的环境级阻塞；修复（Shizuku 懒绑定/绑定超时）需第二方批准。
- 结论：realGestures(tap/type/scroll 副屏)、staleScreen 真机负向、nodeIdentity 真机负向、
  home/recents 三态 **未在真机闭环**，记 BLOCKED-on-vivo-instrumentation。验证层仍为
  agent-core 83/83 JVM 契约 + CI 全绿 + 本地全量链 123/123 + run1 真机真成绩。
- 重试建议（下轮）：改用 API 35 emulator 跑 RealDeviceGatesTest（P6-13 核心路径曾在
  emulator 跑通）；或真机侧先经设置 UI 确认无障碍绑定 + 开 vivo「USB 调试（安全设置）」
  恢复 logcat + 保持管理器关闭；服务侧手势等待加有界超时属敏感改动，需另批。

## 3. 仍 BLOCKED（不变）
- API 36 FGS dataSync 上限：本机 API 31，无设备。
- #37 libproot.so：全链路保持链外。
- 候选 2（home/recents 误报语义）：设计-only 未批。

## 4. 设备清理（按 04 边界执行）
- 无障碍恢复原值：com.vivo.favorite/com.vivo.favorite.support.accessibility.ActivityMonitorService，accessibility_enabled=1。
- 卸载 com.dshoutpost.p1.p6next、com.dshoutpost.p1.p6next.test、moe.shizuku.privileged.api。
- 主屏个人数据全程零写入；手势负向仅虚构 UI/非敏感列表靶。

## 5. 证据
evidence/logs/P6-realdevice-{build,androidtest,instrument,probe,probe-logcat,gates-run2,gates-run3,gates-run4,gates-run5}.log；
evidence/P6-realdevice-prior-a11y-settings.txt；evidence/P6-realdevice-gates-blocker-diagnosis.txt。
