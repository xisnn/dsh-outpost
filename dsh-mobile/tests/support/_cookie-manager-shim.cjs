// @react-native-cookies/cookies 的 CJS shim。
// 真正的实现在 cookie-fetch.mjs 里共享同一个 jar，这里只做桥接。
const path = require('node:path');

// 共享 jar：从 cookie-fetch.mjs 拿（它是 ESM，这里用动态 require 不行，
// 所以自己维护一份，并暴露给测试设置）
const jar = new Map();

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url); }
}

const api = {
  async get(url) {
    const host = hostOf(url);
    const cookies = jar.get(host) ?? {};
    const out = {};
    for (const [k, v] of Object.entries(cookies)) {
      out[k] = { name: k, value: v };
    }
    return out;
  },
  async set(url, cookie) {
    const host = hostOf(url);
    const cur = jar.get(host) ?? {};
    if (cookie?.name) cur[cookie.name] = String(cookie.value ?? '');
    jar.set(host, cur);
    return true;
  },
  async clearAll() { jar.clear(); return true; },
  async clearByName(url) { jar.delete(hostOf(url)); return true; },
  // 测试辅助：让测试能预置和读取
  __jar: jar,
  __reset() { jar.clear(); },
};

module.exports = api;
module.exports.default = api;
