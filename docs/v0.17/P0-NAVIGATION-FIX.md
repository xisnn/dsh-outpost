# P0-1 Android ChatScreen 导航修复报告

日期：2026-10-29
项目：`E:\work\dsBot`
分支：`feat/v0.17`
模拟器：`dsh_verify`（`emulator-5584`）

## 1. 问题根因

导航失败不是 `NavHost` / `SessionsScreen` / `ChatScreen` 的路由缺陷，而是测试环境中的 **Android 通知运行时权限对话框** 未被处理：

- App 首次启动弹出 `Allow DSH Outpost to send you notifications?`；
- 之前的固定坐标点击落在权限 Activity 或已关闭的 Activity 上；
- 点击后 App 任务退出到 Launcher，后续工作区/会话点击全部无效；
- 因此表现为“无法稳定进入 ChatScreen”。

实际日志：

```text
mFocusedApp=ActivityRecord{... com.google.android.permissioncontroller/...GrantPermissionsActivity}
```

解决方式（测试环境，不修改生产导航）：

```text
adb shell pm grant com.dshpocket android.permission.POST_NOTIFICATIONS
```

授权后 App 主 Activity 正常保持：

```text
mFocusedApp=ActivityRecord{... com.dshpocket/.MainActivity t64}
```

## 2. 稳定导航路径

使用 UIAutomator 按 `content-desc` 定位，不依赖固定屏幕坐标：

1. 启动 App 到首页；
2. 点击工作区 `content-desc` 包含 `dsBot` 的卡片；
3. 在会话列表中点击 `content-desc` 包含目标 `session-...` 的卡片；
4. 确认 ChatScreen 出现：
   - `text="发消息…"` 的 `android.widget.EditText`
   - 目标 `sessionId`
5. 点击输入框并输入文本 `navcheck`，不发送。

自动化脚本：[android-chatscreen-nav.ps1](scripts/android-chatscreen-nav.ps1)

## 3. 连续三次结果

使用上述可访问性定位和 15 秒启动等待，连续三次：

```text
RUN3 workspaceTap=True chatInput=True sessionIdVisible=True INPUT_OK
RUN4 HOME_HAS_DSBOT=True WORKSPACE_HAS_SESSION=True CHAT_INPUT=True SESSION=True
RUN5 HOME_HAS_DSBOT=True WORKSPACE_HAS_SESSION=True CHAT_INPUT=True SESSION=True
```

目标会话：`session-6598f5e6-e90a-485c-ba08-d7c01910c464`

- 三次均从首页进入工作区；
- 三次均找到目标会话；
- 三次均成功挂载 ChatScreen；
- 三次 sessionId 一致；
- 输入框可正常输入 `navcheck`。

## 4. 证据

- ChatScreen 截图：[P0-NAV-CHATSCREEN.png](P0-NAV-CHATSCREEN.png)
- 导航 UI 层级：`step0.xml`→`step1.xml`→`step2a.xml`→`step2b.xml`，以及 `run3/4/5-*.xml`
- 前台 Activity：`com.dshpocket/.MainActivity t64`
- 测试 APK：
  - 路径：`dsh-mobile/android/app/build/outputs/apk/debug/app-debug.apk`
  - SHA-256：`DAC0D250936F00862BCED7DD53BA8C43346846A6F0E360E02CAC05F0615E79B7`
  - 签名：`CN=Android Debug`（测试包，不可发布）
  - 代码 HEAD：`c4e4f59`

## 5. 结论

**导航阻断已解决。**

修复仅针对测试自动化：先 `pm grant` 通知权限，再用可访问性 selector 导航；未修改生产导航业务逻辑，未增加外部导航后门。任务 A 的回执丢失测试、任务 B、C 未在本轮执行。
