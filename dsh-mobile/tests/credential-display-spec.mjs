import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import {
  findCredentials,
  displayCredentials,
  maskCredentials,
} from '../src/core/credentialDisplay.ts';

// Constructed examples only; none are issued credentials or usable key material.
const body = 'FabricatedOnly0123456789';
const token = `sk-${body}`;
const jwt = 'eyJub3RSZWFsIjoxfQ.eyJmYWtlIjoiZml4dHVyZSJ9.U2lnbmF0dXJlRm9yVGVzdA';
const hidden = index => `〔凭据 ${index + 1} 已隐藏〕`;
const slices = text => findCredentials(text).map(({ start, end }) => text.slice(start, end));

for (const prefix of [
  'sk-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_',
  'glpat-', 'npm_', 'hf_', 'sk_live_', 'sk_test_', 'rk_',
  'rk_live_', 'rk_test_', 'whsec_',
  'xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-', 'xoxc-', 'xoxe-',
]) {
  test(`hides complete fabricated ${prefix} token without retaining its prefix`, () => {
    const value = prefix + body;
    const text = `before (${value}), after`;
    assert.deepEqual(slices(text), [value]);
    assert.equal(maskCredentials(text), `before (${hidden(0)}), after`);
  });
}

test('recognizes length boundaries, Google keys and uppercase AWS identifiers', () => {
  for (const value of [
    `sk-${'A'.repeat(20)}`, `github_pat_${'a'.repeat(20)}`,
    `AIza${'A'.repeat(35)}`, `AKIA${'A1'.repeat(8)}`, `ASIA${'B2'.repeat(8)}`,
  ]) assert.deepEqual(slices(value), [value]);
  for (const value of [
    `sk-${'A'.repeat(19)}`, `ghp_${'a'.repeat(19)}`, `hf_${'a'.repeat(19)}`,
    `xoxb-${'a'.repeat(19)}`, `whsec_${'a'.repeat(19)}`,
    `AIza${'A'.repeat(34)}`, `AIza${'A'.repeat(36)}`,
    `AKIA${'A'.repeat(15)}`, `ASIA${'A'.repeat(17)}`, `AKIA${'a'.repeat(16)}`,
  ]) assert.deepEqual(findCredentials(value), [], value);
});

test('token alphabet includes underscores and hyphens without truncation', () => {
  const value = 'sk-proj_Fabricated-Only_0123456789';
  assert.deepEqual(slices(value), [value]);
  assert.equal(maskCredentials(value), hidden(0));
});

test('ordinary words, short examples and arbitrary passwords remain unchanged', () => {
  const examples = [
    '', 'Discuss password management and private keys, please.',
    'password=hunter2; API_KEY=some-arbitrary-value',
    'Bearer ordinary prose about bearers', 'sk-short ghp_short npm_install hf_model',
    `prefix${token}`, `prefix_${token}`, `prefix-${token}`, `x${jwt}`,
    '-----BEGIN PUBLIC KEY-----\nnot-a-private-key\n-----END PUBLIC KEY-----',
    '-----BEGIN PRIVATE KEY---- malformed marker',
    'password outside a URL',
  ];
  for (const text of examples) {
    assert.deepEqual(findCredentials(text), [], text);
    assert.equal(maskCredentials(text), text);
  }
});

test('CJK prose and other non-ASCII letters may touch credentials without preventing protection', () => {
  for (const [before, after] of [['密钥是', '请保管'], ['𐐀', '文字'], ['我的 Token：', '']]) {
    const text = before + token + after;
    assert.deepEqual(slices(text), [token]);
    assert.equal(maskCredentials(text), before + hidden(0) + after);
  }
  assert.equal(maskCredentials('中文Authorization: Bearer fake'), '中文Authorization: Bearer ' + hidden(0));
});

test('JWT detection requires three plausible base64url segments and eyJ prefix', () => {
  assert.deepEqual(slices(`JWT: ${jwt}.`), [jwt]);
  assert.equal(maskCredentials(`JWT: ${jwt}.`), `JWT: ${hidden(0)}.`);
  for (const value of [
    'eyJshort.payload', 'eyJshort.tiny.signature',
    'eyJshort.payloadxx.short', 'YWJjZGVmZw.payloadxx.signaturexx',
    'eyJshort.payload+xx.signaturexx', 'eyJshort..signaturexx',
  ]) assert.deepEqual(findCredentials(value), [], value);
});

