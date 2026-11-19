# 02 · #43 androidTest 转活与真跑证据

## 孤儿转活

`RuntimeInstallerChecks.java`（0 @Test、无调用者）是完整的安装器安全检查套件
（traversal/绝对路径/反斜杠/重复成员/hardlink/PAX 拒绝、symlink  confinement、
9 个崩溃 checkpoint + 3 个回滚 checkpoint 中断注入、hash 三 pin、损坏 pointer
fail-closed 等 19 组）。删除会丢失安全覆盖；本轮包装为
`RuntimeInstallerChecksTest.kt`（@Test，pin `ok=true` 且 `count==19`），不改动
生产安装器一行。

## 真跑矩阵（AVD p3_e2e_api35，API 35，标准 debug 包 com.dshpocket）

| 类 | 结果 |
|---|---|
| RuntimeInstallerChecksTest | 1/1 GREEN（19 组设备侧全过，XML 为证） |
| KeychainStorageValidationTest | 5/5 GREEN（AES-256-GCM、内部存储 round-trip、allowBackup=false 等） |
| ScreenStaleFailClosedTest | 1 GREEN + 1 诚实 SKIPPED |

合计 8 tests，0 failures，1 skipped。日志：`P4-0.3-43-androidtest.log`、
`P4-0.3-43-androidtest-a11y-rerun.log`；XML：
`app/build/outputs/androidTest-results/connected/debug/TEST-p3_e2e_api35(AVD) - 15-_app-.xml`。

## SKIPPED 归因（不冒充通过）

`changedScreenRefusesThenResnapshotRecovers` 需要 a11y 服务绑定在 instrumentation
进程内；测试自带注释：emulator 上 `am instrument` 重启进程后系统不可靠重绑，
`assumeNotNull` 诚实跳过（"run on a device"）。已尝试 adb 启用服务并重跑，仍 skip，
与注释一致。该路径的真实服务证据沿用 P4-0.2 补充交付（dumpsys 绑定 + logcat +
instrumentation 记录）；本轮不伪造。

## 仍 BLOCKED

`LocalRuntimeBridgeValidationTest`（2 项）：需隔离包名 `com.dshoutpost.p1.*`
（`-PDSH_TEST_APPLICATION_ID` + `-PDSH_TEST_ENTRY_FILE`）、`-PDSH_RUNTIME_NATIVE_DIR/
ASSETS_DIR` 注入 libproot.so（#37）、外部 fixture `runtime.tar` 与 pinned assets。
本轮不解锁、不伪造。

## 备注

包装测试向 `getExternalFilesDir(null)` 写证据 json；headless emulator 上该目录
未创建（写入落在 instrumentation cwd，不可拉取）。**以 XML 的 ok/count pin 断言
为权威证据**，json 仅为冗余副本。
