# 04 · CI 维护（Node 20 deprecation / runner 迁移）

- actions 升级 v4→v5：checkout、setup-node、setup-java、cache、upload-artifact、
  download-artifact（android.yml 全 job）。消除 Node 20 runner deprecation 警告源。
- 签名门禁、版本水位门禁、release 路径**逐字未动**；release job 仍仅 tag v* 触发。
- ubuntu-latest → Ubuntu 26 迁移警告**已实际兑现**：首轮 CI（run 44541006869）
  test job 的 `release-signing-gates-spec` 真实 gradlew dry-run 挂在
  「Unsupported class file major version 69」（runner 默认 JDK 25，Groovy 不认）。
  归因：环境性，非断言问题；本地 JDK 21 绿。处置：test job 增加
  `actions/setup-java@v5 temurin 21`（与项目工具链/本地 JAVA_HOME 一致），
  断言逐字未动。复跑编号见 00。
- androidTest 仍不在 CI（#43 的 CI job 选项未选）：本轮选择「孤儿转活 + 本地真跑」，
  CI emulator job 留待第二方拍板（runner 成本/稳定性权衡）。
