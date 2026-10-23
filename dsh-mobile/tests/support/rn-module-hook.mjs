/**
 * ESM loader hook：把 RN 原生模块重定向到测试替身。
 *
 * ## 为什么不能用 Module._resolveFilename
 *
 * `DshConnection.readCookieFromJar()` 里写的是：
 *
 *   const mod = await import('@react-native-cookies/cookies');
 *
 * 这是**动态 ESM import**，不走 CJS 的 require 解析链，
 * 所以 `Module._resolveFilename` hook 拦不到（实测确认过）。
 *
 * 必须用 Node 官方的 ESM loader hooks（`module.register()`）。
 *
 * ## 用法
 *
 * 在测试文件最顶部：
 *   import { register } from 'node:module';
 *   register('./support/rn-module-hook.mjs', import.meta.url);
 *
 * 注意：必须在 import 任何产品代码**之前**注册。
 */

/** 模块名 → 替身文件（相对本文件） */
const MAPPING = {
  '@react-native-async-storage/async-storage': './_async-storage-shim.cjs',
  '@react-native-cookies/cookies': './_cookie-manager-shim.cjs',
};

/**
 * TS 项目里 import 不带扩展名（`from './net-security'`），
 * 但 Node 的 ESM 解析要求带扩展名。这里补上。
 *
 * 只对「看起来是相对路径、没扩展名」的说明符生效，
 * 避免把 `node:fs` 或包名也改写掉。
 */
async function resolveTsExtension(specifier, context, nextResolve) {
  const looksRelative = specifier.startsWith('./') || specifier.startsWith('../');
  const hasExt = /\.[cm]?[jt]sx?$/.test(specifier);
  if (!looksRelative || hasExt) return null;

  for (const ext of ['.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx']) {
    try {
      return await nextResolve(specifier + ext, context);
    } catch {
      // 试下一个
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const target = MAPPING[specifier];
  if (target) {
    return {
      url: new URL(target, import.meta.url).href,
      shortCircuit: true,
      format: 'commonjs',
    };
  }

  const withExt = await resolveTsExtension(specifier, context, nextResolve);
  if (withExt) return withExt;

  return nextResolve(specifier, context);
}
