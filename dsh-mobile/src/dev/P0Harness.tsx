/**
 * P0-1 Android 真机/模拟器接线测试 harness（仅 __DEV__ 注册）。
 *
 * 运行真正的 JS → react-native-keychain → Android Keystore/DataStore 路径。
 * 结果通过 console.log 输出为 `P0HARNESS ...`，由 adb logcat 采集。
 * 不参与正式版本 UI；debug 专用 Activity 见 android/app/src/debug。
 */
import React, { useEffect, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ReactNativeBlobUtil from 'react-native-blob-util';

import { DshConnection } from '../core/transport';
import { Store } from '../core/store';
import { PendingSendStore } from '../core/pendingSend/store';
import type { PendingSendPersistence } from '../core/pendingSend/persistence';
import { loadPendingSendBinding } from '../core/pendingSend/serviceBinding';
import { ReactNativePendingSendStaging } from '../core/pendingSend/staging';
import { CredentialKey, saveCredential } from '../core/secureStore';

const PHASE_KEY = '@dsh/p0HarnessPhase';
const BASE_URL = 'http://127.0.0.1:1';
const GATEWAY_ID = 'harness-gateway';
const SERVER_DEVICE_ID = 'harness-server-device';
const CLIENT_DEVICE_ID = 'harness-client-device';

async function seedHarnessIdentity(): Promise<void> {
  await saveCredential(
    CredentialKey.gatewayServerBinding,
    JSON.stringify({
      v: 1,
      baseUrl: BASE_URL,
      gatewayId: GATEWAY_ID,
      deviceId: SERVER_DEVICE_ID,
      at: 1,
    }),
  );
  await saveCredential(CredentialKey.gatewayServerDeviceId, SERVER_DEVICE_ID);
  await saveCredential(CredentialKey.gatewayDeviceId, CLIENT_DEVICE_ID);
  await saveCredential(CredentialKey.cookie, 'harness-cookie-1');
}

function log(msg: string): void {
  console.log(`P0HARNESS ${msg}`);
}

async function freshPending(): Promise<PendingSendStore> {
  const ps = new PendingSendStore({ staging: new ReactNativePendingSendStaging() });
  await ps.hydrate();
  await ps.clearAll();
  return ps;
}

function makeStore(ps: PendingSendStore, promptImpl: (params: any) => Promise<void>): Store {
  const conn = new DshConnection({ baseUrl: BASE_URL, cookie: 'dsh-auth-test=v1' });
  // 不注入 binding：走真实 loadPendingSendBinding → Keychain 读取路径。
  const store = new Store(conn, {
    pendingSendStore: ps,
    // 这是本地 Keychain 接线 harness；真实远端 identity 验证由 Node
    // service-binding 测试与真实 DSH 手工 e2e 覆盖。
    verifyPendingBinding: async () => undefined,
  });
  store.api.prompt = promptImpl;
  return store;
}

/** 仅在 JS 存储边界注入失败；用于验证失败时不会调用 prompt。 */
class FailingPersistence implements PendingSendPersistence {
  private value: string | undefined;
  constructor(private readonly mode: 'read' | 'write' | 'readback') {}
  async readRaw(): Promise<string | undefined> {
    if (this.mode === 'read') throw new Error('injected keychain read failure');
    if (this.mode === 'readback' && this.value !== undefined) return '{"corrupt":true}';
    return this.value;
  }
  async writeRaw(value: string): Promise<void> {
    if (this.mode === 'write') throw new Error('injected keychain write failure');
    this.value = value;
  }
  async clear(): Promise<void> {
    this.value = undefined;
  }
}

async function loadHarnessBinding() {
  return loadPendingSendBinding(BASE_URL, {
    cookie: 'harness-cookie',
    verifyRemote: async () => GATEWAY_ID,
  });
}

async function runAttachmentSuite(): Promise<void> {
  const dir = ReactNativeBlobUtil.fs.dirs.DocumentDir;
  const imagePath = `${dir}/p0-image.png`;
  const filePath = `${dir}/p0-file.txt`;
  await ReactNativeBlobUtil.fs.writeFile(imagePath, 'PNG-DATA', 'utf8');
  await ReactNativeBlobUtil.fs.writeFile(filePath, 'FILE-DATA', 'utf8');

  // 纯图片：不 upload，prompt 内联真实字节 base64。
  {
    const ps = await freshPending();
    const prompts: any[] = [];
    const store = makeStore(ps, async (params) => {
      prompts.push(params);
    });
    const rec = await store.sendPending('attach', '', [
      { kind: 'image', uri: imagePath, name: 'p0-image.png', size: 8, mime: 'image/png' },
    ]);
    if (
      rec.state !== 'accepted' ||
      prompts[0].parts[0].type !== 'image' ||
      !prompts[0].parts[0].data ||
      !/^[a-f0-9]{64}$/.test(rec.attachments[0].contentSha256)
    ) {
      throw new Error('pure-image attachment path failed');
    }
    log('PASS attachment-pure-image');
    await ps.clearAll();
  }

  // 纯文件 + 混合：真实私有暂存 + mock upload 回执。
  {
    const ps = await freshPending();
    const prompts: any[] = [];
    const uploads: string[] = [];
    const store = makeStore(ps, async (params) => {
      prompts.push(params);
    });
    store.upload.uploadBinary = async (_sessionId, stagedUri, name) => {
      uploads.push(`${stagedUri}:${name}`);
      return {
        receiptId: `receipt-p0-${uploads.length}`,
        file: { attachmentId: `att-p0-${uploads.length}`, name, bytes: 9 },
      };
    };
    const fileRec = await store.sendPending('attach', '', [
      { kind: 'file', uri: filePath, name: 'p0-file.txt', size: 9, mime: 'text/plain' },
    ]);
    if (fileRec.state !== 'accepted' || prompts[0].parts[0].type !== 'file') {
      throw new Error('pure-file attachment path failed');
    }
    const mixedRec = await store.sendPending('attach', 'mixed', [
      { kind: 'image', uri: imagePath, name: 'p0-image.png', size: 8, mime: 'image/png' },
      { kind: 'file', uri: filePath, name: 'p0-file.txt', size: 9, mime: 'text/plain' },
    ]);
    if (
      mixedRec.state !== 'accepted' ||
      prompts[1].parts.map((p: any) => p.type).join(',') !== 'text,image,file' ||
      uploads.length !== 2
    ) {
      throw new Error('mixed attachment path failed');
    }
    log('PASS attachment-pure-file-and-mixed');
    await ps.clearAll();
  }

  // 相同文件名/大小、不同内容：真实暂存 SHA-256 必须不同。
  {
    const dir2 = ReactNativeBlobUtil.fs.dirs.DocumentDir;
    const aPath = `${dir2}/p0-same-a.bin`;
    const bPath = `${dir2}/p0-same-b.bin`;
    await ReactNativeBlobUtil.fs.writeFile(aPath, 'AAAA', 'utf8');
    await ReactNativeBlobUtil.fs.writeFile(bPath, 'BBBB', 'utf8');
    const ps = await freshPending();
    const store = makeStore(ps, async () => undefined);
    store.upload.uploadBinary = async (_s, _p, name) => ({
      receiptId: `receipt-same-${name}`,
      file: { attachmentId: `att-same-${name}`, name, bytes: 4 },
    });
    const a = await store.sendPending('attach', '', [
      { kind: 'file', uri: aPath, name: 'same.bin', size: 4, mime: 'application/octet-stream' },
    ]);
    const b = await store.sendPending('attach', '', [
      { kind: 'file', uri: bPath, name: 'same.bin', size: 4, mime: 'application/octet-stream' },
    ]);
    if (
      a.requestId === b.requestId ||
      a.attachments[0].contentSha256 === b.attachments[0].contentSha256
    ) {
      throw new Error('same-name-size-different-content was merged');
    }
    log('PASS attachment-same-name-size-different-content');
    await ps.clearAll();
  }

  // 暂存源删除后，重启记录仍能靠私有副本恢复（原始 URI 失效）。
  {
    const ps = await freshPending();
    const staged = await ps.stageDrafts([
      { kind: 'file', uri: filePath, name: 'p0-file.txt', size: 9, mime: 'text/plain' },
    ]);
    const binding = await loadHarnessBinding();
    const rec = await ps.create({
      sessionId: 'attach',
      mode: 'queue',
      text: '',
      attachments: staged,
      binding,
    });
    await ReactNativeBlobUtil.fs.unlink(filePath).catch(() => undefined);
    const ps2 = new PendingSendStore({ staging: new ReactNativePendingSendStaging() });
    await ps2.hydrate();
    const restored = await ps2.get(rec.requestId);
    if (!restored || restored.attachments[0].stagedUri !== staged[0].stagedUri) {
      throw new Error('staged attachment did not survive source deletion');
    }
    log('PASS attachment-source-uri-gone-staged-survives');
    await ps2.clearAll();
  }
}

async function runFreshSuite(): Promise<void> {
  await seedHarnessIdentity();

  // 0. 真实服务身份路径：gatewayId + 设备上下文，cookie 轮换不影响 hash。
  {
    const a = await loadHarnessBinding();
    await saveCredential(CredentialKey.cookie, 'harness-cookie-2');
    const b = await loadHarnessBinding();
    if (a.gatewayId !== GATEWAY_ID || a.authContextHash !== b.authContextHash) {
      throw new Error('service binding path failed');
    }
    log('PASS service-binding-cookie-rotation');
  }

  await runAttachmentSuite();
  // 1. 首次发送前持久化：prompt 被调用时记录必须已在 Keychain 中。
  {
    const ps = await freshPending();
    const seen: string[] = [];
    const store = makeStore(ps, async (params) => {
      seen.push(params.requestId);
    });
    const rec = await store.sendPending('s1', 'first');
    const stored = await ps.get(rec.requestId);
    if (stored?.state !== 'accepted' || seen.length !== 1 || seen[0] !== rec.requestId) {
      throw new Error('first-persist failed');
    }
    log('PASS first-persist');
    await ps.clearAll();
  }

  // 2. 同文本连续两次新发送：两个不同 requestId，两次 prompt。
  {
    const ps = await freshPending();
    const seen: string[] = [];
    const store = makeStore(ps, async (params) => {
      seen.push(params.requestId);
    });
    const a = await store.sendPending('s1', 'same-text');
    const b = await store.sendPending('s1', 'same-text');
    if (a.requestId === b.requestId || seen.length !== 2 || seen[0] === seen[1]) {
      throw new Error('same-text-new-id failed');
    }
    log('PASS same-text-new-id');
    await ps.clearAll();
  }

  // 3. 发送失败后显式重试复用同一 requestId。
  {
    const ps = await freshPending();
    const seen: string[] = [];
    let calls = 0;
    const store = makeStore(ps, async (params) => {
      seen.push(params.requestId);
      calls += 1;
      if (calls === 1) throw new Error('Network request failed');
    });
    try {
      await store.sendPending('s1', 'retry-me');
    } catch {
      /* expected */
    }
    const rec = (await ps.list('s1'))[0];
    if (!rec || rec.state !== 'unknown') throw new Error('retry state not unknown');
    const retried = await store.retryPending('s1', rec.requestId);
    if (retried.requestId !== rec.requestId || seen.length !== 2 || seen[0] !== seen[1]) {
      throw new Error('retry-id mismatch');
    }
    log('PASS retry-same-id');
    await ps.clearAll();
  }

  // 4. 服务端已接受但回执丢失：重试同 ID，mock 服务端去重。
  {
    const ps = await freshPending();
    const acceptedIds = new Set<string>();
    let calls = 0;
    const store = makeStore(ps, async (params) => {
      calls += 1;
      acceptedIds.add(params.requestId);
      if (calls === 1) throw new Error('请求超时（模拟回执丢失）');
    });
    try {
      await store.sendPending('s1', 'receipt-lost');
    } catch {
      /* expected uncertain */
    }
    const rec = (await ps.list('s1'))[0];
    const retried = await store.retryPending('s1', rec.requestId);
    if (retried.requestId !== rec.requestId || calls !== 2 || acceptedIds.size !== 1) {
      throw new Error('accepted-loss dedupe failed');
    }
    log('PASS accepted-response-lost-dedupe');
    await ps.clearAll();
  }

  // 5. 页面退出再进入 / 新实例读取同一 Keychain：accepted 记录仍可见。
  {
    const ps = await freshPending();
    const store = makeStore(ps, async () => undefined);
    const rec = await store.sendPending('s1', 'page-exit');
    const ps2 = new PendingSendStore();
    await ps2.hydrate();
    const restored = await ps2.get(rec.requestId);
    if (restored?.state !== 'accepted') throw new Error('page-exit recovery failed');
    log('PASS page-exit-reenter');
    await ps2.clearAll();
  }

  // 6. 实际 Keychain 容量/重复写入性能：20 条 × 8KiB。
  {
    const ps = await freshPending();
    const binding = await loadHarnessBinding();
    const text = 'x'.repeat(8 * 1024);
    const start = Date.now();
    for (let i = 0; i < 20; i += 1) {
      await ps.create({
        sessionId: 'perf',
        mode: 'queue',
        text: `${text}-${i}`,
        attachments: [],
        binding,
      });
    }
    const ms = Date.now() - start;
    const stats = await ps.stats();
    if (stats.count !== 20) throw new Error(`perf count ${stats.count}`);
    log(`PASS keychain-capacity-perf count=20 bytes=${stats.bytes} totalMs=${ms}`);
    await ps.clearAll();
  }

  // 7. JS 存储边界注入写失败/回读失败：block before prompt。
  {
    let prompts = 0;
    const psWrite = new PendingSendStore({
      persistence: new FailingPersistence('write'),
    });
    await psWrite.hydrate();
    const storeWrite = makeStore(psWrite, async () => {
      prompts += 1;
    });
    try {
      await storeWrite.sendPending('s1', 'write-fail');
      throw new Error('write failure was not blocked');
    } catch (e) {
      if (e instanceof Error && e.message === 'write failure was not blocked') throw e;
    }
    if (prompts !== 0) throw new Error('prompt called after write failure');

    const psReadback = new PendingSendStore({ persistence: new FailingPersistence('readback') });
    await psReadback.hydrate();
    const storeReadback = makeStore(psReadback, async () => {
      prompts += 1;
    });
    try {
      await storeReadback.sendPending('s1', 'readback-fail');
      throw new Error('readback failure was not blocked');
    } catch (e) {
      if (e instanceof Error && e.message === 'readback failure was not blocked') throw e;
    }
    if (prompts !== 0) throw new Error('prompt called after readback failure');
    log('PASS injected-write-readback-failure-blocked');
  }
}

async function setupForceStop(): Promise<void> {
  const ps = await freshPending();
  const binding = await loadHarnessBinding();
  const rec = await ps.create({
    sessionId: 'force-stop',
    mode: 'queue',
    text: 'force-stop-me',
    attachments: [],
    binding,
  });
  await ps.apply(rec.requestId, { type: 'begin-preparing' });
  await ps.apply(rec.requestId, { type: 'attachments-ready' });
  await ps.apply(rec.requestId, { type: 'begin-send' });
  await AsyncStorage.setItem(PHASE_KEY, 'after-force-stop');
  log(`READY_FOR_FORCE_STOP ${rec.requestId}`);
}

async function recoverAfterForceStop(): Promise<void> {
  const ps = new PendingSendStore();
  await ps.hydrate();
  const records = await ps.list('force-stop');
  if (records.length !== 1 || records[0].state !== 'unknown') {
    throw new Error(`force-stop recovery unexpected: ${JSON.stringify(records)}`);
  }
  const rec = records[0];
  const binding = await loadHarnessBinding();
  const retried = await ps.retry(rec.requestId, binding);
  if (retried.requestId !== rec.requestId || retried.state !== 'preparing') {
    throw new Error('force-stop retry id mismatch');
  }
  await ps.clearAll();
  await AsyncStorage.removeItem(PHASE_KEY);
  log('PASS force-stop-restart-recovery');
}

export default function P0Harness() {
  const [status, setStatus] = useState('running');
  useEffect(() => {
    void (async () => {
      try {
        log('START');
        const phase = await AsyncStorage.getItem(PHASE_KEY);
        if (phase === 'after-force-stop') {
          await recoverAfterForceStop();
          setStatus('force-stop recovery PASS');
        } else {
          await runFreshSuite();
          await setupForceStop();
          setStatus('fresh suite PASS; waiting force-stop');
        }
        log('DONE');
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log(`FAIL ${message}`);
        setStatus(`FAIL: ${message}`);
      }
    })();
  }, []);

  return (
    <ScrollView contentContainerStyle={{ padding: 24 }}>
      <Text style={{ fontSize: 18, fontWeight: '600' }}>P0-1 Harness</Text>
      <Text style={{ marginTop: 12 }}>{status}</Text>
    </ScrollView>
  );
}
