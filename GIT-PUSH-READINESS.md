# GIT-PUSH-READINESS

> 生成时间：2026-10-27
> 状态：**本地提交已完成，等待推送授权**
> 本轮未执行 `git push` / 未创建 Tag / 未创建 Release / 未发布任何 APK。

---

## 结论

# ✅ 可以安全推送到 GitHub

6 个本地提交，45 个文件，工作区干净，无凭据/二进制污染。

**推送目标**：分支 `main` → `origin` (`https://github.com/xisnn/dsh-outpost.git`)

---

## 1. 仓库状态

| 项 | 值 |
|---|---|
| 分支 | `main` |
| 远程 | `origin` `https://github.com/xisnn/dsh-outpost.git` |
| HEAD | 见 `git log --oneline -1`（本文件随该提交一起入库） |
| 领先 origin/main | **6 个提交** |
| 工作区 | **clean**（无未跟踪、无未提交） |
| 推送前基线 | `f978832` |

---

## 2. 提交清单

| # | Hash | 类型 | 内容 | 规模 |
|---|---|---|---|---|
| 1 | `033dd7b` | security | 网关认证补丁、连接校验、更新完整性、迁移提示 | 17 文件 +1271/−19 |
| 2 | `687560d` | fix(desktop) | 打包脚本缺失、退出清理、token 移除 | 4 文件 +320/−40 |
| 3 | `d2c4580` | build | 签名门禁、9 个回归 spec、tsx 兼容修复 | 16 文件 +2326/−14 |
| 4 | `fc7377b` | ci | 签名验证工作流 + debug 证书黑名单 | 2 文件 +765/−2 |
| 5 | `ba3c2ed` | docs | 分析/修复/验收报告 | 5 文件 +3262 |
| 6 | *（本提交）* | docs | 本推送就绪说明 | 1 文件 +197 |

**总计**：45 文件，+8140 / −75

### 各提交要点

**① `033dd7b` security**
- `patches/mobile-gateway-mgmt-auth/`：把 `/mgw/*` 交给 DSH 会话认证
- `start-dsh-web.ps1`：启动期补丁完整性门禁（fail-closed）
- `net-security.ts` / `transport` / `approvalGateway` / `fileUrl`：`assertSecureUrl`
- `update-integrity.ts` + `updater.ts`：SHA-256 校验 + `SignatureMismatchError`
- `installable.ts`：拒绝在 App 内安装聊天附件 APK
- `transport/index.ts`：WebSocket 断线快速失败

**② `687560d` fix(desktop)**
- `electron-builder.yml`：补上 `start-tunnel.ps1`
- `tunnel-service.mjs`：`findScript()` 多路径探测
- `main.js`：退出前停隧道、`/mgw/devices` 带会话凭据
- `/tunnel/status` 不再返回明文 token

**③ `d2c4580` build**
- `build.gradle`：签名检查移到 `taskGraph.whenReady`（修复配置期回归）
- 9 个新 spec + `runtime-compat-spec` 守卫补齐动态 `import()`
- 三个 spec 改用 `tsx`（Node 20 CI 兼容）

**④ `fc7377b` ci**
- `signing-verify.yml`：仅 `workflow_dispatch`、`contents: read`
- v2/v3 按 `: true` 判定、总体判定覆盖全部门禁、公开仓库拒绝上传 APK
- `android.yml`：Gate 4 增加 debug 证书黑名单

**⑤ `ba3c2ed` docs**
- 4 份根目录报告 + `docs/P1-1-SIGNING-VERIFICATION.md`

---

## 3. 安全检查结果

| 检查 | 结果 |
|---|---|
| 私钥块（`BEGIN ... PRIVATE KEY`） | ✅ 无 |
| GitHub / AWS / Slack 令牌 | ✅ 无 |
| keystore 密码 / key 密码字面量 | ✅ 无 |
| 大块 Base64（>300 字符） | ✅ 无 |
| `.keystore/.jks/.p12/.pfx/.pem/.key` | ✅ 未新增 |
| `.apk/.aab/.exe/.dll/.so/.zip` | ✅ 未新增 |
| `node_modules/` `release/` `build/` `dist/` | ✅ 未新增 |
| `.env` / `secrets.*` | ✅ 无 |
| 提交历史（5 commits diff 全量扫描） | ✅ 干净 |

