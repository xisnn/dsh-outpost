/**
 * `react-native-blob-util` 的 Node 替身。
 *
 * ## 为什么需要
 *
 * 这个包的源码是 **Flow 语法**（`fs.js:59` 之类），Node 的转译器解析不了：
 *
 *     react-native-blob-util/fs.js:59:21: ERROR: Expected ")" but found ":"
 *
 * 而 `store.ts` → `UploadApi` → `rpc/upload.ts` 会 import 它，
 * 所以任何驱动 Store 的测试都会在加载阶段崩掉。
 *
 * ## 这里只做「不崩」
 *
 * 文件系统的真实行为（下载、缓存、MediaStore 写入）**没有被测到** ——
 * 那些只能在真机上验证。这个替身的存在只为了让不关心文件 IO 的
 * 测试（比如消息发送 / 重试）能跑起来。
 *
 * 每个方法都返回一个合理的空值，不模拟真实写盘。
 */

/** 所有 fs 方法：要么返回空，要么返回安全的默认值 */
const fs = {
  dirs: {
    CacheDir: '/tmp/dsh-test-cache',
    DocumentDir: '/tmp/dsh-test-docs',
    DownloadDir: '/tmp/dsh-test-downloads',
    DCIMDir: '/tmp/dsh-test-dcim',
  },
  async exists() {
    return false;
  },
  async stat() {
    return { size: 0 };
  },
  async unlink() {
    return true;
  },
  async readFile() {
    // base64 / utf8 都返回空串，调用方自己会判定「文件为空」
    return '';
  },
  async writeFile() {
    return '/tmp/dsh-test-file';
  },
  async mkdir() {
    return true;
  },
  async ls() {
    return [];
  },
};

/** config() 链式 API：每次调用都返回同一个对象 */
const configResult = {
  fetch: async () => ({
    info: () => ({ status: 200, headers: {} }),
    path: () => '/tmp/dsh-test-file',
    respInfo: () => ({ status: 200 }),
  }),
  readFile: async () => '',
  writeFile: async () => '/tmp/dsh-test-file',
};

const api = {
  fs,
  config: () => configResult,
  fetch: async () => ({
    info: () => ({ status: 200, headers: {} }),
    path: () => '/tmp/dsh-test-file',
  }),
  MediaCollection: {
    async copyToMediaStore() {
      return 'content://media/test';
    },
    async createMediafile() {
      return 'content://media/test';
    },
    async writeToMediafile() {
      return 'content://media/test';
    },
    async copyAndTransformToMediafile() {
      return 'content://media/test';
    },
  },
  android: {
    actionViewIntent: async () => true,
    getContentUri: async () => 'content://media/test',
  },
  ios: {
    previewDocument: async () => true,
  },
  base64: {
    encode: (s) => Buffer.from(String(s)).toString('base64'),
    decode: (s) => Buffer.from(String(s), 'base64').toString(),
  },
  wrap: (p) => `file://${p}`,
  session: () => configResult,
};

module.exports = api;
module.exports.default = api;