test('URL masking hides only the raw password and retains Unicode and escapes', () => {
  for (const password of [
    'password', '伪造🔒口令', 'fake%40secret%3Avalue', 'fake:with:colons',
  ]) {
    const prefix = '🧪 \t链接 https://用户:';
    const suffix = '@例子.invalid:443/path?q=保留#片段\r\n结束';
    const text = prefix + password + suffix;
    assert.deepEqual(findCredentials(text), [{ start: prefix.length, end: prefix.length + password.length }]);
    assert.equal(maskCredentials(text), prefix + hidden(0) + suffix);
  }
  assert.equal(maskCredentials('postgresql+test://user:fake-secret@localhost/db'),
    `postgresql+test://user:${hidden(0)}@localhost/db`);
});

test('URL detector leaves absent passwords and non-authority text intact', () => {
  for (const text of [
    'https://example.invalid/path:user@host',
    'https://example.invalid?user:fake@host', 'https://user@example.invalid',
    'https://user:@example.invalid', 'https://user:fake@',
    'https://:fake@example.invalid', 'user:fake@example.invalid',
    'https://user:fake secret@example.invalid', '1http://user:fake@example.invalid',
  ]) assert.deepEqual(findCredentials(text), [], text);
});

test('Authorization Bearer masks the entire value with casing and tabs preserved', () => {
  const text = '🧪\r\naUtHoRiZaTiOn\t: \tbeArEr\tFAKE+/opaque-token==\r\nNext: keep';
  assert.deepEqual(slices(text), ['FAKE+/opaque-token==']);
  assert.equal(maskCredentials(text), `🧪\r\naUtHoRiZaTiOn\t: \tbeArEr\t${hidden(0)}\r\nNext: keep`);
  assert.equal(maskCredentials('Authorization: Bearer FAKE-value, next'),
    `Authorization: Bearer ${hidden(0)}, next`);
  for (const value of ['Authorization: Bearer\r\nordinary text', 'Authorization: Basic fake',
    'myAuthorization: Bearer fake']) {
    assert.deepEqual(findCredentials(value), []);
  }
});

test('closed private key blocks include markers and retain outside CRLF', () => {
  for (const label of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY',
    'ENCRYPTED PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'DSA PRIVATE KEY']) {
    const pem = `-----BEGIN ${label}-----\r\nFABRICATED-NOT-KEY-DATA\r\n-----END ${label}-----`;
    const text = `keep\r\n${pem}\r\nkeep too`;
    assert.deepEqual(slices(text), [pem]);
    assert.equal(maskCredentials(text), `keep\r\n${hidden(0)}\r\nkeep too`);
  }
});

test('unclosed private key masks everything to EOF including unrelated-looking text', () => {
  for (const tail of ['', '\r\nFABRICATED\r\nlast line',
    '\n-----END PUBLIC KEY-----\nother text', '\n-----END RSA PRIVATE KEY-----']) {
    const text = `keep\r\n-----BEGIN PRIVATE KEY-----${tail}`;
    assert.deepEqual(findCredentials(text), [{ start: 6, end: text.length }]);
    assert.equal(maskCredentials(text), `keep\r\n${hidden(0)}`);
  }
});

test('multiple PEM blocks remain separate and the matching label closes each', () => {
  const a = '-----BEGIN EC PRIVATE KEY-----\nx\n-----END EC PRIVATE KEY-----';
  const b = '-----BEGIN RSA PRIVATE KEY-----\ny\n-----END RSA PRIVATE KEY-----';
  assert.deepEqual(slices(`${a}\r\nvisible\r\n${b}`), [a, b]);
  assert.equal(maskCredentials(`${a}\r\nvisible\r\n${b}`), `${hidden(0)}\r\nvisible\r\n${hidden(1)}`);
});

