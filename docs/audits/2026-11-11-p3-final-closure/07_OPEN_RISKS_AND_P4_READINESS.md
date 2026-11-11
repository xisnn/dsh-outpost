# 07 · 遗留风险与 P4 就绪度

## 1. 本轮四项收尾的关闭状态

| 项 | 状态 | 依据 |
|---|---|---|
| F2 超时+安全重试全链路 | **关闭** | 01；真实 Emulator，180s body 级超时、unknown、禁自动重发、复用原 ID、服务端幂等 |
| F2 附加：abort 双发归因 | **关闭（归因完成）** | 01 §2；okhttp 传输层透明重试，非 App 重发；服务端 requestId 幂等已验证 |
| D2 断线期间产生结果的历史补洞 | 见 02 | 真实 Host + 真实 Emulator |
| D-1 重复 key | **关闭** | 03；先红后绿 + 全量 + 远程 CI + Emulator A/B |
| D-3 注册表隔离 | **调查关闭，修复留待 P4** | 04；按本轮章程只交付结论/方案/测试设计 |

## 2. BUG-02 / BUG-03 是否可关闭

**可以。** 上一轮 A–F 真实 Emulator 验收 + 本轮 F2（超时/unknown/重试幂等）、D2（断线补洞）、D-1 回归中的 BUG-03 语义复验（conflicting-ID 拒绝、迟到回收、重复 call 去重、重连保留）+ 全量单测（fold/binding/unconfirmed/late-recovery/idem/retry 等）+ 远程 CI test job 成功。未发现新的语义回归。

## 3. 遗留风险（按优先级）

1. **D-3（上游缺陷，未修）**：隔离实例若不 pin `deviceFile`/`gatewayStateFile`，会读**并写**正式 `~/.dsh/mobile-gateway-devices.json*`（lastSeenAt/配对/改名/吊销均可触发写）；双实例共享 gatewayId 且内存快照全量覆盖 ⇒ 吊销失效、状态回滚。负向测试 S1/S7/S8 已复现。修复方案与测试设计见 04 §4。**P4 第一优先。**
2. **okhttp 透明重试（新确认，非缺陷但需文档化）**：连接级失败时原生栈会重放同一 body（同 rpcId、新 TCP 连接）。App 层无法禁止；防线只能是服务端 requestId 幂等（已验证）。建议在协议文档中明确「传输层可能重放，服务端必须幂等」，并在 P4 为真实 DSH 补一条连接级中断的幂等集成测试。
3. **P1 原生风险（沿用上一轮 07 §4，本轮未新增验证）**：
   - 息屏即停（`AgentService.kt:36-38`、`OutpostAccessibilityService.kt:105-108`）；
   - tap/scroll/key 无屏幕世代绑定（`PhoneBridge.kt:244`、`OutpostAccessibilityService.kt:168`）；
   - type 同包换屏残留盲写面（`:220-230,244`）；
   - 敏感词子串误报（`"pin"`⊂`"shipping"`，`:75-78,487-490`）；
   - `phone_open` 不校验 `before.sensitive`（`PhoneTools.kt:147-158`）。
   未验证/推测：`AgentService` 无运行时限、API35 dataSync 上限、`AgentModule.snapshot` 抢锁竞争。审批链未发现 fail-open。
4. **测试环境残留（需清理，非产品风险）**：隔离 DSH 本轮为 D2 绑定到局域网具体 IPv4 `192.168.193.223`（DSH 拒绝通配符绑定）；验收结束后应改回 127.0.0.1 并重启隔离实例。隔离 profile 的 `lanAdvertiseHost` 同步回退。正式实例不受影响。
5. **测试设施限制（已记录，不影响结论）**：uiautomator 在 UI 持续动画时拿不到 idle，dump 会失败/过期；本轮已改为「先删旧 xml + 重试 + 失败抛错」，运行中场景改用截图取证。

## 4. P4 就绪度建议

**建议进入 P4**，前置条件：
1. 先落 D-3 修复（导出 `resolveDeviceFile`，优先级 显式 > DSH_HOME > homedir；派生路径跟随），配 04 §4 的 RED/GREEN 测试；修复后把负向测试的转录断言换成真实导出函数断言。
2. P1 独立验收按上一轮 07 §5 执行（Emulator 专项 + 真机专项 + JVM/androidTest 门禁）。
3. 协议文档补「传输层重放 ⇒ 服务端幂等」条款与集成测试。
4. 清理本轮测试环境残留（LAN 绑定回退）。

**本轮不开始 P4、不合并 main、不打 Tag、不发 Release。**