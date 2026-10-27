/**
 * 发布签名门禁回归测试。
 *
 * ## 守什么
 *
 * 1. **不静默回退 debug 签名**：release 变体缺正式签名材料时必须拒绝构建。
 * 2. **不误伤日常构建**：`assembleDebug` / `:app:tasks` 必须照常工作。
 *
 * ## 为什么这两条要一起测
 *
 * 第一轮把 `GradleException` 直接写进 `android { buildTypes { release { } } }`，
 * 那是**配置阶段**求值的块 —— Gradle 为了构建 debug 也会执行它。结果
 * `assembleDebug` 直接挂掉、CI 的 build-test job 永远红。
 *
 * 这个测试就是防止那种回归再发生：它同时断言「release 被拒」和
 * 「debug 可用」，任何一边破了都会失败。
 *
 * ## 怎么测
 *
 * 真正调用 gradlew（`-m` = dry-run，只跑配置与任务图，不编译）。
 * 不用 `-q`，因为要靠 `BUILD SUCCESSFUL` / `BUILD FAILED` 判定。
 * gradlew 不存在（例如无 Android SDK 的环境）时跳过并明确说明。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
const androidDir = path.join(repo, 'dsh-mobile', 'android');
const gradlew = path.join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
const gradleFile = path.join(androidDir, 'app', 'build.gradle');
const gradleSrc = readFileSync(gradleFile, 'utf8');

console.log('');
console.log('── 1. 静态：没有配置阶段的硬失败 ──');

// 关键回归：GradleException 不能出现在 android{} 的 buildTypes 配置块里。
// 允许它出现在 taskGraph 钩子（执行阶段）。
const throwCount = (gradleSrc.match(/throw new GradleException/g) || []).length;
check(throwCount >= 1, '至少有一处 GradleException（签名缺失要能失败）');

// 定位 buildTypes release 块，确认里面没有 throw
const buildTypesIdx = gradleSrc.indexOf('buildTypes {');
const taskGraphIdx = gradleSrc.indexOf('gradle.taskGraph.whenReady');
check(buildTypesIdx > 0 && taskGraphIdx > buildTypesIdx, 'taskGraph 钩子在 buildTypes 之后声明');
if (buildTypesIdx > 0 && taskGraphIdx > buildTypesIdx) {
  const configBlock = gradleSrc.slice(buildTypesIdx, taskGraphIdx);
  check(
    !/throw new GradleException/.test(configBlock),
    '配置阶段块里没有 throw（否则 assembleDebug 会挂）',
  );
  check(
    gradleSrc.slice(taskGraphIdx).includes('throw new GradleException'),
    'throw 位于执行阶段钩子里',
  );
}

// 不能再出现旧的「一行回退到 debug」写法
check(
  !/signingConfig project\.hasProperty\('DSH_STORE_FILE'\) \? signingConfigs\.release : signingConfigs\.debug/.test(
    gradleSrc,
  ),
  '旧的单行 debug 回退已移除',
);

console.log('');
console.log('── 2. 行为：真实调用 gradlew（dry-run）──');

if (!existsSync(gradlew)) {
  console.log('  SKIP  gradlew 不存在，跳过行为测试');
} else {
  // Windows 上 .bat 不能直接 execFile（code: null），需要经 cmd /c。
  // 不用 `shell: true`：那会触发 DEP0190（参数只拼接不转义）。
  // 这里参数全部是**常量**，不含任何外部输入，所以没有注入面。
  const isWin = process.platform === 'win32';
  const gradlewCmd = isWin ? path.join(androidDir, 'gradlew.bat') : gradlew;

  function run(args) {
    let out = '';
    let code = 0;
    const file = isWin ? 'cmd.exe' : gradlewCmd;
    const argv = isWin ? ['/d', '/s', '/c', gradlewCmd, ...args] : args;
    try {
      out = execFileSync(file, argv, {
        cwd: androidDir,
        encoding: 'utf8',
        timeout: 600000,
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch (e) {
      out = String(e.stdout || '') + String(e.stderr || '');
      code = typeof e.status === 'number' ? e.status : 1;
    }
    return { out, code };
  }

  const isSuccess = (r) => r.code === 0 && /BUILD SUCCESSFUL/.test(r.out);
  const isFailure = (r) => r.code !== 0 || /BUILD FAILED/.test(r.out);

  // 2.1 release 缺签名材料 -> 必须失败
  {
    const r = run([':app:assembleRelease', '-m', '--console=plain']);
    check(isFailure(r), 'assembleRelease 缺签名材料时拒绝构建', `exit=${r.code}`);
    check(
      /缺少正式签名材料|正式签名/.test(r.out),
      '失败信息说明了缺少签名材料（可操作）',
    );
  }

  // 2.2 AAB 路径同样必须被拦
  {
    const r = run([':app:bundleRelease', '-m', '--console=plain']);
    check(isFailure(r), 'bundleRelease（AAB）同样被拦', `exit=${r.code}`);
  }

  // 2.3 assembleDebug 必须正常（这是第一轮的回归点）
  {
    const r = run([':app:assembleDebug', '-m', '--console=plain']);
    check(isSuccess(r), 'assembleDebug 正常工作（第一轮回归点）', `exit=${r.code}`);
  }

  // 2.4 :app:tasks 必须正常（纯配置阶段）
  {
    const r = run([':app:tasks', '--console=plain']);
    check(isSuccess(r), ':app:tasks 正常工作（配置阶段未被污染）', `exit=${r.code}`);
  }

  // 2.5 显式冒烟开关 -> 允许，但必须警告
  {
    const r = run([
      ':app:assembleRelease',
      '-m',
      '--console=plain',
      '-PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true',
    ]);
    check(isSuccess(r), '显式 DSH_ALLOW_DEBUG_RELEASE_SIGNING=true 时允许构建', `exit=${r.code}`);
    check(/debug 签名/.test(r.out), '冒烟开关会打印 debug 签名警告');
  }
}

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
