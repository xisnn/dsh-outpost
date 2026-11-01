import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from '@babel/core';

register('./support/rn-module-hook.mjs', import.meta.url);
const require = createRequire(import.meta.url);
const resolve = Module._resolveFilename;
const shims = {
  'react-native-keychain': './support/_keychain-shim.cjs',
  '@react-native-async-storage/async-storage': './support/_async-storage-shim.cjs',
  '@react-native-cookies/cookies': './support/_cookie-manager-shim.cjs',
};
Module._resolveFilename = function (name, ...args) {
  return shims[name] ? fileURLToPath(new URL(shims[name], import.meta.url)) : resolve.call(this, name, ...args);
};
globalThis.require ??= require;

const { ApprovalGateway, gatewayUrlFrom } = await import('../src/core/approvalGateway.ts');
const { CredentialKey, saveCredential } = await import('../src/core/secureStore.ts');
const { __resetRevocationCache } = await import('../src/core/deviceRevocation.ts');
const storage = require('./support/_async-storage-shim.cjs');

function resetCredentials() {
  globalThis.__dshTestKeychainState__ = { store: new Map() };
  storage.__reset();
  __resetRevocationCache();
}

// Use the shipped RN URL class and the production Babel preset. Node's URL has
// setters that RN 0.81.4 does not; Node-only tests missed the hotfix.1 regression.
function androidRuntime(overrides = {}) {
  const compile = (filename) => transformSync(readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false,
    presets: [require.resolve('@react-native/babel-preset')],
  }).code;
  const rnContext = {
    exports: {},
    require: (name) => name.startsWith('@babel/') ? require(name) : null,
  };
  vm.runInNewContext(compile(require.resolve('react-native/Libraries/Blob/URL.js')), rnContext);
  const filename = fileURLToPath(new URL('../src/core/approvalGateway.ts', import.meta.url));
  const context = {
    exports: {}, URL: rnContext.exports.URL, require: createRequire(filename),
    setTimeout, clearTimeout, AbortController, console, ...overrides,
  };
  vm.runInNewContext(compile(filename), context);
  return { ...context.exports, context };
}

test('Android production runtime derives the approval path instead of the website root', () => {
  const { gatewayUrlFrom: derive, context } = androidRuntime();
  assert.equal(Object.getOwnPropertyDescriptor(context.URL.prototype, 'protocol').set, undefined);
  assert.equal(derive('https://example.trycloudflare.com'), 'wss://example.trycloudflare.com/ws/mobile');
  assert.equal(derive('http://[::1]:3095/?token=secret#x'), 'ws://[::1]:3095/ws/mobile');
  assert.equal(derive('https://user:password@example.test:8443/old?token=secret#x'),
    'wss://example.test:8443/ws/mobile');
});

test('Android production runtime pairs and reconnects to the same public approval endpoint', async () => {
  for (const savedToken of [false, true]) {
    resetCredentials();
    if (savedToken) await saveCredential(CredentialKey.gatewayToken, 'existing-device-token');
    const sockets = [];
    let pairRequests = 0;
    const { ApprovalGateway: AndroidGateway } = androidRuntime({
      fetch: async (_url, options) => {
        pairRequests += 1;
        const body = JSON.parse(options.body);
        assert.equal(body.publicUrl, 'wss://example.trycloudflare.com/ws/mobile');
        return { ok: true, json: async () => ({ payload: {
          pairingCode: 'android-pairing-code', publicUrl: body.publicUrl,
          endpoints: ['ws://192.168.1.8:3081/ws/mobile', body.publicUrl],
        } }) };
      },
      WebSocket: class {
        readyState = 0;
        constructor(url, protocols, options) { sockets.push({ url, protocols, options }); }
        close() { this.readyState = 3; }
      },
    });
    const gateway = new AndroidGateway('https://example.trycloudflare.com', {});
    try {
      await gateway.connect();
      assert.equal(sockets.length, 1);
      assert.equal(sockets[0].url, 'wss://example.trycloudflare.com/ws/mobile');
      assert.equal(pairRequests, savedToken ? 0 : 1);
      assert.ok(sockets[0].protocols.includes(savedToken
        ? 'dsh-auth.existing-device-token' : 'dsh-pair.android-pairing-code'));
      assert.ok(sockets[0].options.headers['X-DSH-Device-ID']);
    } finally {
      gateway.disconnect();
    }
  }
});

