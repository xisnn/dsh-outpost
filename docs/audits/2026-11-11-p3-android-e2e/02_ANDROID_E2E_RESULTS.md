# 02 Android E2E 结果总表

> 环境：Emulator `emulator-5584`（API35/x86_64，AVD `p3_e2e_api35`）+ 真实 RN 应用 `com.dshoutpost.p1.p3e2e`（versionCode 930001）。
> 服务端：A/E = 隔离**真实** DSH（3995/3981，本地模型桩 3990，无收费调用）；B/C/D/F = 注入服务端 3996（协议形状取自真实 DSH 探针）。
> 关联 Git：基线 `a519299`（分支 opt/p3-bug03）；精确 HEAD 见 `evidence/GIT-HEAD.txt`。
> 判定：PASS=真实执行且断言通过；FAIL=真实执行有明确失败；BLOCKED=环境/依赖无法执行；NOT_RUN=未执行。

## 阶段二：构建 / 安装 / 启动 / 配对

| 项 | 结果 | 证据 |
|---|---|---|
| Debug APK 构建（隔离包名、x86_64） | PASS | `logs/gradle-assembleDebug-attempt2.log` BUILD SUCCESSFUL |
| 安装到 Emulator | PASS | adb install Success；dumpsys versionCode=930001 |
| 启动 / 导航 / 崩溃 | PASS：0 FATAL，Splash→Main，首页/会话/聊天导航正常 | `logs/logcat-launch.log`、`evidence/01,04,05,06` |
| 权限（通知弹窗） | PASS：真实弹窗并允许 | `evidence/03-paired.png` 后续 |
| 隔离 DSH 启动 + 真实配对 | PASS | `logs/dsh-isolated.log`、`evidence/04-home.png` |
| HTTP RPC / WebSocket / 历史加载 | PASS：session/list、follow 快照、分页真实返回 | `logs/probe-events-*.jsonl`、04/05 |

## 阶段三：P3 核心场景

| 场景 | 结果 | 关键断言摘要 | 日志 / 截图 |
|---|---|---|---|
| A 正常工具调用 | **PASS** | 单卡、名/参正确、result 绑定、输出完整、完成态、展开折叠、无重复/永久 pending | probe-events-run-*；06/07 |
| B 缺失工具结果 | **PASS** | 「结果未确认」、无虚假成功、与失败可区分、无重复卡、不自动重执行、WorkGroup「2 步结果未确认」 | inject-server.jsonl；18/19/20 |
| C 迟到工具结果 | **PASS** | 初始未确认→按 ID 恢复完成/失败、输出替换占位、不回 pending、无重复卡 | 21/22/23 |
| D 断线重连 | **PASS** | 自动重连（follow 1→2）、回填不重复、状态恢复、无跨绑、非幂等不自动重发、UI=权威记录 | 24/25；jsonl |
| E WorkGroup UI | **PASS** | 单工具直显/多工具折叠、数量、三态、汇总、展开收起、代码复制、复制全文入口、无白屏 | 08/09/12/13/14/15 |
| F BUG-02 超时恢复 | **PASS** | 180s 结束、请求超时归类、unknown、不自动重发、安全重试复用原 ID、UI 恢复 | 26/27/28/31；jsonl |

子项未验证（不宣称通过，详见各分报告）：
- D：断开期间独立可读横幅（重连过快未捕获）→ 未验证。
- E：剪贴板内容级回读 → 未验证；超长输出全屏查看器滚动 → NOT_RUN（本轮无超长输出）。
- B/C：D2 冲突 ID / D4 无 ID 的设备级负向注入 → NOT_RUN(on-device)，由协议 spec 守卫。

## 阶段四：P1 原生冒烟（非 P1 正式验收）

| 项 | 结果 | 证据 |
|---|---|---|
| 启动 / 原生模块加载 | PASS | logcat 无 FATAL；MainApplication.kt:24-25 注册 |
| 权限 | PASS | dumpsys granted；通知弹窗 |
| 无障碍原生服务连接 | PASS | `I/DshPhoneA11y: service connected` |
| 后台恢复 | PASS | 前后台切换状态保留 |
| 前台服务运行态 / 悬浮审批卡 UI | NOT_RUN | 需先启用手机 agent |
| 本地 DSH runtime 全链路 | BLOCKED（Emulator） | 无 bundled runtime → 入口隐藏；须真机 |
| Shizuku 后台虚拟屏 | BLOCKED / 未验证 | 依赖 ROM/Shizuku |

## 缺陷

无 P3 引入的阻断性缺陷。既有/环境/设施问题见 08（D-1 重复 key、D-2 TLS、D-3 注册表隔离、D-4 长按 UX、D-5 列表刷新、D-6 设施）。

## 结论

P3 六个核心场景在真实 Emulator 上全部 PASS；BUG-02 与 BUG-03 均通过真实 Emulator 验收。
P1 仍须独立验收（07）。未验证子项已如实标注，不以构建/单测/Mock 冒充。