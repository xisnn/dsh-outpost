/**
 * 测试套件聚合器（tests/run-suite.mjs）的回归测试。
 *
 * ## 守什么
 *
 * `run-suite.mjs` 替换了 `package.json` 里那条 105 个 spawn 的 `&&` 链。它必须
 * 满足第二方复核提出的三条硬约束，本 spec 逐条守住：
 *
 *   1. **收集全部失败**，而不是在第一个失败处截断 —— 且失败之后的命令**真的
 *      执行了**（用 marker 文件证明，不是只看汇总文字）。
 *   2. **保留原有执行语义** —— `tsx` / `node` / `npm run` / `--require` /
 *      `--test` 前缀逐字透传；`tsx` 与 `tsc` 走各自的 JS 入口而不是
 *      `node_modules/.bin`（Node 20.12+ 出于 CVE-2024-27980 拒绝在无 shell
 *      时 spawn .cmd/.bat）。
 *   3. **不用 glob** —— 命令来自 `package.json` 的传递展开，不来自文件系统扫描。
 *      §2 用一个**独立重写**的展开算法交叉验证聚合器的展开结果，两者必须逐字
 *      一致（算法故意重复：如果聚合器的展开漏了或多了命令，两边就会不一致）。
 *
 * 另外守住"失败即拒绝、绝不静默"：未知可执行文件、含 shell 元字符的命令、
 * 缺失的 script、循环引用，都必须**响亮报错**而不是跳过或猜测。
 *
 * ## 怎么测
 *
 * §1/§2 针对真实 `package.json`（只读 + `--dry-run`，不执行任何套件）。
 * §3~§6 在临时目录里搭一个**最小 fixture 仓库**：把 run-suite.mjs 复制进去，
 * 配一份只有几条命令的 package.json，再用真实的 node 子进程跑它。
 * fixture 里的 tsx / tsc 是**记录 argv 的桩**，用来证明聚合器把命令解析到了
 * 正确的入口并原样透传参数 —— 真正的 tsx/tsc 是否存在，由 §2 的 `--dry-run`
 * 证明（聚合器在规划阶段就会 `existsSync` 检查并报错）。
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 不用 import.meta.dirname（Node 20.11+ 才有）：聚合器本身必须在 Node 20.0 上
// 就能跑，它的测试也不该引入比被测对象更强的版本要求。
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

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

const mobileDir = path.join(repo, 'dsh-mobile');
const runner = path.join(mobileDir, 'tests', 'run-suite.mjs');
const read = (p) => readFileSync(path.join(repo, p), 'utf8');
const pkg = JSON.parse(read('dsh-mobile/package.json'));
const scripts = pkg.scripts;

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [runner, ...args], {
    cwd: opts.cwd ?? mobileDir,
    encoding: 'utf8',
    timeout: opts.timeout ?? 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: opts.env,
  });
  return {
    code: r.status === null ? -1 : r.status,
    out: String(r.stdout || '') + String(r.stderr || ''),
  };
}

console.log('');
console.log('── 1. package.json：公开脚本名未变，链条作为真值来源保留 ──');

check(existsSync(runner), 'tests/run-suite.mjs 存在');

// CI 调的就是这三个名字（android.yml: npm test / npm run test:integration /
// npm run test:node20），改名会静默让 CI 跑不到东西。
for (const name of ['test', 'test:integration', 'test:node20']) {
  check(typeof scripts[name] === 'string', `package.json 仍有 "${name}" 脚本（CI 依赖这个名字）`);
  check(
    /node tests\/run-suite\.mjs /.test(scripts[name] || ''),
    `"${name}" 走聚合器`,
    scripts[name],
  );
}

// 声明式链条必须保留：它是"跑哪些命令"的唯一真值来源，聚合器读它，
// 因此不存在第二份命令清单会漂移。
for (const name of ['test:chain', 'test:integration:chain', 'test:node20:chain']) {
  check(typeof scripts[name] === 'string', `"${name}" 保留为声明式链条`);
}
check(
  /npm run typecheck$/.test(scripts['test:chain'] || ''),
  'test:chain 仍以 npm run typecheck 结尾（tsc --noEmit 必须还在链尾）',
);
check(
  scripts.typecheck === 'tsc --noEmit',
  'typecheck 脚本本身未被改动',
  scripts.typecheck,
);
check(
  /node20-sim\.cjs/.test(scripts['test:node20:chain'] || ''),
  'test:node20:chain 仍带 --require ./tests/support/node20-sim.cjs（Node 20 语义模拟不能丢）',
);

console.log('');
console.log('── 2. 等价性：聚合器展开的命令与旧链逐字一致（独立算法交叉验证）──');

/**
 * **独立重写**的展开算法 —— 故意不复用聚合器的实现。
 * 两边不一致就说明其中一方漏了/多了命令。
 */