test('WebSocket derivation preserves the authenticated origin and removes URL credentials', () => {
  for (const [input, expected] of [
    ['https://example.trycloudflare.com', 'wss://example.trycloudflare.com/ws/mobile'],
    ['https://example.test:8443/', 'wss://example.test:8443/ws/mobile'],
    ['http://192.168.1.8:3095/?token=secret#x', 'ws://192.168.1.8:3095/ws/mobile'],
    ['http://[::1]:3095/', 'ws://[::1]:3095/ws/mobile'],
    ['https://user:password@example.test/', 'wss://example.test/ws/mobile'],
    ['file:///tmp/file', ''],
  ]) assert.equal(gatewayUrlFrom(input), expected);
});

test('cold start with an existing device token reconnects over the tunnel TLS port', async () => {
  resetCredentials();
  await saveCredential(CredentialKey.gatewayToken, 'existing-device-token');
  const oldFetch = globalThis.fetch;
  const oldWs = globalThis.WebSocket;
  const sockets = [];
  globalThis.fetch = async () => { throw new Error('existing token must not mint a pairing code'); };
  globalThis.WebSocket = class {
    readyState = 0;
    constructor(url, protocols, options) { sockets.push({ url, protocols, options }); }
    close() { this.readyState = 3; }
  };
  const gateway = new ApprovalGateway('https://example.trycloudflare.com', {});
  try {
    await gateway.connect();
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].url, 'wss://example.trycloudflare.com/ws/mobile');
    assert.ok(sockets[0].protocols.includes('dsh-auth.existing-device-token'));
    assert.ok(sockets[0].options.headers['X-DSH-Device-ID']);
  } finally {
    gateway.disconnect();
    globalThis.fetch = oldFetch;
    globalThis.WebSocket = oldWs;
  }
});

test('first pairing explicitly supplies a WSS endpoint behind TLS-terminating proxies', async () => {
  resetCredentials();
  const oldFetch = globalThis.fetch;
  const oldWs = globalThis.WebSocket;
  const sockets = [];
  let pairingBody;
  globalThis.fetch = async (_url, options) => {
    pairingBody = JSON.parse(options.body);
    assert.equal(pairingBody.publicUrl, 'wss://example.trycloudflare.com/ws/mobile');
    return { ok: true, json: async () => ({ payload: {
      pairingCode: 'one-time-test-code',
      publicUrl: pairingBody.publicUrl,
      endpoints: ['ws://192.168.1.8:3081/ws/mobile', pairingBody.publicUrl],
    } }) };
  };
  globalThis.WebSocket = class {
    readyState = 0;
    constructor(url, protocols) { sockets.push({ url, protocols }); }
    close() { this.readyState = 3; }
  };
  const gateway = new ApprovalGateway('https://example.trycloudflare.com', {});
  try {
    await gateway.connect();
    assert.ok(pairingBody);
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].url, 'wss://example.trycloudflare.com/ws/mobile');
    assert.ok(sockets[0].protocols.includes('dsh-pair.one-time-test-code'));
  } finally {
    gateway.disconnect();
    globalThis.fetch = oldFetch;
    globalThis.WebSocket = oldWs;
  }
});

test('advertised LAN, insecure, stale, or foreign endpoints cannot replace a working HTTPS origin', () => {
  const gateway = new ApprovalGateway('https://example.trycloudflare.com', {});
  gateway.endpoints = [
    'ws://example.trycloudflare.com:443/ws/mobile',
    'wss://example.trycloudflare.com:3081/ws/mobile',
    'ws://192.168.1.8:3081/ws/mobile',
  ];
  gateway.publicUrl = 'wss://old.trycloudflare.com/ws/mobile';
  assert.equal(gateway.url, 'wss://example.trycloudflare.com/ws/mobile');
});
