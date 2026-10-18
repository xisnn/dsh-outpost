/**
 * 配对文本解析的单测：node tests/pairing-spec.mjs
 *
 * 覆盖扫码 / 剪贴板 / 手填三种来源，以及各种脏粘贴。
 */
import assert from 'node:assert/strict';

const { parsePairingText, normalizeBaseUrl } = await import('../src/core/pairing.ts');

const cases = [
  // [输入, 期望]
  [
    'http://192.168.1.10:3095/?token=abcDEF123456-_xyz',
    { baseUrl: 'http://192.168.1.10:3095', token: 'abcDEF123456-_xyz' },
  ],
  [
    'https://box.tailnet.ts.net:8443/?foo=1&token=tok_123456789012345',
    { baseUrl: 'https://box.tailnet.ts.net:8443', token: 'tok_123456789012345' },
  ],
  ['abcDEF123456-_xyz0000', { token: 'abcDEF123456-_xyz0000' }],
  // 带引号/空白（从终端复制常见）
  ['  "http://h:1/?token=abcdefghijklmnop"  ', { baseUrl: 'http://h:1', token: 'abcdefghijklmnop' }],
  ['“abcdefghijklmnop”', { token: 'abcdefghijklmnop' }],
  // URL 尾部多个斜杠
  ['http://h:1///?token=abcdefghijklmnop', { baseUrl: 'http://h:1', token: 'abcdefghijklmnop' }],
];

let passed = 0;
for (const [input, expected] of cases) {
  const got = parsePairingText(input);
  assert.deepEqual(got, expected, `解析失败: ${JSON.stringify(input)} -> ${JSON.stringify(got)}`);
  passed += 1;
}

// 认不出来的要返回 null，不能瞎猜
for (const bad of ['', '   ', 'hello world', '只有中文', 'http://h:1/no-token-here']) {
  assert.equal(parsePairingText(bad), null, `不该认出: ${JSON.stringify(bad)}`);
  passed += 1;
}

assert.equal(normalizeBaseUrl('http://h:1///'), 'http://h:1');
passed += 1;

console.log(`结果：${passed} 通过，0 失败`);
