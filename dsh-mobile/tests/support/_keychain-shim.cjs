/**
 * react-native-keychain 的 Node 替身。
 *
 * 产品代码的凭据走 `src/core/secureStore.ts`，那里用 Keychain 的
 * setGenericPassword / getGenericPassword / resetGenericPassword。
 * Node 里没有原生 Keystore，用内存 Map 替身。
 *
 * ## ⚠️ 状态必须挂 globalThis
 *
 * 这个文件会被**两条路径**加载：
 *   · ESM loader hook（测试文件的动态 import）
 *   · Module._resolveFilename（产品代码经 tsx 转译后的 require）
 *
 * 如果状态是模块级 `const store = new Map()`，两条路径各拿到一个
 * 独立实例 —— 测试写进去的值产品代码读不到，反之亦然。
 * 这和之前 AsyncStorage 踩的坑一模一样。
 *
 * 注意：**这个替身只是为了让测试能跑**，不代表真实安全性。
 * 真机上的 Keystore 是系统级加密，这里就是个 Map。
 */

const STATE_KEY = '__dshTestKeychainState__';

function getState() {
  if (!globalThis[STATE_KEY]) globalThis[STATE_KEY] = { store: new Map() };
  return globalThis[STATE_KEY];
}

const ACCESSIBLE = {
  WHEN_UNLOCKED: 'AccessibleWhenUnlocked',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
  AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AccessibleAfterFirstUnlockThisDeviceOnly',
  ALWAYS: 'AccessibleAlways',
  ALWAYS_THIS_DEVICE_ONLY: 'AccessibleAlwaysThisDeviceOnly',
};

const api = {
  ACCESSIBLE,

  async setGenericPassword(username, password, options) {
    const service = options?.service ?? 'default';
    getState().store.set(service, { username, password: String(password) });
    return { service, storage: 'keystore-stub' };
  },

  async getGenericPassword(options) {
    const service = options?.service ?? 'default';
    const rec = getState().store.get(service);
    if (!rec) return false;
    return { username: rec.username, password: rec.password, service };
  },

  async resetGenericPassword(options) {
    const service = options?.service ?? 'default';
    return getState().store.delete(service);
  },

  // ── 测试辅助 ─────────────────────────────────────────────
  __dump() {
    return Object.fromEntries(getState().store);
  },
  __reset() {
    getState().store.clear();
  },
  /** 某个 service 里有没有值 */
  __has(service) {
    return getState().store.has(service);
  },
};

module.exports = api;
module.exports.default = api;
