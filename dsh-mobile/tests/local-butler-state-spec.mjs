import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_APPROVAL_AUDIT_KEY,
  MAX_LOCAL_AUDIT,
  loadLocalAudit,
  parseLocalAudit,
  recordLocalAudit,
} from '../src/core/localAudit.ts';
import {
  LOCAL_BUTLER_DRAFT_KEY,
  MAX_LOCAL_DRAFT_CHARS,
  loadLocalButlerDraft,
  parseLocalButlerDraft,
  saveLocalButlerDraft,
} from '../src/core/localButlerDraft.ts';
import { DRAFT_STORAGE_KEY } from '../src/core/draftStore.ts';

function memory(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, async getItem(key) { return map.get(key) ?? null; }, async setItem(key, value) { map.set(key, value); } };
}

const entry = (over = {}) => ({
  taskId: 'task-11111111-1111-4111-8111-111111111111',
  toolName: 'write', decision: 'allowed-once', at: 1, ...over,
});

test('approval audit keeps only bounded, valid entries', () => {
  assert.deepEqual(parseLocalAudit(null), []);
  assert.deepEqual(parseLocalAudit('{'), []);
  assert.deepEqual(parseLocalAudit(JSON.stringify({ taskId: 'x' })), []);
  assert.deepEqual(parseLocalAudit(JSON.stringify([entry({ taskId: 'evil' }), entry({ decision: 'maybe' }), entry()])), [entry()]);
  const many = Array.from({ length: MAX_LOCAL_AUDIT + 20 }, (_, i) => entry({ at: i }));
  assert.equal(parseLocalAudit(JSON.stringify(many)).length, MAX_LOCAL_AUDIT);
});

test('audit records newest first and is capped', async () => {
  const storage = memory();
  for (let i = 0; i < MAX_LOCAL_AUDIT + 5; i += 1) {
    await recordLocalAudit(storage, entry({ at: i, toolName: `tool-${i}` }));
  }
  const rows = await loadLocalAudit(storage);
  assert.equal(rows.length, MAX_LOCAL_AUDIT);
  assert.equal(rows[0].toolName, `tool-${MAX_LOCAL_AUDIT + 4}`);
  assert.equal(rows.at(-1).toolName, 'tool-5');
});

test('audit read/write failures never block the caller', async () => {
  const broken = { async getItem() { throw new Error('down'); }, async setItem() { throw new Error('down'); } };
  assert.deepEqual(await loadLocalAudit(broken), []);
  const rows = await recordLocalAudit(broken, entry());
  assert.equal(rows.length, 1);
});

test('local draft uses its own key and never touches chat drafts', async () => {
  assert.notEqual(LOCAL_BUTLER_DRAFT_KEY, DRAFT_STORAGE_KEY);
  const storage = memory({ [DRAFT_STORAGE_KEY]: JSON.stringify([{ sessionId: 's', text: 'desktop draft', updatedAt: 1 }]) });
  await saveLocalButlerDraft(storage, '本机目标', 42);
  const saved = JSON.parse(storage.map.get(LOCAL_BUTLER_DRAFT_KEY));
  assert.deepEqual(saved, { text: '本机目标', updatedAt: 42 });
  assert.match(storage.map.get(DRAFT_STORAGE_KEY), /desktop draft/);
  assert.deepEqual(await loadLocalButlerDraft(storage), { text: '本机目标', updatedAt: 42 });
});

test('empty drafts clear only the local key, and parsing is tolerant', async () => {
  const storage = memory();
  await saveLocalButlerDraft(storage, 'x', 1);
  await saveLocalButlerDraft(storage, '   ', 2);
  assert.equal(storage.map.get(LOCAL_BUTLER_DRAFT_KEY), '');
  assert.equal(await loadLocalButlerDraft(storage), null);
  assert.equal(parseLocalButlerDraft('nope'), null);
  assert.equal(parseLocalButlerDraft(JSON.stringify({ text: '' })), null);
  const huge = parseLocalButlerDraft(JSON.stringify({ text: 'x'.repeat(MAX_LOCAL_DRAFT_CHARS + 100), updatedAt: 3 }));
  assert.equal(huge.text.length, MAX_LOCAL_DRAFT_CHARS);
});

test('draft storage failures are swallowed', async () => {
  const broken = { async getItem() { throw new Error('down'); }, async setItem() { throw new Error('down'); } };
  assert.equal(await loadLocalButlerDraft(broken), null);
  await saveLocalButlerDraft(broken, 'still fine');
});
