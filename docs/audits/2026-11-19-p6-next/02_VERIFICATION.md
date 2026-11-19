# 02 · P6-next 验证与诚实 BLOCKED 清单（候选 1+3）

## 验证矩阵

| 验证 | 结果 | 证据 |
|---|---|---|
| JVM 契约 RED（测试先写，对象未实现） | 编译失败 unresolved 留证 | P6-next-RED.log |
| JVM 契约 GREEN（8 类 83 @Test） | **83/83，0 失败** | P6-next-GREEN.log + XML |
| Android 接线编译 `:app:compileDebugKotlin` | BUILD SUCCESSFUL | P6-next-wiring-compile.log |
| CI gate spec（八类/83 pin，同提交强化） | 35/0 | 本轮提交 e95dc89 |
| `tsc --noEmit` | 绿 | 本轮跑 |
| 本地 Node 24 全量链（123 条） | **123/123**（1166.4s） | P6-next-full-chain.log |
| CI Node 20 run 44597887452 | **全 job 绿**（test/jvm/desktop/build-test；release 仅 tag skipped） | P6-next-ci.log |

## 诚实 BLOCKED / 未验证（不得宣称已验收）

1. **自定义输入 fallback 的设备验收**：需隔离靶 App（自绘输入面 / WebView
   contenteditable）与真机；本轮仅 JVM 契约 + 编译级接线，**未用 Mock 冒充设备验收**。
   解锁：隔离靶 App fixture + 模拟器/真机授权。
2. **审批节点绑定端到端**：preExecute veto 已接线并编译验证，但真实服务驱动
   （run→审批→副屏丢失恢复→allow）受 emulator instrumentation 进程 a11y 重绑
   限制（P4-0.3 02 已记录的已知 skip）；待真机或隔离包完整流程验收。
3. **候选 2**（phone_key home/recents + 空屏三态）：设计-only，未批准未实施。
4. 真机门槛（手势/息屏/OEM 后台/API36 FGS）继承 `07_MERGE_PREP.md` §2（P4-0.3 轮）。

## 治理

- 敏感改动仅限第二方批准的 1+3 范围；未合并 main、未建 Tag、未发布。
- 不变量逐条遵守（01）：只紧不松、拒绝-only、不自动重批、剪贴板卫生、跨窗 abort。
- 混版 stop-the-world 规程继承（仲裁本轮未改，但部署升级仍按 07 §4）。

## 下一步

候选 2 批准 → 实施；隔离靶 App + 真机授权 → 设备验收闭环 → P1 验收 → FF main。
