/**
 * Node 原生 TS 支持的 import 解析补丁。
 *
 * ## 为什么需要
 *
 * 产品代码写的是 tsconfig `moduleResolution: bundler` 风格的 import：
 *
 *   from './fold'          ← 目录（解析到 ./fold/index.ts）
 *   from './secureStore'   ← 无扩展名（解析到 ./secureStore.ts）
 *
 * Metro / tsx 会自动处理这两种，Node 的 ESM 解析器不会 ——
 * 直接报 `ERR_UNSUPPORTED_DIR_IMPORT` / `ERR_MODULE_NOT_FOUND`。
 *
 * 这里补上「按扩展名列表逐个试」的逻辑，让
 * `node --experimental-transform-types` 能跑产品代码。
 *
 * 只在相对路径、且原 specifier 没有扩展名时介入，
 * 不碰包名和 `node:` 内置模块。
 */

import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/** 依次尝试的扩展名（目录 index 也覆盖） */
const EXT = [
  '.ts',
  '.tsx',
  '.mjs',
  '.js',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
];

export async function resolve(specifier, context, nextResolve) {
  const looksRelative = specifier.startsWith('./') || specifier.startsWith('../');
  const hasExt = /\.[cm]?[jt]sx?$/.test(specifier);
  if (looksRelative && !hasExt && context.parentURL) {
    const base = path.dirname(fileURLToPath(context.parentURL));
    for (const ext of EXT) {
      const candidate = path.join(base, specifier + ext);
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
