# 04 · P1 设备控制 Emulator 验收结果

- 设备：`emulator-5554`（API 35，x86_64，google_apis），隔离包 `com.dshoutpost.p1.p3e2e` `0.18.3-p40`/`940001`
- 模型：本地确定性桩 `http://127.0.0.1:3990/v1`（经 `adb reverse`），**无收费云调用**
- 驱动：真实 RN UI（adb + uiautomator）+ 桩模型脚本化工具调用（`POST /__control`）
- 原始证据：`evidence/p4-0*.png`、`logs/logcat-p4-full.log`、`logs/stub-model-requests.jsonl`、
  `evidence/device-native-runtime-evidence.txt`

> 负向设备控制测试的目标界面为 Emulator 自带的 **Contacts（空通讯录，无真实用户数据）**，
> 不触碰任何真实个人数据。真机未使用。

---

## 1. 已实测（REAL_HOST_EMULATOR）

### 1.1 原生模块加载与工具注册 — PASS

桩模型收到的第一个请求携带完整工具清单（`logs/stub-model-requests.jsonl` seq1）：

```
workspace_read, workspace_write, workspace_list,
phone_screen, phone_apps, phone_open, phone_tap, phone_type, phone_scroll, phone_key, phone_handoff
```

证明 `OutpostAgent` 原生模块加载、`AgentRuntime.kt:249-257` 的手机工具注册条件
（API≥31 且无障碍已连接）在真实设备上满足。

### 1.2 phone_screen 执行与敏感屏 fail-closed — PASS

- 前台为 DSH 自身时调用 `phone_screen`：UI 出现
  「需要你接管手机：DSH Outpost itself」「模型已暂停，不会执行后续手机动作。」
  （`evidence/p4-05-handoff-dsh-itself.png`），执行记录「调用 phone_screen」。
  对应 `PhoneTools.kt:33-48` + `OAS:480-492`（`packageName == this.packageName` → sensitive）。
- 接管恢复后再次判定仍敏感，工具返回：

  ```
  DENIED: SENSITIVE_SCREEN: DSH Outpost itself; screen content is not sent to the model (handoff resumed)
  ```

  **屏幕内容未发送给模型** —— 敏感屏保护在真实设备上成立。
- `DshPhoneBridge` 日志：`snapshot display=0 background=false connected=true`。

### 1.3 错误目标不触发设备操作（拒绝路径）— PASS

`phone_tap` 被拒绝后，logcat **没有任何** `OK_GESTURE` / `tap display` 记录 ⇒ 未产生设备动作。
（允许+错误元素 id 的设备级 `STALE_ELEMENT` 断言见 §2 NOT_RUN。）

### 1.4 无障碍服务生命周期 — PASS

`DshPhoneA11y: service connected / service destroyed / service connected` 多次真实出现
（应用切换、重装、息屏唤醒期间），证明 `onServiceConnected/onDestroy` 真实工作。

---

## 2. 未能在设备级完成（NOT_RUN）及原因

| 项 | 原因 | 替代证据 |
|---|---|---|
| `phone_tap`/`phone_scroll`/`phone_key` 真实手势落在非敏感目标 | 接管恢复与切屏存在竞态：恢复瞬间前台仍是 DSH，守卫再次拦截；Emulator 软件渲染极慢，无法稳定抢在快照前切屏 | STATIC_REVIEW（手势实现 `OAS:167-185,368-392`） |
| 允许+错误元素 id → `STALE_ELEMENT` | 同上，允许后先被敏感屏守卫拦截，未走到元素解析 | STATIC_REVIEW（`OAS:169`） |
| `type` 同包换屏 | 需要先在非敏感屏建立编辑焦点，受同一竞态限制 | STATIC_REVIEW（§3.2） |
| `phone_open` 敏感页 | 需要敏感屏在前台再拉起他应用；本轮未构造 | STATIC_REVIEW（§3.3） |

**这些 NOT_RUN 不等于 PASS。** 设备控制的核心风险（屏幕世代）以静态证据确认存在，见 §3。

---

## 3. 静态确认的设计缺口（FAIL，未擅自修改）

### 3.1 tap/scroll/key 无屏幕世代校验

- `screenId` 全仓 10 处 grep **全为生产者，零消费者**：
  生产 `OAS:81,104,155`；序列化 `PhoneBridge.kt:244`；占位 `PhoneTools.kt:72`、`PhoneBridge.kt:165,177,190`。
- 动作签名只收 `(elementId, displayId)`，动作时**重取 root**：
  `OAS:168`（tap）、`OAS:369`（scroll）、`OAS:381`（key，全局动作）。
- 元素 id 是**位置性**的（`findElement` `OAS:422-443`，注释自认「ids only mean something within the
  traversal that produced them」）。同包换屏后 `n7` 会静默解析到**另一个节点**。
- `guard()` 的快照（`PhoneTools.kt:33-48`）**被丢弃**，其 `screenId` 从不带入动作。
- `9028d26` 只修了 `type`（`git show --stat` 仅 `OutpostAccessibilityService.kt`）。

**结论**：屏幕变化后仍可能按旧位置 id 执行 tap/scroll —— 缺口真实存在。

### 3.2 type 同包换屏盲写残留

`OAS:220-227` 仅在 `freshPackage != originalPackage` 时中止；同包换屏仍走
`findFocusedEditable ?: findFirstEditable ?: findElement`（`:228-230`）与 `pasteText`（`:244`），
且点击后**不复查 sensitive**（只复查 isPassword `:232`）。

### 3.3 phone_open 先拉起后拒绝

`PhoneTools.kt:153-158` 只查 `before.locked`，**不查 `before.sensitive`**；
敏感判定在拉起**之后**（`:163-190`）。即敏感屏在前时目标应用**仍会被启动**，拒绝是事后的。

### 3.4 敏感词子串误报

`OAS:75-78` 列表含 `"pin"`；`:487-490` 用 `value.contains(word)`。
已执行谓词验证：`shipping`、`Shipping address`、`Shopping cart`、`spinner`、`happiness` 均命中 `pin`。
方向为 **fail-closed 误接管**（不是 fail-open），但会造成正常电商/物流屏被误判敏感。

---

## 4. 结论

设备控制的**安全骨架**（敏感屏接管、内容不外发、拒绝无副作用、无障碍生命周期）在真实 Emulator 上 PASS；
**屏幕世代绑定 / type 同包盲写 / phone_open 事前校验 / 敏感词子串**四个缺口静态确认存在，
涉及设备控制安全边界，**按规则先交付证据与方案，不擅自修改**（见 09）。