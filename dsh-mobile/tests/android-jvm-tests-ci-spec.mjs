/**
 * agent-core JVM 单元测试的 CI 接入回归测试（TEST-17(1)）。
 *
 * ## 守什么
 *
 * `dsh-mobile/android/agent-core/src/test/` 下有 **38 个已经写好的 JUnit 测试**
 * （AgentLoopTest 14 / CloudModelClientTest 13 / FileRunStoreTest 7 /
 * RunRecoveryTest 4），覆盖 Agent 循环、云端模型客户端、run 存储与运行恢复。
 * 它们**从未被任何 CI 步骤调用过** —— `android.yml` 里只出现
 * `:app:assembleDebug` 与 `:app:assembleRelease`，两者都不执行 `test`。
 *
 * 本 spec 守两件事：
 *   1. **测试本身还在、还是 38 个**（防止被删或被静默缩减）
 *   2. **CI 真的会执行它们**，且执行它们的 job：
 *        · 不带 `workflow_dispatch` 之类的 job 级 `if:`（否则几乎不会跑 ——
 *          现有的 `build-test` job 正是这样，只在手动触发时执行）
 *        · 具备必要的环境（setup-java、`npm ci`）
 *        · 被 `release` 依赖（否则 JVM 测试失败不会阻止发版，等于装饰）
 *
 * ## 为什么 npm ci 是必需的
 *
 * `settings.gradle` 有 `includeBuild('../node_modules/@react-native/gradle-plugin')`。
 * 没有 `node_modules`，Gradle 连配置阶段都过不去 —— 这与 agent-core 是不是
 * 纯 JVM 模块无关。
 *
 * ## 为什么不用 YAML 库
 *
 * `yaml` 与 `js-yaml` 都**只是传递依赖**（不在 package.json 的 dependencies /
 * devDependencies 里）。测试依赖传递包会在某次 `npm ci` 后悄悄断掉，所以这里
 * 用缩进感知的结构化解析 —— 与 `signing-workflow-gates-spec.mjs`、
 * `security-remediation-spec.mjs` 读 workflow 的方式一致。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

const androidDir = path.join(repo, 'dsh-mobile', 'android');
const testRoot = path.join(androidDir, 'agent-core', 'src', 'test', 'kotlin', 'com', 'dshpocket', 'agent', 'core');

/** 已知的四个测试类与它们应有的 @Test 数量（本人以 gradlew 实跑核实过 38/0） */
const EXPECTED = {
  'AgentLoopTest.kt': 14,
  'CloudModelClientTest.kt': 13,
  'FileRunStoreTest.kt': 7,
  'RunRecoveryTest.kt': 4,
};
const EXPECTED_TOTAL = Object.values(EXPECTED).reduce((a, b) => a + b, 0);

// ── 缩进感知的 workflow 解析（不依赖 YAML 库）─────────────────────
/** 去掉纯注释行 —— 断言必须针对真正的 step，而不是解释性文字 */
const codeOnly = (s) =>
  s
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

