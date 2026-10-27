/**
 * Mobile Gateway 管理接口认证补丁 —— 回归测试。
 *
 * ## 守什么
 *
 * 上游插件的 `/mgw/*` 管理路由（含 `POST /mgw/pair`，能铸造配对码）
 * 原本只靠 `adminLoopbackOnly` + `isSameOrigin` 两道防线，实测都不够：
 *   · 回环在「DSH 绑具体 IP」时根本没监听 -> 该开关会让所有人不可达
 *   · isSameOrigin 对不带 Origin 的脚本直接放行
 *
 * 补丁在路由分派前插入 `ctx.connection.requestRejection(req)`，
 * 把访问控制交给 DSH 自己的会话认证（Host/Origin 栅栏 + dsh-auth cookie）。
 *
 * ## 测什么
 *
 * 1. 补丁源本身：幂等、fail-closed（锚点缺失/重复必须抛错）
 * 2. 应用到真实插件文件后的结果：语法有效、注入位置正确、只出现一次
 * 3. 运行时控制流：用模拟 ctx 执行注入块，覆盖 6 种分支
 * 4. 没有旁路：确认 3081 LAN 监听器不含 /mgw 路由
 *
 * 不启动真插件（依赖 DSH host），也不修改真实插件文件 —— 全部在副本上做。
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { patchManagementAuth } from '../../patches/mobile-gateway-mgmt-auth/patch.mjs';
let pass = 0;
let fail = 0;
function ok(n) {
  pass += 1;
  console.log('  OK    ' + n);
}
function bad(n, d) {
  fail += 1;
  console.log('  FAIL  ' + n + (d ? ' — ' + d : ''));
}
function check(cond, name, detail) {
  if (cond) ok(name);
  else bad(name, detail);
}

const repo = path.resolve(import.meta.dirname, '..', '..');
const pristinePlugin = path.join(
  os.homedir(),
  '.dsh',
  'profiles',
  'web',
  'node_modules',
  'dsh-plugin-mobile-gateway',
  'lib',
  'index.mjs',
);
const MARKER = 'DSH_OUTPOST_MGW_AUTH_PATCH';
const ANCHOR =
  "          if (req.method !== 'GET' && req.method !== 'HEAD' && !isSameOrigin(req)) {";

console.log('');
console.log('── 1. 补丁源：幂等与 fail-closed ──');

// 幂等
{
  const synthetic = 'const a = 1;\n' + ANCHOR + '\nconst b = 2;\n';
  const once = patchManagementAuth(synthetic);
  const twice = patchManagementAuth(once);
  check(once.includes(MARKER), '能对含锚点的源码注入补丁');
  check(twice === once, '重复应用不会叠加（幂等）');
}

// 锚点缺失
{
  let threw = false;
  try {
    patchManagementAuth('const x = 1;\n');
  } catch {
    threw = true;
  }
  check(threw, '锚点缺失时抛错（拒绝在未知源码上打补丁）');
}

// 锚点重复
{
  let threw = false;
  try {
    patchManagementAuth(ANCHOR + '\n' + ANCHOR + '\n');
  } catch {
    threw = true;
  }
  check(threw, '锚点重复时抛错（不猜该改哪一处）');
}

// 空输入
{
  let threw = false;
  try {
    patchManagementAuth('');
  } catch {
    threw = true;
  }
  check(threw, '空源码抛错');
}

console.log('');
console.log('── 2. 应用到真实插件副本 ──');

const havePlugin = existsSync(pristinePlugin);
if (!havePlugin) {
  console.log('  SKIP  未安装 dsh-plugin-mobile-gateway，跳过真实插件测试');
} else {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mgw-patch-'));
  const copy = path.join(tmp, 'index.mjs');
  try {
    copyFileSync(pristinePlugin, copy);
    const src = readFileSync(copy, 'utf8');

    // 记录原始哈希，便于报告
    const pristineHash = createHash('sha256').update(src, 'utf8').digest('hex');

    const patched = patchManagementAuth(src);
    writeFileSync(copy, patched, 'utf8');

    check(patched.length > src.length, '补丁使文件变大（确实注入了代码）');
    check(
      (patched.match(new RegExp(MARKER, 'g')) || []).length === 1,
      '标记只出现一次',
    );

    // 语法必须有效
    let syntaxOk = true;
    try {
      execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
    } catch {
      syntaxOk = false;
    }
    check(syntaxOk, '打过补丁的文件语法有效（node --check）');

    // 注入位置：必须在所有 /mgw 路由分派之前
    const markerIdx = patched.indexOf(MARKER);
    const firstRouteIdx = patched.indexOf("p === '/mgw/status'");
    check(
      markerIdx > 0 && firstRouteIdx > 0 && markerIdx < firstRouteIdx,
      '认证检查位于第一个 /mgw 路由之前',
      `marker=${markerIdx} route=${firstRouteIdx}`,
    );

    // 原代码里每个 /mgw 路由都在 mark 之后
    const routeNames = [
      '/mgw/status',
      '/mgw/tools/restart-web',
      '/mgw/tools/stop-web',
      '/mgw/public-setup',
      '/mgw/gateway',
      '/mgw/cloudflare',
      '/mgw/auth',
      '/mgw/devices',
      '/mgw/pair',
    ];
    const allAfter = routeNames.every((r) => {
      const i = patched.indexOf(`p === '${r}'`);
      return i > markerIdx;
    });
    check(allAfter, '全部 9 个 /mgw 路由都在认证检查之后（含 /mgw/pair）');

    // 旧的 Origin 检查仍然保留（作为额外一层）
    check(patched.includes(ANCHOR), '旧 isSameOrigin 检查被保留（纵深防御）');

    console.log('');
    console.log('── 3. 运行时控制流（模拟 ctx）──');

    // 抽出注入块并在受控 ctx 下执行
    const blockStart = patched.indexOf('          // ── ' + MARKER);
    const blockEnd = patched.indexOf(ANCHOR);
    const block = patched
      .slice(blockStart, blockEnd)
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');

    const fn = new Function(
      'ctx',
      'req',
      'res',
      'sendJson',
      'log',
      `return (async () => { ${block} ; return { reached: true }; })();`,
    );

    const sendJson = (res, code, obj) => {
      res.code = code;
      res.body = JSON.stringify(obj);
    };
    const log = () => undefined;

    async function run(ctx) {
      const res = { code: null, body: null };
      let reached = false;
      try {
        const out = await fn(ctx, {}, res, sendJson, log);
        reached = !!(out && out.reached);
      } catch {
        reached = false;
      }
      return { reached, code: res.code };
    }

    // 3.1 没有 connection 服务 -> 503
    {
      const r = await run({});
      check(!r.reached && r.code === 503, '无 ctx.connection -> 503 且不放行', `code=${r.code}`);
    }
    // 3.2 有 connection 但没 requestRejection -> 503
    {
      const r = await run({ connection: {} });
      check(!r.reached && r.code === 503, '无 requestRejection -> 503 且不放行', `code=${r.code}`);
    }
    // 3.3 未认证 -> 401
    {
      const r = await run({ connection: { requestRejection: () => 401 } });
      check(!r.reached && r.code === 401, '未认证 -> 401（/mgw/pair 拿不到配对码）', `code=${r.code}`);
    }
    // 3.4 跨源 -> 403
    {
      const r = await run({ connection: { requestRejection: () => 403 } });
      check(!r.reached && r.code === 403, '跨源/非法 Host -> 403', `code=${r.code}`);
    }
    // 3.5 认证通过 -> 放行
    {
      const r = await run({ connection: { requestRejection: () => undefined } });
      check(r.reached && r.code === null, '认证通过 -> 放行到路由', `code=${r.code}`);
    }
    // 3.6 认证抛错 -> 503
    {
      const r = await run({
        connection: {
          requestRejection: () => {
            throw new Error('boom');
          },
        },
      });
      check(!r.reached && r.code === 503, '认证异常 -> 503 且不放行（fail-closed）', `code=${r.code}`);
    }

    console.log('');
    console.log('── 4. 无旁路 ──');

    // 3081 LAN 监听器只处理 upgrade，不含 /mgw
    const lanSection = patched.slice(patched.indexOf("lanServer.on('upgrade'"));
    const lanChunk = lanSection.slice(0, 1600);
    check(!lanChunk.includes("p === '/mgw"), '3081 LAN 监听器不导出 /mgw 路由');
    check(
      lanChunk.includes('pathname !== wsPath'),
      '3081 LAN 监听器只接受 wsPath（其它一律 404）',
    );
    void pristineHash;
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log('');
console.log('── 5. 插件升级后必须「大声失败」而不是静默失效 ──');

{
  // 模拟：上游升级到未知版本。apply 脚本必须拒绝打补丁并说明原因，
  // 而不是「尽力打一下」—— 锚点消失时强行打会产出语义错误的代码，
  // 比不打补丁更危险（管理接口会在「有认证」的假象下仍然开放）。
  const { execFileSync } = await import('node:child_process');
  const {
    mkdtempSync: mkTmp2,
    writeFileSync: writeTmp,
    mkdirSync: mkdirTmp,
    readFileSync: readTmp,
    rmSync: rmTmp,
  } = await import('node:fs');
  const osMod = await import('node:os');

  const tmp2 = mkTmp2(path.join(osMod.tmpdir(), 'mgw-upgrade-'));
  try {
    mkdirTmp(path.join(tmp2, 'lib'), { recursive: true });
    const idx = path.join(tmp2, 'lib', 'index.mjs');
    writeTmp(idx, ANCHOR + '\n// fake upstream (never patched)\n', 'utf8');
    writeTmp(
      path.join(tmp2, 'package.json'),
      JSON.stringify({ name: 'dsh-plugin-mobile-gateway', version: '0.99.0' }),
      'utf8',
    );

    let refused = false;
    let out = '';
    try {
      out = execFileSync(
        process.execPath,
        [
          path.join(repo, 'patches', 'mobile-gateway-mgmt-auth', 'apply.mjs'),
          '--apply',
          `--path=${idx}`,
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (e) {
      refused = true;
      out = String(e.stdout || '') + String(e.stderr || '');
    }
    check(refused, '未知插件版本时 --apply 退出码非 0（拒绝打补丁）');
    check(/0\.99\.0/.test(out), '错误信息报出实际版本号（可排查）');
    check(/不在已核对白名单/.test(out), '错误信息说明「不在白名单」');
    check(/SHA-256/.test(out), '错误信息给出当前文件哈希（便于人工核对后加白名单）');

    const after = readTmp(idx, 'utf8');
    check(!after.includes(MARKER), '拒绝后**没有**写入补丁（不留半成品）');
  } finally {
    try {
      rmTmp(tmp2, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
