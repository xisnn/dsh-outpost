/**
 * 签名验证工作流的门禁逻辑回归测试。
 *
 * ## 守什么
 *
 * 1. **v2/v3 签名方案必须按 `: true` / `: false` 判定**
 *
 *    `apksigner verify --verbose` 对**每个**方案都会打印一行：
 *
 *      Verified using v1 scheme (JAR signing): false
 *      Verified using v2 scheme (APK Signature Scheme v2): true
 *      Verified using v3 scheme (APK Signature Scheme v3): false
 *
 *    所以 `grep -q 'Verified using v2'` 会匹配到 `...: false` 那行 ——
 *    **没签名的包也会被判成「有 v2 签名」**，门禁形同虚设。
 *    必须匹配行尾的 `: true`。
 *
 * 2. **总体结论必须覆盖所有必需门禁**
 *
 *    之前只检查 cert + build，于是「包名版本错」「没 v2」「更新完整性挂」
 *    「负向测试没过」都不影响结论。
 *
 * 3. **公开仓库不得上传真实签名 APK**
 *
 *    Actions Artifact 的访问粒度是整个仓库，不是单个 Artifact。
 *    文件名加 `NOT-FOR-RELEASE` 只是提示，不是权限隔离。
 *
 * 4. **可选 Debug 构建要区分「未启用」与「失败」**
 *
 * 5. **高 versionCode 测试包的副作用**必须写进报告（见 §4）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
const ok = (n) => {
  pass += 1;
  console.log('  OK    ' + n);
};
const bad = (n, d) => {
  fail += 1;
  console.log('  FAIL  ' + n + (d ? ' — ' + d : ''));
};
const check = (c, n, d) => (c ? ok(n) : bad(n, d));

const repo = path.resolve(import.meta.dirname, '..', '..');
const wfPath = path.join(repo, '.github', 'workflows', 'signing-verify.yml');
const wf = readFileSync(wfPath, 'utf8');
const report = readFileSync(path.join(repo, 'DSH-OUTPOST-FINAL-RELEASE-ACCEPTANCE.md'), 'utf8');

console.log('');
console.log('── 1. v2/v3 必须按 : true / : false 判定 ──');

check(
  /grep -qE '\^Verified using v2 scheme \.\*: true\$'/.test(wf),
  'v2 用锚定的 ": true$" 正则（不是裸 grep 前缀）',
);
// 只禁止**用于判定**的裸 grep（`grep -q 'Verified using v2'`）；
// cert 步骤里有一处纯诊断打印 `grep -E 'Verified using v[123]' ... || true`，
// 不参与任何 if 判定，允许保留。
check(
  !/if\s+grep\s+-q\s+'Verified using v2'/.test(wf) &&
    !/grep\s+-q\s+'Verified using v2'.*;?\s*then/.test(wf),
  '判定逻辑里没有会误匹配 ": false" 的裸 grep',
);
check(
  /Verified using v3 scheme/.test(wf) && /': true'/.test(wf) && /': false'/.test(wf),
  'v3 用 case 明确区分 true / false',
);
check(
  /echo "v3=true" >> "\$GITHUB_OUTPUT"/.test(wf) &&
    /echo "v3=false" >> "\$GITHUB_OUTPUT"/.test(wf),
  'v3 结果写入 step output（可被 Summary 消费）',
);

// 行为验证：用真实 apksigner 输出格式驱动一段等价 shell 逻辑
{
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const hasBash = existsSync(bash);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'sigv2-'));
  try {
    const signed = [
      'Verifies',
      'Verified using v1 scheme (JAR signing): false',
      'Verified using v2 scheme (APK Signature Scheme v2): true',
      'Verified using v3 scheme (APK Signature Scheme v3): false',
      'Number of signers: 1',
      '',
    ].join('\n');
    const unsigned = [
      'Verifies',
      'Verified using v1 scheme (JAR signing): false',
      'Verified using v2 scheme (APK Signature Scheme v2): false',
      'Verified using v3 scheme (APK Signature Scheme v3): false',
      'Number of signers: 0',
      '',
    ].join('\n');
    const fSigned = path.join(tmp, 'signed.txt');
    const fUnsigned = path.join(tmp, 'unsigned.txt');
    writeFileSync(fSigned, signed, 'utf8');
    writeFileSync(fUnsigned, unsigned, 'utf8');

    // 被测逻辑（与 workflow 中一致）
    const script = path.join(tmp, 'check.sh');
    writeFileSync(
      script,
      [
        'FILE="$1"',
        'V2=$(grep -E "^Verified using v2 scheme " "$FILE" || true)',
        'case "$V2" in',
        '  *": true")  echo PASS ;;',
        '  *)          echo FAIL ;;',
        'esac',
        '',
      ].join('\n'),
      'utf8',
    );

    if (hasBash) {
      const run = (f) =>
        execFileSync(bash, [script, f.replace(/\\/g, '/')], { encoding: 'utf8' }).trim();
      check(run(fSigned) === 'PASS', '已签名（v2: true）-> PASS');
      check(run(fUnsigned) === 'FAIL', '未签名（v2: false）-> FAIL（旧的裸 grep 会误判 PASS）');
    } else {
      // 没 bash 时退化为纯 JS 断言，保证测试仍能守行为
      const v2True = /^Verified using v2 scheme .*: true$/m;
      check(v2True.test(signed), '已签名（v2: true）-> PASS');
      check(!v2True.test(unsigned), '未签名（v2: false）-> FAIL');
    }
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log('');
console.log('── 2. 总体结论覆盖所有必需门禁 ──');

for (const [label, env] of [
  ['Secrets', 'S_SECRETS'],
  ['keystore', 'S_KEYSTORE'],
  ['版本水位线', 'S_VERSION'],
  ['正式签名构建', 'S_BUILD'],
  ['证书身份', 'S_CERT'],
  ['包名版本签名方案', 'S_PKG'],
  ['更新完整性', 'S_SUMS'],
  ['缺签名负向', 'S_NEG'],
]) {
  check(
    new RegExp(`check_required "[^"]*"\\s+"\\$${env}"`).test(wf) ||
      new RegExp(`add_bad "[^"]*"\\s+"\\$${env}"`).test(wf),
    `总体判定纳入 ${label}（$${env}）`,
  );
}
check(
  /if \[ "\$CAN_UPLOAD_APK" = "true" \]; then\s*\n\s*check_required "验收包生成"/.test(wf),
  '验收包生成仅在允许上传时才作为必需项',
);
check(
  !/OVERALL="✅ 全部通过"\s*\n\s*if \[ "\$S_CERT" != "success" \] \|\| \[ "\$S_BUILD" != "success" \]/.test(wf),
  '已移除「只检查 cert + build」的旧总体判定',
);

console.log('');
console.log('── 3. 可选 Debug 构建：区分未启用与失败 ──');

check(
  /DEBUG_ENABLED: \$\{\{ inputs\.verify_debug_too \}\}/.test(wf),
  'Summary/Enforce 读取 inputs.verify_debug_too',
);
check(
  /if \[ "\$DEBUG_ENABLED" = "true" \]; then[\s\S]{0,200}?add_bad "debug构建/.test(wf) ||
    /if \[ "\$DEBUG_ENABLED" = "true" \]; then[\s\S]{0,200}?check_required "debug 构建/.test(wf),
  'debug 只在用户启用时纳入必需判定',
);
check(/未启用（可选，不计入总体）/.test(wf), '未启用时显示「未启用（可选）」而不是 FAIL');

console.log('');
console.log('── 4. 公开仓库不得上传真实签名 APK ──');

check(/id: vis/.test(wf), '存在仓库可见性判定步骤');
check(
  /REPO_PRIVATE: \$\{\{ github\.event\.repository\.private \}\}/.test(wf),
  '读取 github.event.repository.private',
);
check(
  /case "\$\{REPO_PRIVATE:-\}" in\s*\n\s*true\)/.test(wf),
  '私有仓库分支显式处理',
);
check(
  /false\)[\s\S]{0,400}?can_upload=false/.test(wf),
  '公开仓库 -> can_upload=false（拒绝上传）',
);
check(
  /\*\)[\s\S]{0,300}?can_upload=false/.test(wf),
  '无法判定时也按不可上传处理（fail-closed）',
);
check(
  /if: \$\{\{ steps\.cert\.outcome == 'success' && steps\.vis\.outputs\.can_upload == 'true' \}\}/.test(wf),
  'stage 步骤同时要求「证书通过」且「允许上传」',
);
// 关键：不能只靠文件名警告当隔离
check(
  !/^\s*# 公开仓库时请注意：这个 APK 会对外可见。$/m.test(wf) ||
    /不构成权限隔离/.test(wf),
  '说明文件名警告不构成权限隔离',
);
check(/本地构建/.test(wf), '公开仓库时给出本地构建指引');

console.log('');
console.log('── 5. 高 versionCode 副作用必须写入报告 ──');

check(
  /versionCode/.test(report) && /(覆盖安装|降级|uninstall|卸载)/.test(report),
  '报告说明了高 versionCode 会阻止低版本覆盖安装',
);
check(
  /(真机.*(卸载|测试包)|测试包.*(卸载|清理))/.test(report),
  '报告要求真机测试后处理测试包',
);

console.log('');
console.log('── 6. 报告区分「系统安装器」与「应用内更新器」 ──');

check(
  /SignatureMismatchError/.test(report),
  '报告提到应用内更新器的 SignatureMismatchError',
);
check(
  /(系统安装器|INSTALL_FAILED_UPDATE_INCOMPATIBLE)/.test(report),
  '报告提到系统安装器的报错',
);
check(
  /(两者|不能混为一谈|区分)/.test(report),
  '报告明确区分这两种错误来源',
);

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