test('overlapping URL, token, JWT, bearer and PEM detections merge without leaks', () => {
  const password = `prefix:${token}`;
  const url = `https://user:${password}@host.invalid`;
  assert.deepEqual(slices(url), [password]);
  assert.equal(maskCredentials(url), `https://user:${hidden(0)}@host.invalid`);
  const bearer = `Authorization: Bearer ${url}`;
  assert.deepEqual(slices(bearer), [url]);
  assert.equal(maskCredentials(bearer), `Authorization: Bearer ${hidden(0)}`);
  const pem = `-----BEGIN PRIVATE KEY-----\r\n${url}\r\n${jwt}\r\n${bearer}\r\n-----END PRIVATE KEY-----`;
  assert.deepEqual(findCredentials(pem), [{ start: 0, end: pem.length }]);
  assert.equal(maskCredentials(pem), hidden(0));
});

test('ranges are sorted and disjoint even when detection passes discover them out of order', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----';
  const text = `${token}\nhttps://user:fake-pass@host.invalid\n${pem}\n${jwt}`;
  assert.deepEqual(slices(text), [token, 'fake-pass', pem, jwt]);
  const ranges = findCredentials(text);
  for (let index = 1; index < ranges.length; index++) {
    assert.ok(ranges[index - 1].end <= ranges[index].start);
  }
  assert.equal(maskCredentials(text),
    `${hidden(0)}\nhttps://user:${hidden(1)}@host.invalid\n${hidden(2)}\n${hidden(3)}`);
});

test('UTF-16 offsets and each zero-based reveal index reconstruct the original exactly', () => {
  const text = `😀\t${token}\r\n中文 ${jwt}  \r\nend`;
  const original = text;
  const ranges = Object.freeze(findCredentials(text).map(range => Object.freeze(range)));
  const snapshot = JSON.stringify(ranges);
  const revealed = new Set([1]);
  assert.equal(ranges[0].start, 3);
  assert.equal(displayCredentials(text, ranges), `😀\t${hidden(0)}\r\n中文 ${hidden(1)}  \r\nend`);
  assert.equal(displayCredentials(text, ranges, revealed), `😀\t${hidden(0)}\r\n中文 ${jwt}  \r\nend`);
  assert.equal(displayCredentials(text, ranges, new Set([0])), `😀\t${token}\r\n中文 ${hidden(1)}  \r\nend`);
  assert.equal(displayCredentials(text, ranges, new Set([0, 1])), original);
  assert.equal(displayCredentials(text, ranges, new Set([99])), maskCredentials(text));
  assert.equal(JSON.stringify(ranges), snapshot);
  assert.deepEqual([...revealed], [1]);
  assert.equal(text, original);
  assert.equal(displayCredentials(' \r\n😀\t', []), ' \r\n😀\t');
});

test('adjacent supplied ranges keep their individual disclosure indices', () => {
  const ranges = [{ start: 0, end: 2 }, { start: 2, end: 4 }];
  assert.equal(displayCredentials('abcd', ranges), hidden(0) + hidden(1));
  assert.equal(displayCredentials('abcd', ranges, new Set([1])), hidden(0) + 'cd');
});

test('invalid caller ranges fail instead of silently leaking partial content', () => {
  for (const ranges of [
    [{ start: -1, end: 2 }], [{ start: 0, end: 5 }], [{ start: 1.5, end: 2 }],
    [{ start: 2, end: 2 }], [{ start: NaN, end: 2 }],
    [{ start: 1, end: 3 }, { start: 2, end: 4 }],
    [{ start: 2, end: 4 }, { start: 0, end: 1 }],
  ]) assert.throws(() => displayCredentials('abcd', ranges), RangeError);
});

test('large malformed inputs and many findings finish without catastrophic rescanning', { timeout: 10000 }, () => {
  const malformed = 'eyJ'.repeat(220000) + ' ' + 'a-'.repeat(330000) +
    ' not-a-url ' + 'https://user:'.repeat(18000) + '\r\n';
  const text = malformed + `${token} ordinary prose\r\n`.repeat(4000);
  const started = performance.now();
  const ranges = findCredentials(text);
  const masked = displayCredentials(text, ranges);
  assert.equal(ranges.length, 4000);
  assert.ok(!masked.includes(token));
  assert.ok(masked.startsWith(malformed));
  assert.ok(performance.now() - started < 5000, 'scan should finish within a generous five-second budget');
});
