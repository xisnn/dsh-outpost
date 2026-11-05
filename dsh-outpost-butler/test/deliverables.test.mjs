import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describeDeliverable } from '../lib/deliverables.js';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'outpost-deliverables-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  await mkdir(cwd);
  return { root, cwd };
}

test('presented file has size, SHA-256 and a workspace-relative download path', async (t) => {
  const { cwd } = await workspace(t);
  const text = '交付物内容\n';
  await writeFile(path.join(cwd, 'report.md'), text);
  const file = await describeDeliverable(cwd, { path: 'report.md', description: 'report' });
  assert.equal(file.size, Buffer.byteLength(text));
  assert.equal(file.sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(file.relativePath, 'report.md');
  assert.equal(file.description, 'report');
});

test('absolute file inside workspace is usable and an empty file has a valid digest', async (t) => {
  const { cwd } = await workspace(t);
  const absolute = path.join(cwd, 'empty.txt');
  await writeFile(absolute, '');
  const file = await describeDeliverable(cwd, { path: absolute });
  assert.equal(file.size, 0);
  assert.equal(file.relativePath, 'empty.txt');
  assert.equal(file.sha256, createHash('sha256').update('').digest('hex'));
});

test('missing file is visible as unavailable rather than a false download link', async (t) => {
  const { cwd } = await workspace(t);
  const file = await describeDeliverable(cwd, { path: 'missing.txt' });
  assert.equal(file.unavailableReason, 'unreadable');
  assert.equal(file.sha256, undefined);
});

test('traversal and directory junction escapes do not acquire file metadata', async (t) => {
  const { root, cwd } = await workspace(t);
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'private.txt'), 'outside');
  assert.equal((await describeDeliverable(cwd, { path: '../outside/private.txt' })).unavailableReason, 'outside-workspace');
  await symlink(outside, path.join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await describeDeliverable(cwd, { path: 'link/private.txt' })).unavailableReason, 'outside-workspace');
});

test('presenting an updated file produces its new digest', async (t) => {
  const { cwd } = await workspace(t);
  await writeFile(path.join(cwd, 'report.md'), 'first');
  const first = await describeDeliverable(cwd, { path: 'report.md' });
  await writeFile(path.join(cwd, 'report.md'), 'second');
  const second = await describeDeliverable(cwd, { path: 'report.md' });
  assert.notEqual(first.sha256, second.sha256);
  assert.equal(second.size, 6);
});
