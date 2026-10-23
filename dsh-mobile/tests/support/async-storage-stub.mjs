/**
 * AsyncStorage 的 Node 替身（唯一的真实实现）。
 *
 * ## 为什么需要它
 *
 * `ApprovalGateway` 和 `Store` 都 `import AsyncStorage from
 * '@react-native-async-storage/async-storage'` —— 那是 RN 原生模块，
 * 在 Node 里跑会直接报 "NativeModule is null"。
 *
 * 但这不影响测业务逻辑：AsyncStorage 在这里只是个 key-value 存储，
 * 用 Map 实现行为完全一致（含异步语义、含 removeItem）。
 *
 * ## ⚠️ 关键：只能有一份存储
 *
 * 踩过的坑：一开始这里（ESM）一份 Map，`_async-storage-shim.cjs`（CJS）
 * 另一份 Map。产品代码通过 loader hook 走 CJS 那份，测试通过 ESM 这份
 * 调 `__reset()` —— **清的是另一份，永远清不干净**。
 *
 * 表现：第一个测试留下的 device token 被后续测试反复复用，
 * 于是「第二个测试怎么也连不上」，排查了很久。
 *
 * 现在改成：state 挂在 globalThis 上，ESM 和 CJS 共享同一份。
 */

/** 共享状态的 key（避免污染其他全局变量） */
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
    const { store, calls } = getState();
    calls.push({ op: 'multiGet', keys });
    return keys.map((k) => [k, store.has(k) ? store.get(k) : null]);
  },

  async multiSet(pairs) {
    const { store, calls } = getState();
    calls.push({ op: 'multiSet' });
    for (const [k, v] of pairs) store.set(k, String(v));
    return null;
  },

  async multiRemove(keys) {
    const { store, calls } = getState();
    calls.push({ op: 'multiRemove', keys });
    for (const k of keys) store.delete(k);
    return null;
  },

  async getAllKeys() {
    return [...getState().store.keys()];
  },

  async clear() {
    const { store, calls } = getState();
    calls.push({ op: 'clear' });
    store.clear();
    return null;
  },

  // ── 测试辅助 ──────────────────────────────────────────────
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

export default AsyncStorageStub;
export { AsyncStorageStub };
