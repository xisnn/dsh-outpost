# 05 WorkGroup UI 验收（真实 Emulator）

> 数据来自隔离真实 DSH 的多工具轮（3 工具：read 成功 / read 失败 FS_NOT_FOUND / glob 成功），
> 以及注入服务端的缺失/迟到结果轮。保持现有 UI 风格，未做视觉重设计。

| 断言 | 结果 | 证据 |
|---|---|---|
| 单工具直接展示 | PASS：单工具轮不折叠为组，直接一张 ToolCard | `evidence/06-scenarioA-chat.png` |
| 多工具 WorkGroup 折叠展示 | PASS：3 工具折叠为单张「执行过程」卡 | `evidence/08-workgroup-collapsed.png` |
| 工具数量正确 | PASS：展开后恰 3 张卡；缺失轮恰 2 张 | `evidence/09-workgroup-expanded.png`、dump 计数 |
| 成功/失败/结果未确认三态 | PASS：绿「完成」/红「失败」/「结果未确认」并存且正确 | 09、19 |
| 汇总文案正确 | PASS：「执行失败 · 已执行 3 步 · 耗时 2 秒」；缺失轮「2 步结果未确认」不把缺失算已执行 | 08、18 |
| 展开/收起 | PASS：组与单卡均可展开收起 | 08↔09、06↔07 |
| 长工具输出可滚动 | PASS（有限）：9 行输出在卡内完整渲染；超长输出走「查看完整」全屏查看器（设计），本轮未产生超长输出 → 全屏查看器滚动标 NOT_RUN | 07、20 |
| 代码块复制按钮 | PASS：markdown 代码块带「复制代码」按钮且可点击 | `evidence/12-markdown-code.png`、13 |
| 最终回答「复制全文」 | PASS（入口与面板）：长按 markdown 段落弹「复制全文 / 导出为 Markdown / 取消」面板，可点击 | `evidence/14-longpress-sheet.png`、15 |
| 剪贴板内容回读 | **未验证**：adb 读剪贴板被系统限制、粘贴回读未成功 surfaced；不宣称内容级通过 | 16 |
| 无闪烁/卡死/白屏 | PASS：全程无白屏、无 ANR、无 FATAL | logcat、各截图 |

## 观察（非阻断）

1. **纯单段落回答的长按被 OS 文本选择接管**：对仅一个纯文本段落的最终回答长按，出现系统 Copy/Share/Select all 工具条而非应用「复制全文」面板（`evidence/10-copy-sheet.png`）；含 markdown 结构的答案则正常弹应用面板（14）。与 `MarkdownView.tsx:78-80`「不要加 selectable」的意图存在出入，建议作为 UX 跟进项（见 08）。
2. 卡片上无常驻复制按钮属设计（`ToolCard.tsx:10-12`），唯一复制入口在全屏查看器；本轮输出未超长故未触发该入口。

## 结论

WorkGroup UI 在真实 Emulator 上功能正常：折叠/数量/三态/汇总/展开收起/代码复制/复制全文入口均通过；
剪贴板内容级回读与超长输出全屏查看器滚动标 NOT_RUN/未验证，不夸大。