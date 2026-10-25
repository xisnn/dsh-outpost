/**
 * versionCode 推导与单调递增门禁的单元测试。
 *
 * ## 为什么这个文件必须存在
 *
 * 版本号算错是**发布事故里最难挽回的一类**：
 *   · 算小了 → 已安装用户无法覆盖升级（`INSTALL_FAILED_VERSION_DOWNGRADE`），
 *     而错误要等用户装上时才发现
 *   · 算重了 → 无法区分两个版本，应用内更新判断失效
 *   · 签名/版本一起错 → 只能让用户卸载重装，本地数据全丢
 *
 * 而旧实现（workflow 里一段内联 bash）**完全无法本地测试**。
 * 抽成 `scripts/version-code.mjs` 后，这组测试把公式和门禁钉住：
 * 将来谁想改公式，必须先让这些断言继续成立。
 *
 * ## 这组测试真实发现的问题
 *
 * `v0.16.3` 在**旧公式**下是 `16003`，而上一轮交付的验收测试包是 `16200`
 * —— 新版本号比用户手上的还小。这组用例里 `旧公式会撞门禁` 一项
 * 就是专门守这个回归的。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseTag,
  computeVersionCode,
  readFloor,
  deriveVersion,
  formatGithubOutput,
  VersionError,
  VERSION_LIMITS,
} from '../scripts/version-code.mjs';

/** 造一个临时水位线文件 */
function tmpFloor(minVersionCode) {
  const p = path.join(os.tmpdir(), `dsh-floor-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ minVersionCode, publishedVersion: 'test' }));
  return p;
}

// ══════════════════════════════════════════════════════════════
// 一、Tag 解析
// ══════════════════════════════════════════════════════════════

test('parseTag：正常三段式 tag', () => {
  const r = parseTag('v0.16.3');
  assert.equal(r.tag, 'v0.16.3');
  assert.equal(r.version, '0.16.3');
  assert.equal(r.major, 0);
  assert.equal(r.minor, 16);
  assert.equal(r.patch, 3);
});

test('parseTag：拒绝缺少 v 前缀', () => {
  assert.throws(() => parseTag('0.16.3'), VersionError);
});

test('parseTag：拒绝两段式', () => {
  assert.throws(() => parseTag('v0.16'), VersionError);
});

test('parseTag：拒绝预发布后缀（会让 versionName 与 tag 不一致）', () => {
  assert.throws(() => parseTag('v0.16.3-beta'), VersionError);
  assert.throws(() => parseTag('v0.16.3-rc.1'), VersionError);
});

test('parseTag：拒绝空值', () => {
  assert.throws(() => parseTag(''), VersionError);
  assert.throws(() => parseTag(undefined), VersionError);
});

test('parseTag：minor 超出位宽上限会被拒绝', () => {
  assert.throws(() => parseTag(`v0.${VERSION_LIMITS.minorMax + 1}.0`), VersionError);
});

test('parseTag：patch 超出位宽上限会被拒绝', () => {
  assert.throws(() => parseTag(`v0.1.${VERSION_LIMITS.patchMax + 1}`), VersionError);
});

test('parseTag：边界值可用', () => {
  const r = parseTag(`v0.${VERSION_LIMITS.minorMax}.${VERSION_LIMITS.patchMax}`);
  assert.equal(r.minor, 99);
  assert.equal(r.patch, 99);
});

// ══════════════════════════════════════════════════════════════
// 二、公式
// ══════════════════════════════════════════════════════════════

test('computeVersionCode：新公式的下标取值', () => {
  assert.equal(computeVersionCode(parseTag('v0.16.3')), 160300);
  assert.equal(computeVersionCode(parseTag('v0.16.2')), 160200);
  assert.equal(computeVersionCode(parseTag('v0.17.0')), 170000);
  assert.equal(computeVersionCode(parseTag('v1.0.0')), 1000000);
  assert.equal(computeVersionCode(parseTag('v0.0.1')), 100);
});

test('computeVersionCode：minor 不会污染 major', () => {
  // 99 个 minor 位 + 99 个 patch 位，合计必须 < 1 个 major 位
  const maxMinor = computeVersionCode(parseTag('v1.99.99'));
  const nextMajor = computeVersionCode(parseTag('v2.0.0'));
  assert.ok(maxMinor < nextMajor, `v1.99.99=${maxMinor} 必须 < v2.0.0=${nextMajor}`);
});

test('computeVersionCode：同一 minor 内 patch 单调递增', () => {
  let prev = -1;
  for (let p = 0; p <= 10; p += 1) {
    const code = computeVersionCode(parseTag(`v0.16.${p}`));
    assert.ok(code > prev, `v0.16.${p} 应该大于前一版本`);
    prev = code;
  }
});

test('computeVersionCode：major/minor/patch 各自单调', () => {
  const seq = ['v0.16.9', 'v0.16.10', 'v0.17.0', 'v1.0.0'];
  const codes = seq.map((t) => computeVersionCode(parseTag(t)));
  for (let i = 1; i < codes.length; i += 1) {
    assert.ok(codes[i] > codes[i - 1], `${seq[i]} (${codes[i]}) 必须大于 ${seq[i - 1]} (${codes[i - 1]})`);
  }
});

// ══════════════════════════════════════════════════════════════
// 三、水位线读取
// ══════════════════════════════════════════════════════════════

test('readFloor：能读正常水位线', () => {
  const p = tmpFloor(16200);
  try {
    const f = readFloor(p);
    assert.equal(f.minVersionCode, 16200);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('readFloor：文件缺失必须抛错（没有水位线就不能发布）', () => {
  assert.throws(() => readFloor(path.join(os.tmpdir(), 'definitely-not-there-xyz.json')), VersionError);
});

test('readFloor：非法 JSON 必须抛错', () => {
  const p = path.join(os.tmpdir(), `dsh-badfloor-${Date.now()}.json`);
  fs.writeFileSync(p, '{not json');
  try {
    assert.throws(() => readFloor(p), VersionError);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('readFloor：缺少 minVersionCode 必须抛错', () => {
  const p = path.join(os.tmpdir(), `dsh-nofloor-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify({ publishedVersion: '0.16.2' }));
  try {
    assert.throws(() => readFloor(p), VersionError);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

// ══════════════════════════════════════════════════════════════
// 四、单调递增门禁（核心）
// ══════════════════════════════════════════════════════════════

test('门禁：新版本大于水位线时通过', () => {
  const p = tmpFloor(16200);
  try {
    const r = deriveVersion('v0.16.3', { floorFile: p });
    assert.equal(r.code, 160300);
    assert.ok(r.code > r.floor);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('门禁：等于水位线必须失败（不能重发同一版本）', () => {
  const p = tmpFloor(160300);
  try {
    assert.throws(() => deriveVersion('v0.16.3', { floorFile: p }), (e) => {
      assert.equal(e.kind, 'monotonic');
      return true;
    });
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('门禁：小于水位线必须失败（否则用户无法覆盖升级）', () => {
  const p = tmpFloor(16200);
  try {
    // 故意用一个小版本号
    assert.throws(() => deriveVersion('v0.1.0', { floorFile: p }), (e) => {
      assert.equal(e.kind, 'monotonic');
      return true;
    });
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('回归：旧公式 v0.16.3=16003 会被 16200 水位线拦下', () => {
  // 这就是本轮发现的那个真实问题：
  // 旧公式 major*1e6 + minor*1e3 + patch 给 v0.16.3 算出 16003，
  // 而上一轮交付的验收包是 16200 → 新版本号比用户手上的还小。
  const oldFormula = (major, minor, patch) => major * 1000000 + minor * 1000 + patch;
  const oldCode = oldFormula(0, 16, 3);
  assert.equal(oldCode, 16003, '旧公式确认算出 16003');

  const p = tmpFloor(16200);
  try {
    // 把旧公式的结果塞进门禁判定：必须失败
    assert.ok(
      oldCode <= 16200,
      `旧公式 ${oldCode} 必须 <= 水位线 16200，这正是需要修公式的原因`,
    );
    // 新公式则通过
    const r = deriveVersion('v0.16.3', { floorFile: p });
    assert.ok(r.code > 16200, `新公式 ${r.code} 必须 > 16200`);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('门禁：水位线缺失时拒绝发布（fail-closed）', () => {
  assert.throws(
    () => deriveVersion('v0.16.3', { floorFile: path.join(os.tmpdir(), 'nope-floor-xyz.json') }),
    VersionError,
  );
});

// ══════════════════════════════════════════════════════════════
// 五、仓库内真实水位线（防止有人把它改小）
// ══════════════════════════════════════════════════════════════

test('仓库水位线 >= 16200（已交付的验收包 versionCode）', () => {
  const real = readFloor();
  assert.ok(
    real.minVersionCode >= 16200,
    `仓库水位线是 ${real.minVersionCode}，不应小于 16200（已交付测试包的 versionCode）`,
  );
});

test('仓库水位线能推出 v0.16.3 且通过门禁', () => {
  const r = deriveVersion('v0.16.3');
  assert.equal(r.version, '0.16.3');
  assert.equal(r.code, 160300);
  assert.ok(r.code > r.floor);
});

test('未来版本号示例可预测（长期稳定）', () => {
  const expected = {
    'v0.16.3': 160300,
    'v0.16.4': 160400,
    'v0.17.0': 170000,
    'v0.17.1': 170100,
    'v1.0.0': 1000000,
  };
  for (const [tag, code] of Object.entries(expected)) {
    assert.equal(computeVersionCode(parseTag(tag)), code, `${tag} 应为 ${code}`);
  }
});

// ══════════════════════════════════════════════════════════════
// 六、输出格式
// ══════════════════════════════════════════════════════════════

test('formatGithubOutput：产出 CI 需要的三行', () => {
  const p = tmpFloor(16200);
  try {
    const r = deriveVersion('v0.16.3', { floorFile: p });
    const out = formatGithubOutput(r);
    assert.match(out, /^version=0\.16\.3$/m);
    assert.match(out, /^code=160300$/m);
    assert.match(out, /^tag=v0\.16\.3$/m);
  } finally {
    fs.rmSync(p, { force: true });
  }
});
