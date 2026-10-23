# 运行环境兼容性

记录「本地跑得过、CI 挂掉」这类问题的成因、排查方法、以及怎么防。

---

## 为什么会遇到

CI 用 **Node 20**，本地开发常用 **Node 24**。这两者有几个致命差异：

| 能力 | Node 20 | Node 22 | Node 24 |
|---|---|---|---|
| 全局 `WebSocket` | ❌ | ✅（22+） | ✅ |
| 直接 `import './x.ts'` | ❌ | ⚠️ 需 `--experimental-strip-types` | ✅ 默认 |
| `node --require` | ✅ | ✅ | ✅ |

**这两项差异都真实踩过**，各导致一次 CI 构建失败。

---

## 踩过的两次

### 第一次：`WebSocket is not defined`

```
build/10_Integration tests
  FAIL  WS：带 cookie 能建连 — WebSocket is not defined
  ...（5 项全红）
```

**根因**：集成测试用全局 `WebSocket`，Node 20 没有（21+ 才有）。

**修复**：`tests/support/ws-compat.mjs` —— 用 `ws` 库实现同接口的构造器，
三个测试文件全部接上。

**为什么一律用兼容层而不是「有原生就用原生」**：
Node 21+ 的原生 WebSocket **不支持第三个参数传 header**（那是 RN 扩展），
而审批网关必须带 `X-DSH-Device-ID`。所以统一换成 `ws` 版。

### 第二次：`ERR_UNKNOWN_FILE_EXTENSION: .ts`

```
build/10_Integration tests
> node tests/integration-product.mjs
TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"
  for .../src/core/transport/index.ts
```

**根因**：`integration-product.mjs` 要 `import` 真实的 `.ts` 源码，
但 package.json 里写的是 `node tests/integration-product.mjs`。

Node 24 原生支持 `.ts`（类型剥离），Node 20 不支持。

**修复**：改用 `tsx` 启动（项目已有依赖，用 esbuild 转译，不依赖 Node 原生能力）。

---

## 怎么在本地发现这类问题

### 方法一：模拟（快，但只覆盖已知差异）

```bash
npm run test:node20
```

原理：`tests/support/node20-sim.cjs` 删掉 `globalThis.WebSocket`，
再跑全部集成测试。

**局限**：只能模拟「已知的」差异。`.ts` 那种问题它发现不了
（Node 24 的转译能力删不掉）。

### 方法二：真下载 Node 20 跑（可靠）

```powershell
# 一次性准备
$dir = "$env:TEMP\node20"
Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.20.2/node-v20.20.2-win-x64.zip' -OutFile "$dir\n.zip"
Expand-Archive "$dir\n.zip" -DestinationPath $dir -Force
$n20 = "$dir\node-v20.20.2-win-x64\node.exe"
$tsx = "node_modules\tsx\dist\cli.mjs"

# 跑集成测试
& $n20 tests/integration-transport.mjs
& $n20 tests/integration-gateway.mjs
& $n20 tests/integration-long-session.mjs
& $n20 $tsx tests/integration-product.mjs

# 跑单元测试（需要 tsx 转译 .ts）
& $n20 $tsx tests/fold-spec.mjs
```

**这是最可靠的方式**，和 CI 环境完全一致。

---

## 静态守卫（不用装 Node 20 也能发现问题）

`tests/runtime-compat-spec.mjs` 会检查：

| 检查 | 防止 |
|---|---|
| 用 `new WebSocket` 的测试都装了兼容层 | 第一次的问题 |
| 没有裸用 Node 21+ 才有的全局 API | 同类问题 |
| **`import` `.ts` 的测试必须用 `tsx` 启动** | 第二次的问题 |
| `engines.node` 和 CI 的 `node-version` 不矛盾 | 配置漂移 |
| 兼容层的三种调用写法都能用 | 兼容层自身的 bug |

最后一项特别重要：它让「本地不装 Node 20 也能提前发现」成为可能。

---

## 写测试时的规矩

### 1. 不要假设全局 API 存在

```js
// ❌ 直接假设
const ws = new WebSocket(url);

// ✅ 用兼容层
import { ensureWebSocket } from './support/ws-compat.mjs';
ensureWebSocket();
const ws = new WebSocket(url);
```

### 2. import `.ts` 的测试必须用 tsx 启动

```json
{
  "test:foo": "tsx tests/foo-spec.mjs"     // ✅ 有 .ts import
  "test:bar": "node tests/bar-spec.mjs"    // ✅ 纯 .mjs，不 import .ts
}
```

判据：打开测试文件，看有没有 `from '../src/...*.ts'`。

### 3. 新增测试后跑一遍守卫

```bash
npm run test:runtime
```

它会扫 package.json 里所有脚本，发现启动方式不对就失败。

---

## CI 里的两步

```yaml
# 正常环境
- name: Integration tests (fake DSH server)
  run: npm run test:integration

# 模拟 Node 20 语义（删掉全局 WebSocket）
- name: Integration tests under Node 20 semantics
  run: npm run test:node20
```

第一步用的是 CI 的真实 Node（就是 20），第二步额外验证兼容层在
「没有全局 WebSocket」时也能工作。

---

## 历史

| 版本 | 问题 | 修复 |
|---|---|---|
| v0.15.0 | `WebSocket is not defined`（Node 20 没有全局 WebSocket） | `ws-compat.mjs` |
| v0.15.1 | 修了第一个但引入 `ERR_UNKNOWN_FILE_EXTENSION`（用 node 跑 import .ts 的测试） | 改用 `tsx` |
