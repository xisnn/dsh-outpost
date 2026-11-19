# 01 · #15 敏感词词边界匹配

## 缺陷

`OutpostAccessibilityService.sensitiveReason` 用 `value.contains(word)` 子串匹配
`SENSITIVE_KEYWORDS`，导致 `shipping` ⊃ `pin`、`pinned` ⊃ `pin` 误报敏感屏，
触发不必要的 handoff/拒绝（可用性缺陷，安全方向正确但误报）。

## 修复

提取纯函数 `agent-core/SensitiveContent.contentKeyword`（ScreenGuard 先例）：

- 拉丁词：左边界 `(?<![a-z0-9])` + 右边界 `(?![a-z0-9])`，右侧允许可选
  复数/复合后缀 `(?:s|es|code)?` —— `passwords`/`payments`/`pincode`/
  `verification codes` **仍然匹配**（不放宽 fail-closed 方向）
- CJK 词：保持子串（中文无词边界，`请输入密码` 必须命中）
- 混合文本：`输入pin码` 命中（边界字符为非 ASCII 字母）
- 无白名单、无关键词禁用；匹配只增加拒绝，不减少

OAS 委托该纯函数；关键词清单原样迁移，未增删。

## RED → GREEN

- RED（子串实现）：7 测试 2 失败 —— `shipping address`、`pinned message`/`spin`
  误命中 `pin`（`evidence/logs/15-RED-substring.log`）
- GREEN：7/7；全套 69/69（`15-GREEN-69.log`），最终 86/86（`JVM-86-green.log`）

## 门禁

`android-jvm-tests-ci-spec.mjs` EXPECTED 62→86（11 类），随本轮新增同步加强；
34 项门禁断言全过（含 release 依赖、签名边界、permissions 不放宽）。
