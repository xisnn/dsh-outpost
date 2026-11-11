# 03 · D-1 重复 key 根因与最小修复

- 状态：**PASS（已修复 + 真实 Emulator 回归）**
- 证据级别：根因 = STATIC_REVIEW + UNIT_TEST + REAL_HOST_EMULATOR 运行时日志；回归 = INJECTED_SERVER_EMULATOR（A/B 同场景对照）
- 修复 commit：`4a24e9a37c3b7f4b62163ae40c8d002221a1ddbc`

## 1. 根因（静态 + 运行时双重确认）

`ChatScreen` 的输入区 `<View style={styles.composerWrap}>`（[ChatScreen.tsx:1028](file:///E:/work/dsBot-opt/dsh-mobile/src/screens/ChatScreen.tsx#L1028)–1088）里有两个**兄弟**元素使用同一个 key：

- `approvalCard` = `<ApprovalBanner key={sessionId} …>`（修复前 :743），经 :1042 `{!butler ? approvalCard : null}` 渲染进该 View；
- `<ChatComposer key={sessionId} …>`（:1066）。

普通聊天（`!butler && !readOnly`）下两者同时挂载 ⇒ React `warnOnInvalidKey` 报
`Encountered two children with the same key, 'session-inject-0001'`。

运行时证据（修复前 logcat，`evidence/before-logcat.txt`、`logs/f2-logcat.log`）：同一 key 的 console.error 在一次会话里出现 45 次；LogBox call stack 含 `warnOnInvalidKey`（截图 `51-d1-logbox-callstack.png`）。该 toast 还会盖住输入框，干扰真实操作（本轮多次被迫 Dismiss）。

排除项：FlatList `keyExtractor` 用 `item.key`（:924），工具块 key 为 `${keyPrefix}-c${i}`（:662），`HostQueuePanel` key 带 `recoveryKey:` 前缀（:1058）——均不冲突；fold/历史+实时合并未产生重复 ID（BUG-03 单测与本轮注入场景均验证）。冲突只发生在上述兄弟对。

**是否 P3 BUG-03 引入：否。** `git blame` 显示该 `key={sessionId}` 来自 `26c255a`（v0.18.3，2026-11-06），且 `26c255a` 是 P3 BUG-03 起点 `a232ee0` 的祖先。

## 2. 修复前失败测试（RED）

新增 `dsh-mobile/tests/chat-screen-sibling-keys-spec.mjs`：用 vm + TypeScript 转译加载**真实 ChatScreen.tsx**，以受控 hook/store _stub 渲染真实组件树，按 React 的兄弟集合口径（同一 children 数组展平后）检查 key 冲突。组件模块降级为占位字符串（只校验 key），纯逻辑模块（core/design）与哈希依赖加载真实实现。

修复前运行：3 个用例全失败，报出的冲突与模拟器日志逐字一致：
`key=session-inject-0001, parent=View > KeyboardAvoidingView > View > Fragment > View, first=ApprovalBanner#…, second=ChatComposer#…`
（`evidence/d1-red-before-fix.log`，exit 1）。管家/只读模式不挂载该兄弟对，故不报冲突——与 React 行为一致。

## 3. 最小修复

仅改一行（+一行说明注释）：`ApprovalBanner` 的 key 改为 `` key={`approval:${sessionId}`} ``。
选择改 banner 而非 composer：composer 持有输入态，保持其 key 语义不变；且与 `HostQueuePanel` 的前缀式 key 惯例一致。
未动 fold/Store/通信状态机，未隐藏 LogBox、未过滤警告、未用随机/时间戳/下标 key。

修复后：spec 3/3 通过（`evidence/d1-green-after-fix.log`，exit 0）；已挂入 `npm run test:chain`（`test:chatKeys`）。

## 4. 全量回归

- `npm test`（含 typecheck 的完整 chain）：**exit 0**，`evidence/npm-test-after-d1.log`
- `npx tsc --noEmit`：**exit 0**，`evidence/typecheck-after-d1.log`
- 远程 CI：见 `05_REGRESSION_TEST_RESULTS.md`

## 5. 真实 Emulator A/B 回归（同场景、同脚本）

脚本 `scripts/d1-regression.mjs`：注入 3 个 tool/call → 2 个 tool/result（留 1 个未确认）→ turn/end → 迟到 result → **conflicting-ID result**（toolCallId 与 source.callId 不一致）→ kill WS 重连 → 重复 tool/call → 终态。分别在修复前/后各跑一遍。

| 指标 | 修复前 | 修复后 |
|---|---|---|
| duplicate-key console.error | **13** | **0** |
| 其它 JS error | 0 | 0 |
| 六个步骤的 UI dump 差异 | — | **仅少掉 3 行 LogBox toast ×6 步；0 行新增** |

`evidence/d1-ab-ui-diff.txt`：18 行删除、0 行新增，全部是警告 toast 本身。工具卡数量、文案、WorkGroup 摘要（`执行失败 · 已执行 2 步 · 1 步结果未确认` → `已执行 3 步`）、待发送气泡、重连后状态**逐字不变**。

BUG-03 语义在修复后仍然成立：conflicting-ID result 被拒绝绑定（a.txt 保持「完成」，未被覆写、未新增卡片）；迟到 result 正常回收；重复 tool/call 不产生第二张卡；WS kill 后自动重连且状态保留。

截图：`evidence/before-0*.png` / `after-0*.png`；logcat：`evidence/before-logcat.txt` / `after-logcat.txt`。

## 6. 结论

根因明确、先红后绿、最小改动、全量与远程回归通过、真实 Emulator 上警告消失且渲染零变化。D-1 关闭。