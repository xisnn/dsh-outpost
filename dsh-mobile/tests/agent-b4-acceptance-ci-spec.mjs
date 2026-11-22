/**
 * Rurea B4 回归固化与 C3 验收基建测试（归入 test:agentChain）：
 *
 * 覆盖：
 *   1. 拉起真实 c3-stub-server.mjs 子进程（动态端口 0），通过 HTTP 验证：
 *      - [C3_PERSIST_RUN] 首步下发 workspace_list 只读自主工具调用 SSE；
 *      - 工具回传后流式输出 C3_PERSIST_OK；
 *      - /report 上报/读取与 /reset 重置闭环；
 *   2. run-rurea-acceptance.mjs --dry-run：
 *      - 覆盖 b2 / c1c2c4 / c3 三套件，均锁定隔离包 com.dshoutpost.p1.p6next；
 *      - 验收入口源码与 loopback 桩文件真实存在；
 *      - 非法套件名称 --suite nope 响亮 fail-closed；
 *   3. CI 工作流 (.github/workflows/rurea-acceptance.yml) 与运维规程 (docs/rurea-acceptance-runbook.md)：
 *      - 只读 permissions、零 secrets、零发布动作、不触碰正式包 com.dshpocket、上传产物；
 *      - 规程覆盖 3 套件并显式声明 BLOCKED 清单。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileDir = path.resolve(here, '..');
const repoDir = path.resolve(mobileDir, '..');
const runnerPath = path.join(mobileDir, 'scripts', 'run-rurea-acceptance.mjs');
const c3StubPath = path.join(mobileDir, 'tests', 'acceptance', 'c3-stub-server.mjs');

function httpRequest(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('c3-stub-server serves tool SSE, final text SSE, /report, and /reset cleanly', async () => {
  const { child, baseUrl } = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [c3StubPath, '0'], {
      cwd: mobileDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => reject(new Error('c3-stub-server startup timeout')), 5000);
    proc.stdout.on('data', (chunk) => {
      const m = chunk.toString().match(/listening=(http:\/\/127\.0\.0\.1:\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child: proc, baseUrl: m[1] });
      }
    });
    proc.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  try {
    const step1 = await httpRequest(
      'POST',
      `${baseUrl}/v1/chat/completions`,
      JSON.stringify({ messages: [{ role: 'user', content: '[C3_PERSIST_RUN]' }] }),
    );
    assert.equal(step1.status, 200);
    assert.match(step1.body, /"name":"workspace_list"/);

    const step2 = await httpRequest(
      'POST',
      `${baseUrl}/v1/chat/completions`,
      JSON.stringify({
        messages: [
          { role: 'user', content: '[C3_PERSIST_RUN]' },
          { role: 'tool', content: '["note.txt"]' },
        ],
      }),
    );
    assert.equal(step2.status, 200);
    assert.match(step2.body, /C3_PERSIST_OK/);

    const postRep = await httpRequest('POST', `${baseUrl}/report`, JSON.stringify({ stage: 1, ok: true }));
    assert.equal(postRep.status, 200);

    const getRep = await httpRequest('GET', `${baseUrl}/report`);
    const parsed = JSON.parse(getRep.body);
    assert.equal(parsed.reports.length, 1);
    assert.equal(parsed.reports[0].stage, 1);
    assert.ok(parsed.trace.includes('text:C3_PERSIST_OK'));

    await httpRequest('POST', `${baseUrl}/reset`);
    const afterReset = JSON.parse((await httpRequest('GET', `${baseUrl}/report`)).body);
    assert.equal(afterReset.reports.length, 0);
  } finally {
    child.kill();
  }
});

test('run-rurea-acceptance --dry-run locks isolated package for b2, c1c2c4, and c3 and fails closed on unknown suite', () => {
  for (const [suiteName, wantStages] of [
    ['b2', 1],
    ['c1c2c4', 1],
    ['c3', 4],
  ]) {
    const out = execFileSync(process.execPath, [runnerPath, '--suite', suiteName, '--dry-run'], {
      cwd: mobileDir,
      encoding: 'utf8',
    });
    const cfg = JSON.parse(out);
    assert.equal(cfg.suite, suiteName);
    assert.equal(cfg.applicationId, 'com.dshoutpost.p1.p6next');
    assert.equal(cfg.stages, wantStages);
    assert.equal(cfg.resolvedEntryExists, true);
    assert.equal(cfg.resolvedStubExists, true);
  }

  let failed = false;
  try {
    execFileSync(process.execPath, [runnerPath, '--suite', 'nope', '--dry-run'], {
      cwd: mobileDir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    failed = true;
    assert.notEqual(err.status, 0);
  }
  assert.equal(failed, true, 'expected unknown suite to exit non-zero');
});

test('B4 workflow and runbook isolate verification app, drop secrets, and list explicit BLOCKED items', () => {
  const wfPath = path.join(repoDir, '.github', 'workflows', 'rurea-acceptance.yml');
  assert.equal(existsSync(wfPath), true);
  const wf = readFileSync(wfPath, 'utf8');
  const wfCode = wf
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.match(wfCode, /contents:\s*read/);
  assert.doesNotMatch(wfCode, /secrets\./);
  assert.doesNotMatch(wfCode, /gh release|action-gh-release|softprops/i);
  assert.doesNotMatch(wfCode, /com\.dshpocket/);
  assert.match(wfCode, /run-rurea-acceptance\.mjs\s+--suite\s+c3/);
  assert.match(wfCode, /run-rurea-acceptance\.mjs\s+--suite\s+c1c2c4/);
  assert.match(wfCode, /actions\/upload-artifact@/);

  const runbookPath = path.join(repoDir, 'docs', 'rurea-acceptance-runbook.md');
  assert.equal(existsSync(runbookPath), true);
  const runbook = readFileSync(runbookPath, 'utf8');
  assert.match(runbook, /--suite c3/);
  assert.match(runbook, /--suite c1c2c4/);
  assert.match(runbook, /--suite b2/);
  assert.match(runbook, /com\.dshoutpost\.p1\.p6next/);
  assert.match(runbook, /BLOCKED/);
});
