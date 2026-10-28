/**
 * 静态接线守门：确保 P0-1 阶段 2 的关键路径没有被后续重构成“看似有 UI、
 * 实际没走持久化存储”。运行时不依赖 React Native。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

const chat = read('src/screens/ChatScreen.tsx');
const store = read('src/core/store.ts');
const app = read('src/App.tsx');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  OK    ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL  ' + name + (e?.message ? ' — ' + e.message : ''));
  }
}

check('ChatScreen 文本/附件统一走 store.sendPending', () => {
  assert.match(chat, /store\.sendPending\(sessionId,\s*text,\s*pendingAttachments\)/);
});

check('ChatScreen 渲染 PendingSendBubble 并调用 retryPending', () => {
  assert.match(chat, /<PendingSendBubble/);
  assert.match(chat, /store\.retryPending\(sessionId,\s*record\.requestId\)/);
});

check('Store.sendPending 先 create 持久化，再调用 send；文本路径关闭乐观插入', () => {
  const start = store.indexOf('async sendPending(');
  const end = store.indexOf('async retryPending(', start);
  const seg = store.slice(start, end);
  assert.match(seg, /pendingSends\.create\(/);
  assert.match(seg, /runPendingSend\(record\)/);
  assert.match(store, /optimistic:\s*false/);
});

check('App 启动 hydrate PendingSendStore（注入真实附件暂存）', () => {
  assert.match(app, /pendingSends\.hydrate\(\)/);
  assert.match(app, /new PendingSendStore\(\{/);
  assert.match(app, /ReactNativePendingSendStaging/);
});

check('普通断开连接不清理待发送记录，只有彻底清除授权才清理', () => {
  const signOutStart = app.indexOf('const signOut =');
  const clearStart = app.indexOf('const clearAuthorization =');
  assert.ok(signOutStart >= 0 && clearStart > signOutStart);
  const signOutSeg = app.slice(signOutStart, clearStart);
  assert.doesNotMatch(signOutSeg, /pendingSends\.(clearAll|discardStaged)/);
  const clearSeg = app.slice(clearStart, clearStart + 9000);
  assert.match(clearSeg, /pendingSends\.clearAll\(\)/);
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