### 两点说明（不构成风险）

1. **`dsh-mobile/android/app/debug.keystore`** 本来就在仓库里（历史既有），
   **本次 5 个提交未修改也未新增它**。它只用于 debug 构建，
   `.gitignore:44` 显式放行；正式签名用 GitHub Secrets，不进仓库。

2. **`integration-product.mjs` 中的 `stale-token-that-will-401`** 是测试夹具：
   用于验证「失效 token 的重连会被服务端拒绝」，25 字符、15 个不同字符，
   非随机生成的凭据。

---

## 4. 提交完整性验证

| 检查 | 结果 |
|---|---|
| `.github/workflows/signing-verify.yml` 已入库 | ✅ `git ls-tree HEAD` 可见 |
| 该工作流触发方式 | ✅ 仅 `workflow_dispatch` |
| 该工作流权限 | ✅ `contents: read`（无写权限） |
| 工作流内 `git tag` / `action-gh-release` / `GITHUB_TOKEN` | ✅ 均无 |
| `android.yml` 的 `contents: write` | ✅ 仅存在于原有的 tag 触发 release job（未改动其权限模型） |
| 提交后单元测试 | ✅ 996 通过 / 0 失败 |
| 提交后 `tsc --noEmit` | ✅ 通过 |

> 注：`scripts/verify-sums-integration.mjs` 中出现一处 `--experimental-strip-types` 字样，
> 是**注释里解释为什么不用它**，非实际调用。

---

## 5. 推送后会发生什么

推送 `main` 后：

| 事件 | 是否触发 |
|---|---|
| `android.yml` | ❌ 不触发（它只监听 `v*` tag 和手动触发） |
| `signing-verify.yml` | ❌ 不自动触发（仅手动 `workflow_dispatch`） |
| 任何 Release / Tag | ❌ 不会产生 |

**推送本身不会发布任何东西。** 签名验证需要在推送后**手动**运行。

---

## 6. 后续操作（需你批准）

### 6.1 推送

```powershell
cd E:\work\dsBot

# 推送前最后确认
git status --porcelain          # 应为空
git log --oneline origin/main..HEAD   # 应为 6 条

# 推送
git push origin main
```

### 6.2 手动运行签名验证

```powershell
# 方式 A：网页
#   GitHub -> Actions -> 左侧 "Signing Verification (no publish)"
#   -> Run workflow -> 分支选 main -> verify_debug_too 勾选 -> Run

# 方式 B：CLI
gh workflow run signing-verify.yml --ref main -f verify_debug_too=true
gh run watch
```

预计 20–30 分钟。

### 6.3 应检查的结果

1. **Summary 总体结论** = `✅ 全部必需门禁通过`
2. 10 行门禁表**全部 PASS**（debug 行若未启用显示「未启用（可选）」）
3. **证书 SHA-256**：不等于 `fac61745…`（公开 debug 证书），
   且等于你配置的 `EXPECTED_CERT_SHA256`
4. **证书 DN**：不是 `CN=Android Debug`
5. 产物区：`signing-verification-evidence`（1 天）
6. **Releases / Tags 页面：无新增**（这是预期）
7. 若仓库是公开的：**不应**出现 `NOT-FOR-RELEASE-signing-verify-apk`

---

## 7. 仍未关闭的事项（不影响推送）

| 级别 | 项 |
|---|---|
| 待 CI | 正式签名配置尚未经 GitHub Actions 验证 |
| 待真机 | Android 真机验收 12 项（见 `DSH-OUTPOST-FINAL-RELEASE-ACCEPTANCE.md` §9） |
| 已知限制 | P0-1 只做到断线快速失败，**无自动重连/会话恢复** |
| 待产品决策 | 存量 debug 签名用户需卸载重装的通知方式 |

这些是**发布**前的阻断项，不是**推送**的阻断项。

---

## 8. 本轮未做的事

- ❌ 未 `git push`
- ❌ 未创建 Tag
- ❌ 未创建 / 修改 GitHub Release
- ❌ 未读取或上传任何本地 keystore
- ❌ 未修改 GitHub Secrets
- ❌ 未发布任何 APK

**等待推送授权。**
