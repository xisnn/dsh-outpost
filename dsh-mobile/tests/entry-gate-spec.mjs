import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldEnterApp } from '../src/core/entryGate.ts';

test('paired users always enter the app regardless of butler settings', () => {
  for (const location of ['desktop', 'local']) {
    for (const butlerMode of [true, false]) {
      assert.equal(shouldEnterApp({ authed: true, location, butlerMode }), true);
    }
  }
});

test('unpaired users enter only in local butler mode', () => {
  assert.equal(shouldEnterApp({ authed: false, location: 'local', butlerMode: true }), true);
  assert.equal(shouldEnterApp({ authed: false, location: 'local', butlerMode: false }), false);
  assert.equal(shouldEnterApp({ authed: false, location: 'desktop', butlerMode: true }), false);
  assert.equal(shouldEnterApp({ authed: false, location: 'desktop', butlerMode: false }), false);
});
