/**
 * PendingSend 指纹与 requestId 生成测试。
 *
 * 核心：
 *   · 文本/附件内容变化必须产生不同指纹；
 *   · 指纹相同**不代表**可以自动复用 ID（由 store 测试覆盖）；
 *   · 每次 createRequestId 生成新 ID。
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imp = (p) => import(pathToFileURL(p).href);
const {
  computeSendFingerprint,
  normalizeSendText,
  sameAttachmentIdentity,
  sha256Hex,
  utf8ByteLength,
} = await imp(path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'fingerprint.ts'));
const { createRequestId, __resetRequestIdCounterForTest } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'pendingSend', 'ids.ts'),
);

const A = {
  kind: 'file',
  name: 'a.txt',
  size: 3,
  mime: 'text/plain',
  contentSha256: sha256Hex('abc'),
};
const B = {
  kind: 'image',
  name: 'b.png',
  size: 4,
  mime: 'image/png',
  contentSha256: sha256Hex('defg'),
};

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

check('normalizeSendText：trim + 统一换行', () => {
  assert.equal(normalizeSendText('  a\r\nb  '), 'a\nb');
  assert.equal(normalizeSendText('a\rb'), 'a\nb');
});

check('utf8ByteLength 中文/emoji 正确', () => {
  assert.equal(utf8ByteLength('abc'), 3);
  assert.equal(utf8ByteLength('中文'), 6);
  assert.equal(utf8ByteLength('😀'), 4);
});

check('sha256Hex 稳定且符合已知值', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

check('相同文本/附件/模式 → 相同指纹', () => {
  const x = computeSendFingerprint(' hello ', 'queue', [A, B]);
  const y = computeSendFingerprint('hello', 'queue', [A, B]);
  assert.equal(x, y);
  assert.equal(x.length, 64);
});

check('改文字 → 指纹变化', () => {
  assert.notEqual(computeSendFingerprint('hello', 'queue', [A]), computeSendFingerprint('hello2', 'queue', [A]));
});

check('改附件内容（同名同大小）→ 指纹变化', () => {
  const changed = { ...A, contentSha256: sha256Hex('abd') };
  assert.notEqual(computeSendFingerprint('hello', 'queue', [A]), computeSendFingerprint('hello', 'queue', [changed]));
});

check('改附件顺序 → 指纹变化', () => {
  assert.notEqual(computeSendFingerprint('hello', 'queue', [A, B]), computeSendFingerprint('hello', 'queue', [B, A]));
});

check('改发送模式 → 指纹变化', () => {
  assert.notEqual(computeSendFingerprint('hello', 'queue', [A]), computeSendFingerprint('hello', 'steer', [A]));
});

check('sameAttachmentIdentity 对内容哈希敏感', () => {
  assert.equal(sameAttachmentIdentity([A, B], [{ ...A }, { ...B }]), true);
  assert.equal(sameAttachmentIdentity([A], [{ ...A, contentSha256: sha256Hex('changed') }]), false);
});

check('createRequestId 每次生成新 ID（即使 now/random 固定）', () => {
  __resetRequestIdCounterForTest();
  const now = () => 1700000000000;
  const random = () => 0.5;
  const ids = new Set();
  for (let i = 0; i < 100; i += 1) ids.add(createRequestId(now, random));
  assert.equal(ids.size, 100);
});

check('createRequestId 格式含时间戳/计数/随机段', () => {
  __resetRequestIdCounterForTest();
  const id = createRequestId(() => 1700000000000, () => 0.25);
  assert.match(id, /^req-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
