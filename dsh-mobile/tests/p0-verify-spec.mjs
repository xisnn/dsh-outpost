import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { blockP0Confirmation, unblockP0Confirmation, isP0ConfirmationBlocked, clearP0TestState } =
  await import('../src/dev/p0Verify.ts');

clearP0TestState();
assert.equal(isP0ConfirmationBlocked('req-a'), false);
blockP0Confirmation('req-a');
assert.equal(isP0ConfirmationBlocked('req-a'), true);
assert.equal(isP0ConfirmationBlocked('req-b'), false);
unblockP0Confirmation('req-a');
assert.equal(isP0ConfirmationBlocked('req-a'), false);

const store = readFileSync(new URL('../src/core/store.ts', import.meta.url), 'utf8');
assert.match(store, /shouldDropP0Response\(requestId\)/);
assert.match(store, /armP0TestRequest\(record\.requestId/);
assert.match(store, /unblockP0Confirmation\(requestId\)/);

console.log('结果：3 通过，0 失败');
