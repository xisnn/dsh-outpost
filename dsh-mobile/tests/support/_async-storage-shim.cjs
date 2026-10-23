/**
 * AsyncStorage 的 CJS shim（给 loader hook 用）。
 *
 * 产品代码 `import AsyncStorage from '@react-native-async-storage/async-storage'`
 * 会被 rn-module-hook.mjs 重定向到这个文件。
 *
 * ## ⚠️ 必须和 async-storage-stub.mjs 共享同一份存储
 *
 * 这两个文件是一份实现的两个入口（一个 ESM、一个 CJS），
 * 因为 loader hook 重定向的目标必须是 CJS。
 *
 * 踩过的坑：一开始各自维护一个 Map，测试 `__reset()` 清的是 ESM 那份，
 * 产品代码读的却是 CJS 那份 —— 清不干净。第一个测试留下的 device token
 * 被后续测试反复复用，表现为「第二个网关测试怎么也连不上」，排查了很久。
 *
 * 现在两边都读写 globalThis 上的同一个 state。
 */

const STATE_KEY = '__dshTestAsyncStorageState__';

function getState() {
  if (!globalThis[STATE_KEY]) {
    globalThis[STATE_KEY] = { store: new Map(), calls: [] };
  }
  return globalThis[STATE_KEY];
}

const AsyncStorageStub = {
  async getItem(key) {
    const { store, calls } = getState();
    calls.push({ op: 'getItem', key });
    return store.has(key) ? store.get(key) : null;
  },
  async setItem(key, value) {
    const { store, calls } = getState();
    calls.push({ op: 'setItem', key, value });
    store.set(key, String(value));
    return null;
  },
  async removeItem(key) {
    const { store, calls } = getState();
    calls.push({ op: 'removeItem', key });
    store.delete(key);
    return null;
  },
  async multiGet(keys) {
    const { store } = getState();
    return keys.map((k) => [k, store.has(k) ? store.get(k) : null]);
  },
  async multiSet(pairs) {
    const { store } = getState();
    for (const [k, v] of pairs) store.set(k, String(v));
    return null;
  },
  async multiRemove(keys) {
    const { store } = getState();
    for (const k of keys) store.delete(k);
    return null;
  },
  async getAllKeys() {
    return [...getState().store.keys()];
  },
  async clear() {
    getState().store.clear();
    return null;
  },

  // ── 测试辅助（和 ESM 版接口一致）──────────────────────────
  __dump() {
    return Object.fromEntries(getState().store);
  },
  __reset() {
    const state = getState();
    state.store.clear();
    state.calls.length = 0;
  },
  __calls() {
    return [...getState().calls];
  },
  __did(op, key) {
    return getState().calls.some((c) => c.op === op && c.key === key);
  },
};

module.exports = AsyncStorageStub;
module.exports.default = AsyncStorageStub;
module.exports.AsyncStorageStub = AsyncStorageStub;
