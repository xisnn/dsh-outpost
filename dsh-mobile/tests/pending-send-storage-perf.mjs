/**
 * PendingSendStore 存储层容量/读写性能基准（Node 内存后端）。
 *
 * 注意：这里测的是 TypeScript store 的序列化/状态机/锁开销，不是 Android
 * Keystore 的实际加解密耗时；后者由 androidTest/KeychainStorageValidationTest.kt
 * 在模拟器上单独测量，并在 docs/v0.17/ANDROID-SECURE-STORAGE-VERIFY.md 记录。
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register('./support/rn-module-hook.mjs', import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imp = (p) => import(pathToFileURL(p).href);
const { PendingSendStore } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'store.ts'),
);

class MemoryPersistence {
  constructor() {
    this.value = undefined;
    this.writes = 0;
  }
  async readRaw() {
    return this.value;
  }
  async writeRaw(value) {
    this.writes += 1;
    this.value = value;
  }
  async clear() {
    this.value = undefined;
  }
}

const binding = {
  baseUrl: 'http://127.0.0.1:3095',
  gatewayId: 'gateway-A',
  authContextHash: 'a'.repeat(64),
  identityQuality: 'confirmed',
};
const now = () => 1_800_000_000_000;
let seq = 0;
const store = new PendingSendStore({
  persistence: new MemoryPersistence(),
  now,
  idFactory: () => `req-perf-${++seq}`,
  limits: { maxRecords: 20, maxDocumentBytes: 256 * 1024 },
});
await store.hydrate();

const text = 'x'.repeat(8 * 1024);
const startCreate = process.hrtime.bigint();
for (let i = 0; i < 20; i += 1) {
  await store.create({
    sessionId: 'session-perf',
    mode: 'queue',
    text: `${text}-${i}`,
    attachments: [],
    binding,
  });
}
const createMs = Number(process.hrtime.bigint() - startCreate) / 1e6;

const startRead = process.hrtime.bigint();
for (let i = 0; i < 200; i += 1) {
  await store.list('session-perf');
}
const readMs = Number(process.hrtime.bigint() - startRead) / 1e6;

const stats = await store.stats();
assert.equal(stats.count, 20);
assert.ok(createMs < 3000, `20 次 create 超过 3s（${createMs.toFixed(1)}ms）`);
assert.ok(readMs < 3000, `200 次 list 超过 3s（${readMs.toFixed(1)}ms）`);

console.log('PendingSendStore 性能：');
console.log(`  20 条 × 8KiB 文本 create：${createMs.toFixed(1)} ms（平均 ${(createMs / 20).toFixed(2)} ms/条）`);
console.log(`  200 次 list：${readMs.toFixed(1)} ms（平均 ${(readMs / 200).toFixed(3)} ms/次）`);
console.log(`  文档大小：${stats.bytes} bytes；revision=${stats.revision}；记录数=${stats.count}`);
console.log('');
console.log('结果：性能基准通过（Node 内存后端）');
