/**
 * 临时工作区过滤的测试。
 *
 * 这个功能最怕的是**误杀**：把用户真实项目藏起来比不滤更糟。
 * 所以测试重点在「不该滤的不能滤」。
 */

import { isTempWorkspace, dropTempWorkspaces } from '../src/core/workspaceFilter.ts';

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
function check(n, fn) {
  try {
    const r = fn();
    if (r === true) ok(n);
    else bad(n, String(r));
  } catch (e) {
    bad(n, e && e.message ? e.message : String(e));
  }
}

// ── 应该被过滤的（DSH 临时工作区）──────────────────────────────
const SHOULD_DROP = [
  ['Windows Temp + dsh-prop', 'C:\\Users\\xis\\AppData\\Local\\Temp\\dsh-prop-h2ony2ku'],
  ['Windows Temp + dshsk4', 'C:\\Users\\xis\\AppData\\Local\\Temp\\dshsk4-fe1536f1c9d64da4a40a2a28d7dd085b'],
  ['另一个 dsh-prop', 'C:\\Users\\xis\\AppData\\Local\\Temp\\dsh-prop-dcqq_0am'],
  ['小写路径', 'c:\\users\\xis\\appdata\\local\\temp\\dsh-prop-abc123'],
  ['macOS 临时目录', '/var/folders/xx/dsh-prop-abc123'],
  ['Linux /tmp', '/tmp/dsh-prop-abc123'],
  ['Linux /tmp + 随机后缀', '/tmp/dshsk4-fe1536f1c9d64da4a40a2a28d7dd085b'],
  // 临时目录根本身。实测确实会冒出一个叫「Temp」的工作区，里面 1 个未命名会话。
  ['Windows Temp 根', 'C:\\Users\\xis\\AppData\\Local\\Temp'],
  ['Linux /tmp 根', '/tmp'],
];

for (const [name, path] of SHOULD_DROP) {
  check(`过滤：${name}`, () => (isTempWorkspace(path) === true ? true : '没被识别为临时'));
}

// ── 绝对不能被过滤的（真实项目）────────────────────────────────
const SHOULD_KEEP = [
  ['普通项目', 'E:\\work\\dsBot'],
  ['另一个项目', 'E:\\work\\rsi'],
  ['默认工作区', 'C:\\Users\\xis\\Documents\\deepseek-harness\\default-workspace'],
  ['名字像 dsh 但不在 Temp', 'E:\\work\\dsh-prop-test'],
  ['Temp 下但不是 dsh 生成', 'C:\\Users\\xis\\AppData\\Local\\Temp\\my-own-project'],
  ['名字里带 temp 的真实项目', 'E:\\work\\mytemp\\proj'],
  ['空字符串', ''],
  ['null', null],
  ['undefined', undefined],
  ['只有空格', '   '],
  ['根目录', 'E:\\'],
  ['深层项目', 'E:\\work\\myproject\\sub\\dir'],
];

for (const [name, path] of SHOULD_KEEP) {
  check(`保留：${name}`, () =>
    isTempWorkspace(path) === false ? true : '被误判为临时工作区',
  );
}

// ── 批量过滤 ────────────────────────────────────────────────────
check('批量过滤只留真实项目', () => {
  const list = [
    { path: 'E:\\work\\dsBot', name: 'dsBot' },
    { path: 'C:\\Users\\xis\\AppData\\Local\\Temp\\dsh-prop-a1', name: 'dsh-prop-a1' },
    { path: 'E:\\work\\rsi', name: 'rsi' },
    { path: 'C:\\Users\\xis\\AppData\\Local\\Temp\\dsh-prop-b2', name: 'dsh-prop-b2' },
  ];
  const kept = dropTempWorkspaces(list);
  return kept.length === 2 && kept[0].name === 'dsBot' && kept[1].name === 'rsi'
    ? true
    : JSON.stringify(kept.map((k) => k.name));
});

check('批量过滤保持原顺序', () => {
  const list = [
    { path: 'E:\\c' },
    { path: 'E:\\a' },
    { path: 'E:\\b' },
  ];
  const kept = dropTempWorkspaces(list);
  return kept.map((k) => k.path).join(',') === 'E:\\c,E:\\a,E:\\b' ? true : '顺序被改了';
});

check('全被过滤时返回空数组', () => {
  const list = [
    { path: 'C:\\Users\\xis\\AppData\\Local\\Temp\\dsh-prop-a1' },
    { path: 'C:\\Users\\xis\\AppData\\Local\\Temp\\dsh-prop-b2' },
  ];
  return dropTempWorkspaces(list).length === 0 ? true : '没清干净';
});

// ── 接入检查 ────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
const sessionSrc = readFileSync('src/core/rpc/session.ts', 'utf8');
check('groupByWorkspace 里调用了过滤', () =>
  /isTempWorkspace\(key\)/.test(sessionSrc) ? true : '没接入过滤',
);
check('过滤发生在分组之前', () => {
  const i = sessionSrc.indexOf('if (isTempWorkspace(key)) continue;');
  const j = sessionSrc.indexOf('list.push(s)');
  return i > 0 && j > i ? true : '位置不对';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