/** 把 `jobs:` 下的每个 job 切成 { name, body, code, jobIf, needs } */
function parseJobs(src) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return {};
  const jobs = {};
  let current = null;
  let carry = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^\S/.test(l) && l.trim().length > 0) break; // 顶格的下一个顶层键，jobs 块结束
    const jobHead = l.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (jobHead) {
      // 上一个 job 末尾的注释/空行其实属于**下一个** job（YAML 里 job 前的
      // 2 空格缩进注释块是它的说明）。不归还的话，jvm-tests 的注释会被算进
      // test 的 body，于是"哪个 job 调用 :agent-core:test"就会指认错对象。
      if (current) {
        const moved = [];
        while (current.lines.length > 0 && /^\s*(#|$)/.test(current.lines[current.lines.length - 1])) {
          moved.unshift(current.lines.pop());
        }
        carry = moved;
      }
      current = { name: jobHead[1], lines: carry };
      carry = [];
      jobs[current.name] = current;
      continue;
    }
    if (current) current.lines.push(l);
  }
  for (const j of Object.values(jobs)) {
    j.body = j.lines.join('\n');
    j.code = codeOnly(j.body);
    // job 级 if: 是 4 空格缩进（step 级是 8 空格以上）
    const ifM = j.body.match(/^ {4}if:\s*(.+)$/m);
    j.jobIf = ifM ? ifM[1].trim() : null;
    const needsM = j.body.match(/^ {4}needs:\s*(.+)$/m);
    j.needs = needsM
      ? needsM[1]
          .replace(/[\[\]]/g, '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  }
  return jobs;
}

const wf = read('.github/workflows/android.yml');
const jobs = parseJobs(wf);

console.log('');
console.log('── 1. 基线：38 个 JVM 测试确实存在且可运行 ──');

check(
  /include\s+':agent-core'/.test(read('dsh-mobile/android/settings.gradle')),
  "settings.gradle 里 include ':agent-core'",
);

{
  const bg = read('dsh-mobile/android/agent-core/build.gradle');
  check(/id 'org\.jetbrains\.kotlin\.jvm'/.test(bg), 'agent-core 是纯 JVM 模块（kotlin.jvm）');
  check(/id 'java-library'/.test(bg), 'agent-core 应用了 java-library');
  check(/testImplementation 'junit:junit:4\.13\.2'/.test(bg), 'agent-core 声明了 JUnit 4 测试依赖');
  check(/useJUnit\(\)/.test(bg), 'agent-core 的 test 任务用 useJUnit()');
  check(/jvmToolchain\(17\)/.test(bg), 'agent-core 钉住了 JVM toolchain 17（可复现）');
}

if (!existsSync(testRoot)) {
  bad(`测试源码目录不存在：${path.relative(repo, testRoot)}`);
} else {
  const files = readdirSync(testRoot).filter((f) => f.endsWith('.kt')).sort();
  check(
    files.length === Object.keys(EXPECTED).length,
    `测试类文件数为 ${Object.keys(EXPECTED).length}`,
    `实际 ${files.length}：${files.join(', ')}`,
  );
  let total = 0;
  for (const [name, want] of Object.entries(EXPECTED)) {
    const p = path.join(testRoot, name);
    if (!existsSync(p)) {
      bad(`${name} 存在`);
      continue;
    }
    const n = (readFileSync(p, 'utf8').match(/@Test\b/g) || []).length;
    total += n;
    check(n === want, `${name} 有 ${want} 个 @Test`, `实际 ${n}`);
  }
  check(
    total === EXPECTED_TOTAL,
    `@Test 总数为 ${EXPECTED_TOTAL}（不得被静默缩减）`,
    `实际 ${total}`,
  );
}

console.log('');
console.log('── 2. CI 接入：必须有 job 真的执行 :agent-core:test ──');

// 只认真正的 step 命令行：必须有一行同时含 gradlew 与 :agent-core:test。
// 注释里提到这个任务名不算（jvm-tests 的说明注释就提到了它）。
const runnerJobs = Object.values(jobs).filter((j) =>
  j.code.split('\n').some((l) => /gradlew/.test(l) && /:agent-core:test\b/.test(l)),
);
check(
  runnerJobs.length === 1,
  'android.yml 里恰好有一个 job 通过 gradlew 执行 :agent-core:test',
  runnerJobs.length === 0
    ? `没有任何 job 执行它 —— 38 个测试永远不会运行。现有 job：${Object.keys(jobs).join(', ')}`
    : `有 ${runnerJobs.length} 个：${runnerJobs.map((j) => j.name).join(', ')}`,
);

if (runnerJobs.length === 1) {
  const j = runnerJobs[0];
  console.log(`  （执行 job：${j.name}）`);

  // build-test 的教训：带 workflow_dispatch 条件的 job 几乎不会跑
  check(
    j.jobIf === null,
    `${j.name} 没有 job 级 if: 条件（否则几乎不会执行 —— build-test 就是只在 workflow_dispatch 时跑）`,
    `if: ${j.jobIf}`,
  );
  check(
    /actions\/setup-java@/.test(j.code),
    `${j.name} 配置了 actions/setup-java（Gradle 需要 JDK）`,
  );
  check(
    /working-directory:\s*dsh-mobile\s*\n\s*run:\s*npm ci/.test(j.code),
    `${j.name} 先跑 npm ci（settings.gradle includeBuild 了 node_modules 里的 RN gradle 插件，缺它连配置阶段都过不去）`,
  );
  check(
    j.needs.includes('test'),
    `${j.name} needs: test（在 JS 套件之后跑，且与现有 job 图一致）`,
    `needs=${JSON.stringify(j.needs)}`,
  );
  check(
    /timeout-minutes:/.test(j.code),
    `${j.name} 设了 timeout-minutes（Gradle 卡死时不占满默认 6 小时额度）`,
  );
  check(
    /--no-daemon/.test(j.code),
    `${j.name} 用 --no-daemon（与 build-test / release 一致，CI 上不留驻留进程）`,
  );

  // 不执行 :app 的构建任务 —— 这个 job 只跑 JVM 测试，不该顺带打 APK
  check(!/assembleRelease/.test(j.code), `${j.name} 不执行 assembleRelease（不打正式包）`);
  check(!/assembleDebug/.test(j.code), `${j.name} 不执行 assembleDebug（不打测试包）`);

  console.log('');
  console.log('── 3. 门禁：release 必须依赖这个 job ──');
  const release = jobs.release;
  check(release !== undefined, 'android.yml 里有 release job');
  if (release) {
    check(
      release.needs.includes(j.name),
      `release 的 needs 包含 ${j.name}（否则 JVM 测试失败不会阻止发版，接入等于装饰）`,
      `release.needs=${JSON.stringify(release.needs)}`,
    );
    check(
      release.needs.includes('test') && release.needs.includes('desktop'),
      'release 原有的 needs（test、desktop）未被削弱',
      `release.needs=${JSON.stringify(release.needs)}`,
    );
    check(
      /^ {4}if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/m.test(release.body),
      'release 的 tag 触发条件未被改动（不改变发布时机）',
    );
  }

  console.log('');
  console.log('── 4. 边界：不得触碰签名材料与发布动作 ──');
  check(!/secrets\./.test(j.code), `${j.name} 不引用任何 secrets（不触碰签名材料）`);
  check(
    !/softprops|action-gh-release|releases\/create|gh release/i.test(j.code),
    `${j.name} 不含任何发布动作（不自动发布版本）`,
  );
  check(
    !/KEYSTORE|KEY_ALIAS|KEY_PASSWORD|EXPECTED_CERT/i.test(j.code),
    `${j.name} 不引用 keystore / 证书相关变量`,
  );
  check(
    !/^ {4}permissions:/m.test(j.body),
    `${j.name} 不声明任何 job 级 permissions（沿用顶层只读默认）`,
  );
  // 顶层 permissions 不得因为这次改动被放宽
  {
    const permM = wf.match(/^permissions:\s*\n((?: {2}\S.*\n?)+)/m);
    const perm = permM ? permM[1] : '';
    check(perm.length > 0, 'android.yml 顶层仍有 permissions 块');
    check(
      !/^ {2}contents:\s*write/m.test(perm),
      '顶层 permissions 未把 contents 放宽到 write（写权限只在 release job 内单独声明）',
      perm.trim().slice(0, 120),
    );
  }
} else {
  console.log('');
  console.log('── 3./4. 跳过：没有唯一执行 :agent-core:test 的 job，后续断言无对象 ──');
  bad('无法验证 release 门禁与签名边界', '第 2 节未通过');
}

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
