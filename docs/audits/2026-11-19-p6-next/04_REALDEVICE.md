# 04 · 真机验收授权与边界（P6-next，第二方明确授权）

- 授权：第二方「我连接手机了，可以做真机了」（2026-11-19 会话）。
  此前 P4-0 审计刻意不用个人真机；本轮获明确授权后启用。
- 设备：vivo V1981A（PD1981），Android 12 / **API 31**，serial `762a319`。
  ⇒ API36 FGS dataSync 上限**仍无法在本机验证**（需 API36 设备），继续 BLOCKED。
- 隔离包：`com.dshoutpost.p1.p6next`（release 变体、JS 内置、本地 debug 签名
  `-PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true`，**绝不进 CI/发布**；versionCode 916204
  高于正式版，**验完必须卸载**）。
- Shizuku：官方 RikkaApps v13.6.0 release APK（GitHub releases 下载，2.57MB），
  ADB 模式启动（uid 2000），与 P6-13 同源同版本线。

## 安全边界（本轮遵守）

1. 只驱动隔离测试包；**不碰主屏个人应用/数据/凭据**；正式 DSH/注册表零触碰。
2. 手势/输入靶为虚构 UI 或隔离副屏上的非敏感应用（Contacts/Settings 列表页），
   负向先打虚构 UI；**敏感屏（支付/银行/密码）不做靶**。
3. 副屏操作经 Shizuku 虚拟显示，主屏前台不受影响；home/recents 仅 display-targeted。
4. 无障碍设置改动前已记录原值（P6-realdevice-prior-a11y-settings.txt），验收后恢复。
5. 全程本地确定性桩模型（loopback），**不调用收费云模型**。
6. 验完卸载隔离包与 Shizuku（除非第二方要求保留），恢复无障碍原值。

## 验收计划（证据进 evidence/）

A. connected androidTest（真机服务绑定可靠，emulator 的 rebind skip 不适用）：
   ScreenStaleFailClosedTest / KeychainStorageValidationTest / RuntimeInstallerChecksTest。
B. adb 驱动隔离包 Run（loopback 桩）：审批卡→allow→副屏 tap/type/scroll 真手势
   RED/GREEN；中文输入；密码框转接管负向。
C. 批 1/批 2 新门真机负向：STALE_SCREEN / STALE_NODE（副屏恢复后换节点）/
   APPROVAL_EXPIRED（TTL 过期 allow 拒）/ 取消及时性（在飞模型断开）/
   副屏 home/recents + 空屏 OK_DISPLAY_EMPTY / 敏感词边界真屏判定。
D. 息屏即终止真机行为（input keyevent POWER 息屏→run 停止+通知文案）；
   OEM 后台查杀长时观察（有限窗口，诚实记录）。
E. 每项留 screenshot / logcat / dumpsys / uiautomator dump 证据；BLOCKED 诚实列。

## 状态

- 构建/安装/驱动进行中；结果见 05_REALDEVICE_RESULTS.md（完成后写）。