function independentExpand(root) {
  const leaves = [];
  const walk = (key, stack) => {
    if (stack.includes(key)) throw new Error('cycle: ' + stack.concat(key).join(' -> '));
    const value = scripts[key];
    if (typeof value !== 'string') throw new Error('missing script: ' + key);
    for (const part of value.split('&&').map((s) => s.trim()).filter(Boolean)) {
      const m = part.match(/^npm run ([\w:.-]+)$/);
      if (m) walk(m[1], stack.concat(key));
      else leaves.push(part);
    }
  };
  walk(root, []);
  return leaves;
}

const dry = run(['--dry-run', 'test:chain']);
check(dry.code === 0, '--dry-run test:chain 退出码 0', `实际 ${dry.code}`);

const planLines = dry.out
  .split('\n')
  .filter((l) => /^\d+\t/.test(l))
  .map((l) => l.slice(l.indexOf('\t') + 1));
const expected = independentExpand('test:chain');

check(
  planLines.length === expected.length,
  `展开出 ${expected.length} 条命令（不多不少）`,
  `聚合器给了 ${planLines.length} 条`,
);
check(
  JSON.stringify(planLines) === JSON.stringify(expected),
  '命令列表与独立展开**逐字、逐序一致**',
  planLines.findIndex((c, i) => c !== expected[i]) >= 0
    ? `首个差异在 #${planLines.findIndex((c, i) => c !== expected[i]) + 1}: 聚合器=${JSON.stringify(
        planLines[planLines.findIndex((c, i) => c !== expected[i])],
      )} 独立=${JSON.stringify(expected[planLines.findIndex((c, i) => c !== expected[i])])}`
    : '长度不同',
);
check(
  planLines[planLines.length - 1] === 'tsc --noEmit',
  '最后一条仍是 tsc --noEmit（旧链里它因前置失败而从不执行）',
  planLines[planLines.length - 1],
);

