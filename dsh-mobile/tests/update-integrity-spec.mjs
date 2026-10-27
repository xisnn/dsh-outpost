/**
 * APK 更新完整性校验 —— 二次路径与边界回归测试。
 *
 * ## 为什么单独有这个文件
 *
 * `security-remediation-spec.mjs` 已经覆盖了 `update-integrity.ts` 的解析逻辑。
 * 这个文件补两类东西：
 *
 * 1. **第二条安装路径**：聊天附件里的 `.apk` 会经 `openLocalFile` 进系统安装器，
 *    完全不经过 `verifyApkIntegrity`。签名密钥若仍是公开 debug 证书，
 *    任何能往会话里丢文件的人都能投递一个 Android 会接受的「更新」。
 *
 * 2. **签名门禁的绝对约束**：CI 里必须有一条独立于 `EXPECTED_CERT_SHA256`
 *    的检查，明确拒绝「公开 debug 证书」——否则管理员把变量误设成 debug
 *    指纹时，门禁会「通过」。
 */

import { readFileSync } from 'node:fs';
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
const read = (p) => readFileSync(path.join(repo, p), 'utf8');

console.log('');
console.log('── 1. 第二条安装路径：聊天附件里的 APK ──');

const { isInstallablePackage } = await import('../src/core/installable.ts');

check(isInstallablePackage('evil.apk') === true, '.apk 被识别为安装包');
check(isInstallablePackage('EVIL.APK') === true, '大小写不敏感');
check(isInstallablePackage('bundle.apks') === true, '.apks 被识别');
check(isInstallablePackage('split.xapk') === true, '.xapk 被识别');
check(isInstallablePackage('release.aab') === true, '.aab 被识别');
check(isInstallablePackage('report.pdf') === false, '.pdf 不受影响');
check(isInstallablePackage('photo.png') === false, '.png 不受影响');
check(isInstallablePackage('notes.md') === false, '.md 不受影响');
check(isInstallablePackage('') === false, '空名不受影响');

const fileUrl = read('dsh-mobile/src/core/fileUrl.ts');
check(
  /if \(isInstallablePackage\(file\.name\)\) \{\s*\n\s*throw new Error/.test(fileUrl),
  'openLocalFile 对安装包抛错（不会进系统安装器）',
);
// 定位真正的调用点（注释里也会出现 actionViewIntent 这个词，不能直接 indexOf）
{
  const callIdx = fileUrl.indexOf('await ReactNativeBlobUtil.android.actionViewIntent(');
  const guardIdx = fileUrl.indexOf('if (isInstallablePackage(file.name)) {');
  check(
    guardIdx > 0 && callIdx > 0 && guardIdx < callIdx,
    '拒绝发生在调用 actionViewIntent 之前',
    `guard=${guardIdx} call=${callIdx}`,
  );
}

console.log('');
console.log('── 2. CI 必须独立拒绝公开 debug 证书 ──');

const ci = read('.github/workflows/android.yml');
const DEBUG_FP = 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c';

check(ci.includes(DEBUG_FP), 'CI 里硬编码了公开 debug 证书指纹（作为黑名单）');
check(
  /if \[ "\$NORM_ACTUAL_LC" = "\$DEBUG_CERT_SHA256" \]/.test(ci),
  '实际证书 == debug 证书时硬失败',
);
check(
  /EXPECTED_CERT_SHA256 被设成了公开 debug 证书的指纹/.test(ci),
  'EXPECTED_CERT_SHA256 被误设成 debug 指纹时也硬失败',
);
check(
  /::error::APK 使用的是仓库内公开的 Android Debug 证书/.test(ci),
  '错误信息明确说明原因',
);
// debug 黑名单检查必须在 EXPECTED 分支之前
{
  const dbgIdx = ci.indexOf('DEBUG_CERT_SHA256="');
  const expIdx = ci.indexOf('EXPECTED="${{ vars.EXPECTED_CERT_SHA256 }}"');
  check(dbgIdx > 0 && expIdx > dbgIdx, 'debug 黑名单检查在 EXPECTED 比对之前');
}

console.log('');
console.log('── 3. gradle 签名门禁：配置阶段不得失败 ──');

const gradle = read('dsh-mobile/android/app/build.gradle');
{
  const bt = gradle.indexOf('buildTypes {');
  const tg = gradle.indexOf('gradle.taskGraph.whenReady');
  check(bt > 0 && tg > bt, 'taskGraph 钩子存在于 buildTypes 之后');
  const configPart = gradle.slice(bt, tg);
  check(!/throw new GradleException/.test(configPart), '配置阶段块内没有 throw');
}

console.log('');
console.log('── 4. 旧 debug 签名 → 新正式签名的迁移路径 ──');

const updaterSrc = read('dsh-mobile/src/core/updater.ts');
check(
  /export class SignatureMismatchError/.test(updaterSrc),
  '存在 SignatureMismatchError（签名不一致的专门错误）',
);
check(
  /UPDATE_INCOMPATIBLE|signatures\? do not match/.test(updaterSrc),
  '能把 Android 的 INSTALL_FAILED_UPDATE_INCOMPATIBLE 识别成签名不一致',
);
check(
  updaterSrc.indexOf('SignatureMismatchError(msg)') > updaterSrc.indexOf('actionViewIntent'),
  '识别发生在安装器调用之后的 catch 里',
);
// 用户提示必须说清三件事：要卸载、数据不丢、要重新配对
for (const [label, re] of [
  ['提示用户卸载重装', /卸载当前 App/],
  ['说明会话数据不会丢', /不会丢失/],
  ['说明需要重新扫码配对', /重新扫码配对/],
  ['提醒撤销旧设备记录', /设备管理/],
]) {
  check(re.test(updaterSrc), '迁移提示包含：' + label);
}
// 旧注释不能还在骗人（说「CI 统一用 debug.keystore，能直接覆盖」）
check(
  !/目前 CI 统一用仓库里的 debug\.keystore 签名，所以能直接覆盖安装/.test(updaterSrc),
  '已移除「debug 签名可覆盖安装」的过时注释',
);

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
