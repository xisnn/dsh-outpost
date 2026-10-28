/**
 * KeychainPendingSendPersistence 包装层测试。
 *
 * 这里验证的是 TypeScript 包装层的契约（service、Android storage 选项、
 * 错误分类、回读数据透传）；真实 Android Keystore 行为由
 * androidTest/KeychainStorageValidationTest.kt 在模拟器上验证。
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register('./support/rn-module-hook.mjs', import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imp = (p) => import(pathToFileURL(p).href);

const {
  KeychainPendingSendPersistence,
  PendingSendPersistenceError,
  PENDING_SEND_KEYCHAIN_SERVICE,
  ANDROID_PENDING_SEND_STORAGE,
} = await imp(path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'persistence.ts'));

class FakeKeychain {
  constructor() {
    this.value = undefined;
    this.optionsLog = [];
    this.throwSet = false;
    this.throwGet = false;
    this.throwReset = false;
    this.storage = ANDROID_PENDING_SEND_STORAGE;
  }
  async setGenericPassword(username, password, options) {
    if (this.throwSet) throw new Error('set failed');
    this.optionsLog.push({ username, password, options });
    this.value = String(password);
    return { service: options?.service, storage: this.storage };
  }
  async getGenericPassword(options) {
    if (this.throwGet) throw new Error('get failed');
    if (this.value === undefined) return false;
    return { username: 'pending-sends', password: this.value, service: options?.service };
  }
  async resetGenericPassword(options) {
    if (this.throwReset) throw new Error('reset failed');
    this.value = undefined;
    return true;
  }
}

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  OK    ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL  ' + name + (e?.message ? ' — ' + e.message : ''));
  }
}

await check('Android 写入显式使用 KeystoreAESGCM_NoAuth，不依赖 accessible', async () => {
  const kc = new FakeKeychain();
  const p = new KeychainPendingSendPersistence(kc);
  await p.writeRaw('payload');
  assert.equal(kc.optionsLog.length, 1);
  const options = kc.optionsLog[0].options;
  assert.equal(options.service, PENDING_SEND_KEYCHAIN_SERVICE);
  assert.equal(options.storage, ANDROID_PENDING_SEND_STORAGE);
  assert.equal('accessible' in options, false);
});

await check('写入后读取返回原始 payload', async () => {
  const kc = new FakeKeychain();
  const p = new KeychainPendingSendPersistence(kc);
  await p.writeRaw('payload');
  assert.equal(await p.readRaw(), 'payload');
});

await check('无记录时读取返回 undefined', async () => {
  const p = new KeychainPendingSendPersistence(new FakeKeychain());
  assert.equal(await p.readRaw(), undefined);
});

await check('实际 storage 不匹配时拒绝（防止静默降级到 AES-CBC/认证存储）', async () => {
  const kc = new FakeKeychain();
  kc.storage = 'KeystoreAESCBC';
  const p = new KeychainPendingSendPersistence(kc);
  await assert.rejects(
    () => p.writeRaw('payload'),
    (e) => e instanceof PendingSendPersistenceError && e.code === 'unexpected-android-storage',
  );
});

await check('set/get/reset 失败都转换为 PendingSendPersistenceError', async () => {
  const kc = new FakeKeychain();
  const p = new KeychainPendingSendPersistence(kc);
  kc.throwSet = true;
  await assert.rejects(
    () => p.writeRaw('x'),
    (e) => e instanceof PendingSendPersistenceError && e.code === 'keychain-write-failed',
  );
  kc.throwSet = false;
  kc.throwGet = true;
  await assert.rejects(
    () => p.readRaw(),
    (e) => e instanceof PendingSendPersistenceError && e.code === 'keychain-read-failed',
  );
  kc.throwGet = false;
  kc.throwReset = true;
  await assert.rejects(
    () => p.clear(),
    (e) => e instanceof PendingSendPersistenceError && e.code === 'keychain-clear-failed',
  );
});

await check('clear 后读取为空', async () => {
  const kc = new FakeKeychain();
  const p = new KeychainPendingSendPersistence(kc);
  await p.writeRaw('payload');
  await p.clear();
  assert.equal(await p.readRaw(), undefined);
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