// 各类执行语义都必须在计划里原样出现
{
  const has = (re) => planLines.some((c) => re.test(c));
  check(has(/^tsx tests\//), '计划里有 tsx 裸调用（加载 .ts 的能力不能丢）');
  check(has(/^tsx --test /), '计划里有 tsx --test');
  check(has(/^node --test /), '计划里有 node --test');
  check(has(/^node tests\//), '计划里有裸 node');
  check(
    planLines.every((c) => /^(node|tsx|tsc)\b/.test(c)),
    '计划里只有 node / tsx / tsc 三种可执行文件（封闭集合，聚合器不需要猜）',
    planLines.filter((c) => !/^(node|tsx|tsc)\b/.test(c)).slice(0, 3).join(' | '),
  );
  check(
    planLines.every((c) => !/["'`|;&><$*?[\](){}\\]/.test(c)),
    '计划里没有含 shell 元字符的命令（所以 spawnSync(shell:false) 与旧链语义相同）',
  );
}

// test:node20:chain 的 --require 前缀必须原样透传
{
  const d = run(['--dry-run', 'test:node20:chain']);
  const lines = d.out.split('\n').filter((l) => /^\d+\t/.test(l)).map((l) => l.slice(l.indexOf('\t') + 1));
  check(d.code === 0, '--dry-run test:node20:chain 退出码 0');
  check(
    lines.length === 5 && lines.every((c) => /--require \.\/tests\/support\/node20-sim\.cjs/.test(c)),
    'test:node20:chain 的 5 条命令全部保留 --require node20-sim.cjs 前缀',
    lines.join(' | ').slice(0, 240),
  );
}

// --dry-run 在规划阶段就会 existsSync 检查 tsx/tsc 入口，
// 所以它能成功本身就证明两个 JS 入口在真实仓库里存在。
check(
  existsSync(path.join(mobileDir, 'node_modules', 'tsx', 'dist', 'cli.mjs')),
  '真实 tsx JS 入口存在（聚合器用 process.execPath 跑它，而不是 .bin/tsx.cmd）',
);
check(
  existsSync(path.join(mobileDir, 'node_modules', 'typescript', 'bin', 'tsc')),
  '真实 tsc JS 入口存在',
);

console.log('');
console.log('── 3~6. fixture：失败收集、语义透传、响亮失败 ──');

/**
 * 搭一个最小 fixture 仓库。
 * run-suite.mjs 用「自身位置的上一级」当 pkgDir，所以把复制品放进 <T>/tests/
 * 就能让它在 <T> 里找 package.json 与 node_modules。
 */
function makeFixture() {
  const T = mkdtempSync(path.join(os.tmpdir(), 'suite-runner-'));
  mkdirSync(path.join(T, 'tests'), { recursive: true });
  mkdirSync(path.join(T, 'f'), { recursive: true });
  mkdirSync(path.join(T, 'markers'), { recursive: true });
  mkdirSync(path.join(T, 'node_modules', 'tsx', 'dist'), { recursive: true });
  mkdirSync(path.join(T, 'node_modules', 'typescript', 'bin'), { recursive: true });
  copyFileSync(runner, path.join(T, 'tests', 'run-suite.mjs'));

  // 每个 fixture 都先落一个 marker，这样"某条命令是否真的执行过"是可证明的，
  // 不用靠解析输出文字。
  const script = (name, code) =>
    `import { writeFileSync } from 'node:fs';\n` +
    `writeFileSync('markers/${name}', String(process.argv.slice(2).length) + '|' + process.argv.slice(2).join(','));\n` +
    `process.exit(${code});\n`;
  writeFileSync(path.join(T, 'f', 'pass.mjs'), script('pass', 0));
  writeFileSync(path.join(T, 'f', 'fail1.mjs'), script('fail1', 1));
  writeFileSync(path.join(T, 'f', 'fail2.mjs'), script('fail2', 2));
  writeFileSync(path.join(T, 'f', 'after.mjs'), script('after', 0));
  writeFileSync(path.join(T, 'f', 'args.mjs'), script('args', 0));

  // tsx / tsc 桩：记录自己收到的 argv，用来证明聚合器解析到了正确入口并原样透传
  const stub = (name) =>
    `import { writeFileSync } from 'node:fs';\n` +
    `writeFileSync(${JSON.stringify(path.join(T, 'markers', name))}, JSON.stringify(process.argv.slice(2)));\n` +
    `process.exit(0);\n`;
  writeFileSync(path.join(T, 'node_modules', 'tsx', 'dist', 'cli.mjs'), stub('stub-tsx'));
  writeFileSync(path.join(T, 'node_modules', 'typescript', 'bin', 'tsc'), stub('stub-tsc'));

  const writePkg = (s) =>
    writeFileSync(path.join(T, 'package.json'), JSON.stringify({ name: 'fixture', scripts: s }, null, 2), 'utf8');

  const runIn = (args) => {
    const r = spawnSync(process.execPath, [path.join(T, 'tests', 'run-suite.mjs'), ...args], {
      cwd: T,
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: r.status === null ? -1 : r.status, out: String(r.stdout || '') + String(r.stderr || '') };
  };
  const marker = (name) => {
    const p = path.join(T, 'markers', name);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  };
  const clearMarkers = () => {
    for (const f of ['pass', 'fail1', 'fail2', 'after', 'args', 'stub-tsx', 'stub-tsc']) {
      rmSync(path.join(T, 'markers', f), { force: true });
    }
  };
  return { T, writePkg, runIn, marker, clearMarkers };
}

const fx = makeFixture();
try {
  // ── 3. 失败收集：两个失败都要报，且失败之后的命令必须真的跑 ──
  console.log('');
  console.log('── 3. 失败收集（&& 链只会报第一个）──');

  fx.writePkg({
    // 旧链在这里会在 fail1 处截断：fail2 与 after 永远不执行
    suite: 'node f/pass.mjs && node f/fail1.mjs && node f/fail2.mjs && node f/after.mjs',
  });
  fx.clearMarkers();
  const r3 = fx.runIn(['suite']);

  check(r3.code !== 0, '有失败时退出码非零', `实际 ${r3.code}`);
  check(r3.code === 1, '退出码是 1（不是最后一条命令的退出码，也不是 2）', `实际 ${r3.code}`);
  check(fx.marker('pass') !== null, '第 1 条（pass）执行了');
  check(fx.marker('fail1') !== null, '第 2 条（fail1）执行了');
  check(
    fx.marker('fail2') !== null,
    '**第 3 条（fail2）执行了** —— && 链会在 fail1 处截断，永远到不了这里',
  );
  check(
    fx.marker('after') !== null,
    '**第 4 条（after，在两个失败之后）执行了** —— 证明不截断',
  );
  check(/f\/fail1\.mjs/.test(r3.out) && /f\/fail2\.mjs/.test(r3.out), '汇总里**两个**失败命令都被列出');
  check(/失败清单/.test(r3.out), '汇总有明确的失败清单小节');
  check(/2 失败/.test(r3.out), '汇总报出失败数为 2', r3.out.split('\n').filter((l) => /汇总/.test(l)).join(''));
  check(/退出码 2/.test(r3.out), '汇总保留了每条失败各自的退出码（fail2 是 2，不是被压成 1）');

  // ── 4. 语义透传 ──
  console.log('');
  console.log('── 4. 执行语义透传（tsx / tsc / node / npm run 嵌套）──');

  fx.writePkg({
    inner: 'node f/args.mjs --test --require ./tests/support/x.cjs',
    suite: 'tsx f/args.mjs --test && tsc --noEmit && npm run inner',
  });
  fx.clearMarkers();
  const r4 = fx.runIn(['suite']);

  check(r4.code === 0, '全部通过时退出码 0', `实际 ${r4.code}\n${r4.out.slice(-400)}`);
  {
    const tsxArgv = JSON.parse(fx.marker('stub-tsx') ?? 'null');
    check(tsxArgv !== null, 'tsx 桩被调用（说明聚合器解析到了 node_modules/tsx/dist/cli.mjs）');
    check(
      Array.isArray(tsxArgv) && tsxArgv[0] === 'f/args.mjs' && tsxArgv[1] === '--test',
      'tsx 的 JS 入口收到了原样的文件与 --test 前缀（不是 .bin/tsx）',
      JSON.stringify(tsxArgv),
    );
  }
  {
    // tsc 是最后被调用的桩之一，stub-tsc 会覆盖写入
    const tscArgv = JSON.parse(fx.marker('stub-tsc') ?? 'null');
    check(tscArgv !== null, 'tsc 桩被调用（解析到 node_modules/typescript/bin/tsc）');
    check(
      Array.isArray(tscArgv) && tscArgv[0] === '--noEmit',
      'tsc 收到了原样的 --noEmit',
      JSON.stringify(tscArgv),
    );
  }
  {
    // npm run 嵌套：inner 里的 node f/args.mjs 带两个前缀参数
    const argsMarker = fx.marker('args');
    check(argsMarker !== null, 'npm run 嵌套被展开并执行');
    check(
      argsMarker === '3|--test,--require,./tests/support/x.cjs',
      'node 的 --test / --require 前缀逐字透传（argv 个数、顺序与内容都对）',
      argsMarker,
    );
  }

  // ── 5. 响亮失败：绝不静默跳过或猜测 ──
  console.log('');
  console.log('── 5. 未知形态必须响亮报错，不得静默跳过 ──');

  const loudCases = [
    {
      name: '未知可执行文件',
      scripts: { suite: 'python f/pass.mjs' },
      expect: /未知的可执行文件/,
    },
    {
      name: '含 shell 元字符（管道）',
      scripts: { suite: 'node f/pass.mjs | tee out.txt' },
      expect: /shell 元字符/,
    },
    {
      name: '含 shell 元字符（引号）',
      scripts: { suite: 'node -e process.exit(1)' },
      expect: /shell 元字符|未知的可执行文件/,
    },
    {
      name: '引用了不存在的 script',
      scripts: { suite: 'npm run nope' },
      expect: /没有 script "nope"/,
    },
    {
      name: 'script 循环引用',
      scripts: { a: 'npm run b', b: 'npm run a' },
      expect: /循环引用/,
    },
    {
      name: '展开结果为空',
      scripts: { suite: '' },
      expect: /展开结果为空/,
    },
  ];
  for (const c of loudCases) {
    fx.writePkg(c.scripts);
    fx.clearMarkers();
    const r = fx.runIn([Object.keys(c.scripts)[0]]);
    check(r.code !== 0, `${c.name} → 非零退出`, `实际 ${r.code}`);
    check(c.expect.test(r.out), `${c.name} → 报错信息指明原因`, r.out.trim().slice(-200));
    check(
      fx.marker('pass') === null,
      `${c.name} → 没有偷偷执行任何命令`,
    );
  }

  // 规划阶段就必须拒绝：一条坏命令不能让前面的好命令先跑起来
  fx.writePkg({ suite: 'node f/pass.mjs && python f/pass.mjs' });
  fx.clearMarkers();
  {
    const r = fx.runIn(['suite']);
    check(r.code !== 0, '坏命令混在好命令里 → 非零退出');
    check(
      fx.marker('pass') === null,
      '**规划阶段就拒绝**：前面的好命令没有被执行（避免跑一半才炸）',
      fx.marker('pass'),
    );
  }

  // ── 6. 不认识的参数 ──
  console.log('');
  console.log('── 6. 参数处理 ──');
  fx.writePkg({ suite: 'node f/pass.mjs' });
  {
    const r = fx.runIn(['--nope']);
    check(r.code !== 0, '不认识的 --flag → 非零退出');
    check(/不认识的参数/.test(r.out), '报错指明是哪个参数', r.out.trim().slice(-160));
  }
  {
    const r = fx.runIn(['--dry-run', 'suite']);
    check(r.code === 0, '--dry-run 退出码 0');
    check(/^1\tnode f\/pass\.mjs$/m.test(r.out), '--dry-run 打印「序号<TAB>命令」');
    check(
      fx.marker('pass') === null,
      '--dry-run **不执行**任何命令（否则它就不是 dry-run）',
    );
  }
} finally {
  rmSync(fx.T, { recursive: true, force: true });
}

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
