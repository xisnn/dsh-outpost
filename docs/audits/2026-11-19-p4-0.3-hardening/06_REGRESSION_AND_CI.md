# 06 · 回归与 CI（双跑纪律）

## 本地（Node 24 / Windows）

- JS 全链 `npm test`：**123/123 通过**，0 失败，1270s（含 tsc；链长 118→123）
  —— `evidence/logs/chain-123-green.log`
- JVM `:agent-core:test`：**86/86**（11 类）—— `evidence/logs/JVM-86-green.log`
- androidTest（AVD p3_e2e_api35，API35）：**10/12**；2 FAIL = #37 BLOCKED
  —— `evidence/logs/androidtest-10of12.log`（首轮 8/10 见 androidtest-8of10.log）
- `:app:compileDebugKotlin` 通过（onTimeout 签名修正后）

## CI run 1（44519570025，Node 20）——环境性失败，已归因

- 结果：122/123，唯一失败 `node tests/release-signing-gates-spec.mjs`
- 根因：ubuntu-latest runner 迁移（2026-10，审计 09 §5 已预警）把默认 JDK
  升到 25（class file major version 69），Gradle 8.14.3 的 Groovy 在配置阶段
  即 `BUG! ... Unsupported class file major version 69`。该 spec 的 gradle
  冒烟（:app:tasks / assembleDebug）依赖 runner 默认 JDK + 预装 Android SDK
- 归因结论：**环境性失败，非代码回归**（本地同链全绿；失败点在 gradle 启动
  阶段，与本轮 Kotlin/JS 改动无关）
- 处置：修复环境而非削弱断言 —— `bc6e6c8` 给 test job 增加
  `actions/setup-java@v4 temurin 21`（与 jvm-tests 同版本）；预装 SDK 假设
  不变；门禁 spec 对 test job 无冲突断言（仅 jvm-tests 被断言含 setup-java）

## CI run 2（44522867136，Node 20，含 bc6e6c8）

- 结果：**success** —— test 123/123（1130s）、jvm-tests 86/86 BUILD SUCCESSFUL、
  desktop / build-test success、release skipped（无 tag，符合约定）
- 证据：`evidence/logs/ci-run2-summary.txt`（链汇总 123/123、门禁「@Test 总数为 86」
  OK、jvm-tests BUILD SUCCESSFUL）
- **双绿达成**：本地 Node24 123/123 + CI Node20 123/123；JVM 本地 86/86 + CI 86/86

## 纪律

- 本地绿 ≠ CI 绿：双跑均须绿才宣称回归通过
- CI 环境性失败必须归因到具体环境差异并修复环境，不得以本地绿代替、
  不得削弱断言或静默 skip
