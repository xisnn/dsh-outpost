/**
 * 用「纯 Node」跑测试的引导文件（不依赖 tsx / esbuild）。
 *
 * ## 为什么需要
 *
 * 项目的标准命令是 `npm test`（走 tsx）。tsx 用 esbuild 做类型剥离，
 * 而 esbuild 启动时会 **spawn 一个子进程**。在受限沙箱 / 某些企业环境里
 * `spawn` 会被拒绝（EPERM），表现为：
 *
 *   TransformError: spawn EPERM
 *
 * 这时整套测试一条都跑不了 —— 不是测试坏了，是工具链起不来。
 *
 * Node 22.6+ 自带 TypeScript 类型剥离，可以绕开 esbuild：
 *
 *   node --experimental-transform-types \
 *     --import ./tests/support/node-ts-bootstrap.mjs \
 *     tests/credential-migration-spec.mjs
 *
 * ## 这个文件补两个洞
 *
 * 1. **目录 import / 无扩展名 import**
 *    产品代码写 `from './fold'`（目录）和 `from './secureStore'`（无扩展名）。
 *    tsx 会自动解析，Node 的 ESM 解析器不会 —— 直接报
 *    `ERR_UNSUPPORTED_DIR_IMPORT`。这里用 resolve hook 补上扩展名。
 *
 * 2. **`require` 不存在**
 *    Node 把 `.ts` 当 ESM 跑时没有 `require`，而 `secureStore.ts` 里
 *    延迟加载 Keychain 用的是 `require('react-native-keychain')`
 *    （见那里的注释：不能静态 import，会拉进 RN 的 Flow 代码）。
 *    这里在全局挂一个 `require`，让那条路径照常工作。
 *
 * ⚠️ 这只是**测试引导**，不改变产品代码的任何行为。
 *    真机上 Metro 打包时 `require` 一直都在。
 */

import { createRequire, register } from 'node:module';

// ① 扩展名 / 目录解析
register('./ts-resolve.mjs', import.meta.url);

// ② 让「bare require」在 ESM 里可用
//
// ESM 模块里 `require` 这个标识符会一路查到全局作用域，
// 所以在 globalThis 上挂一个就够。
if (typeof globalThis.require !== 'function') {
  globalThis.require = createRequire(import.meta.url);
}
