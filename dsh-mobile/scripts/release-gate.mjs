#!/usr/bin/env node
/**
 * Release-candidate APK gate.
 *
 * P6 default:
 *   node scripts/release-gate.mjs --apk app-release.apk --abis arm64,x86_64
 * Legacy runtime fallback:
 *   node scripts/release-gate.mjs --apk app-release.apk --abis arm64,x86_64 --legacy-runtime
 *
 * P6 gate checks ABI coverage, required React Native libraries, the Hermes JS
 * bundle, APK size, and (by default) that the signer matches the recorded
 * release certificate. `--allow-test-signing` accepts the recorded debug certs
 * for test-only builds and marks the result testOnly. `--skip-signing` only
 * avoids running apksigner; it reports signing.skipped and fails the gate,
 * because an unverified signer is not a passing one.
 *
 * The old DSH runtime/proot assets are no longer required by P6; they are only
 * checked with --legacy-runtime. This keeps the gate aligned with the entry fix
 * instead of rejecting every P6 package for missing proot files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const apk = path.resolve(arg('--apk', 'android/app/build/outputs/apk/release/app-release.apk'));
const abis = (arg('--abis', '') || '').split(',').map(value => value.trim()).filter(Boolean);
const budgetsPath = arg('--budgets', '.github/release-budgets.json');
const budgets = JSON.parse(fs.readFileSync(budgetsPath, 'utf8'));
const legacyRuntime = process.argv.includes('--legacy-runtime');
const allowTestSigning = process.argv.includes('--allow-test-signing');
const signingConfigPath = arg('--signing-config', '.github/release-signing.json');
const required = legacyRuntime
  ? ['libdsh-runtime-runner.so', 'libproot.so', 'libproot-loader.so', 'libtalloc.so', 'libandroid-shmem.so']
  : ['libreactnative.so', 'libhermes.so'];
const entries = execFileSync('jar', ['tf', apk], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split(/\r?\n/).filter(Boolean);
const apkAbis = [...new Set(entries.filter(name => name.startsWith('lib/')).map(name => name.split('/')[1]))].sort();
const missing = [];
for (const abi of abis) {
  for (const lib of required) if (!entries.includes(`lib/${abi}/${lib}`)) missing.push(`${abi}/${lib}`);
}
const missingManifests = [];
const mismatchedManifests = [];
if (legacyRuntime) {
  for (const abi of abis) {
    const name = `assets/dsh-runtime/p1-verification-${abi}.json`;
    if (!entries.includes(name)) { missingManifests.push(name); continue; }
    try {
      const manifest = JSON.parse(execFileSync('unzip', ['-p', apk, name], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
      if (manifest.abi !== abi) mismatchedManifests.push({ name, abi: manifest.abi });
    } catch (error) {
      missingManifests.push(`${name} (unreadable: ${String(error.message).slice(0, 120)})`);
    }
  }
}
const bundlePresent = entries.includes('assets/index.android.bundle');
const bytes = fs.statSync(apk).size;
const abiPass = abis.length > 0 && abis.every(abi => apkAbis.includes(abi)) &&
  missing.length === 0 && missingManifests.length === 0 && mismatchedManifests.length === 0;
const sizePass = bytes <= budgets.apkBytesMax;
const bundlePass = bundlePresent;

function findApksigner() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) return null;
  const tools = path.join(sdk, 'build-tools');
  if (!fs.existsSync(tools)) return null;
  const versions = fs.readdirSync(tools).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(tools, version, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// An unchecked signature must not read as a passed one: the overall gate ANDs
// signing.pass, so skipping the check has to fail the build instead of waving
// it through. abiPass/sizePass/bundlePass remain available separately.
let signing = { checked: false, skipped: true, pass: false, digests: [], testOnly: false };
if (!process.argv.includes('--skip-signing')) {
  try {
    const config = JSON.parse(fs.readFileSync(path.resolve(signingConfigPath), 'utf8'));
    const apksigner = findApksigner();
    if (!apksigner) throw new Error('apksigner not found; set ANDROID_HOME');
    const output = execFileSync(apksigner, ['verify', '--print-certs', apk], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
    const digests = [...output.matchAll(/certificate SHA-256 digest: ([0-9a-f]{64})/gi)].map(match => match[1].toLowerCase());
    const knownGood = new Set((config.knownGoodCertificateSha256 || []).map(value => value.toLowerCase()));
    const testCerts = new Set((config.testOnlyDebugCertificates || []).map(value => value.toLowerCase()));
    const testOnly = digests.some(digest => testCerts.has(digest));
    const knownGoodMatch = digests.some(digest => knownGood.has(digest));
    signing = {
      checked: true,
      skipped: false,
      digests,
      testOnly,
      pass: knownGoodMatch || (allowTestSigning && testOnly),
    };
  } catch (error) {
    signing = { checked: true, skipped: false, pass: false, digests: [], testOnly: false, error: String(error.message).slice(0, 300) };
  }
}

const result = {
  formatVersion: 1, apk, mode: legacyRuntime ? 'legacy-runtime' : 'p6',
  bytes, abis, apkAbis, requiredLibraries: required,
  missingLibraries: missing, missingManifests, mismatchedManifests,
  bundlePresent, bundlePass, signing,
  budget: { apkBytesMax: budgets.apkBytesMax }, abiPass, sizePass,
  pass: abiPass && sizePass && bundlePass && signing.pass,
};
const out = arg('--json');
if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exitCode = 1;
