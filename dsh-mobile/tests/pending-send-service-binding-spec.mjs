/**
 * P0-1 服务身份绑定测试。
 *
 * 覆盖：
 *   · gatewayId 来自持久化绑定；
 *   · authContextHash 不包含会轮换的 cookie；
 *   · 地址变化、不同服务器同地址、切换授权上下文都拒绝重试；
 *   · 缺 gatewayId / 缺设备上下文时安全阻断。
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import Module from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register('./support/rn-module-hook.mjs', import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIM_DIR = path.join(__dirname, 'support');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '@react-native-async-storage/async-storage') {
    return path.join(SHIM_DIR, '_async-storage-shim.cjs');
  }
  if (request === '@react-native-cookies/cookies') {
    return path.join(SHIM_DIR, '_cookie-manager-shim.cjs');
  }
  if (request === 'react-native-keychain') {
    return path.join(SHIM_DIR, '_keychain-shim.cjs');
  }
  if (request === 'react-native') {
    return path.join(SHIM_DIR, '_react-native-shim.cjs');
  }
  if (request === 'react-native-blob-util') {
    return path.join(SHIM_DIR, '_blob-util-shim.cjs');
  }
  return origResolve.call(this, request, parent, ...rest);
};
const imp = (p) => import(pathToFileURL(p).href);

const {
  loadPendingSendBinding,
  PendingSendIdentityError,
} = await imp(path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'serviceBinding.ts'));
const { evaluatePendingSendBinding } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'state.ts'),
);
const { CredentialKey, saveCredential, clearCredential } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'secureStore.ts'),
);
const keychain = (await import('./support/_keychain-shim.cjs')).default;

const BASE = 'http://127.0.0.1:3095';
const GW_A = '11111111-1111-4111-8111-111111111111';
const GW_B = '22222222-2222-4222-8222-222222222222';

async function seed({ gatewayId = GW_A, baseUrl = BASE, serverDeviceId = 'server-device-A', clientDeviceId = 'client-device-A', cookie = 'cookie-1' } = {}) {
  keychain.__reset();
  await saveCredential(
    CredentialKey.gatewayServerBinding,
    JSON.stringify({ v: 1, baseUrl, gatewayId, deviceId: serverDeviceId, at: 1 }),
  );
  await saveCredential(CredentialKey.gatewayServerDeviceId, serverDeviceId);
  await saveCredential(CredentialKey.gatewayDeviceId, clientDeviceId);
  await saveCredential(CredentialKey.cookie, cookie);
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

await check('读取持久化 gatewayId 并生成 confirmed 绑定', async () => {
  await seed();
  const b = await loadPendingSendBinding(BASE);
  assert.equal(b.gatewayId, GW_A);
  assert.equal(b.baseUrl, BASE);
  assert.equal(b.identityQuality, 'confirmed');
  assert.match(b.authContextHash, /^[a-f0-9]{64}$/);
});

await check('cookie 轮换不改变 authContextHash（不把 cookie 当身份）', async () => {
  await seed({ cookie: 'cookie-1' });
  const a = await loadPendingSendBinding(BASE);
  await saveCredential(CredentialKey.cookie, 'cookie-2-rotated');
  const b = await loadPendingSendBinding(BASE);
  assert.equal(a.authContextHash, b.authContextHash);
  assert.equal(a.gatewayId, b.gatewayId);
});

await check('同服务器地址变化：未重新验证时安全阻断', async () => {
  await seed({ baseUrl: BASE });
  await assert.rejects(
    () => loadPendingSendBinding('http://127.0.0.1:3096'),
    (e) => e instanceof PendingSendIdentityError && e.code === 'address-changed',
  );
});

await check('不同服务器同地址：gatewayId 变化被识别', async () => {
  await seed({ gatewayId: GW_A });
  const oldBinding = await loadPendingSendBinding(BASE);
  await seed({ gatewayId: GW_B });
  const newBinding = await loadPendingSendBinding(BASE);
  assert.notEqual(oldBinding.gatewayId, newBinding.gatewayId);
  const recordBinding = { ...oldBinding };
  const verdict = evaluatePendingSendBinding(recordBinding, {
    baseUrl: newBinding.baseUrl,
    gatewayId: newBinding.gatewayId,
    authContextHash: newBinding.authContextHash,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'server-instance-changed');
});

await check('切换授权上下文：设备 UUID 变化 → hash 变化并被拒绝', async () => {
  await seed({ serverDeviceId: 'server-device-A', clientDeviceId: 'client-device-A' });
  const oldBinding = await loadPendingSendBinding(BASE);
  await seed({ serverDeviceId: 'server-device-B', clientDeviceId: 'client-device-A' });
  const newBinding = await loadPendingSendBinding(BASE);
  assert.notEqual(oldBinding.authContextHash, newBinding.authContextHash);
  const verdict = evaluatePendingSendBinding(oldBinding, {
    baseUrl: newBinding.baseUrl,
    gatewayId: newBinding.gatewayId,
    authContextHash: newBinding.authContextHash,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'authorization-context-changed');
});

await check('缺 gatewayId 安全阻断', async () => {
  await seed({ gatewayId: null });
  await assert.rejects(
    () => loadPendingSendBinding(BASE),
    (e) => e instanceof PendingSendIdentityError && e.code === 'gateway-missing',
  );
});

await check('缺服务端/客户端设备 id 安全阻断', async () => {
  await seed();
  await clearCredential(CredentialKey.gatewayServerDeviceId);
  await assert.rejects(
    () => loadPendingSendBinding(BASE),
    (e) => e instanceof PendingSendIdentityError && e.code === 'device-context-missing',
  );
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
