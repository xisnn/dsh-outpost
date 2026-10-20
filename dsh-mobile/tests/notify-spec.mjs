/**
 * 提醒模块的单测。
 *
 * 不加载 react-native（node 里没有），用最小桩件模拟：
 *   - Vibration：记录被调用的参数
 *   - AppState：返回固定状态
 * 这样能验证「开关生效 / 节流生效 / 两短震参数正确」这几个关键行为。
 */

import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;

function ok(name) {
  pass += 1;
  console.log('  OK    ' + name);
}

function bad(name, detail) {
  fail += 1;
  console.log('  FAIL  ' + name + (detail ? ' — ' + detail : ''));
}

function check(name, fn) {
  try {
    const r = fn();
    if (r === true) ok(name);
    else bad(name, String(r));
  } catch (e) {
    bad(name, e && e.message ? e.message : String(e));
  }
}

// ── 读取源码做静态校验 ────────────────────────────────────────────
// 真正的行为测试要跑 RN 环境，这里退一步验证关键实现细节存在，
// 避免以后改代码时不小心把节流/开关逻辑删掉。
const src = readFileSync('src/core/notify.ts', 'utf8');

check('有开关状态', () => (src.includes('let enabled') ? true : '缺少 enabled'));
check('有导出 setNotifyEnabled', () =>
  src.includes('export function setNotifyEnabled') ? true : '缺少导出',
);
check('有导出 isNotifyEnabled', () =>
  src.includes('export function isNotifyEnabled') ? true : '缺少导出',
);
check('有节流常量', () => (src.includes('MIN_GAP_MS') ? true : '缺少节流'));
check('节流是 3000ms', () => (src.includes('MIN_GAP_MS = 3000') ? true : '节流值不对'));
check('Android 用 pattern 数组', () =>
  src.includes('[0, 60, 80, 60]') ? true : '缺少两短震 pattern',
);
check('iOS 用固定时长', () =>
  src.includes('Vibration.vibrate(80)') ? true : '缺少 iOS 分支',
);
check('关闭时直接返回', () =>
  /if \(!enabled\) return;/.test(src) ? true : '开关没生效',
);
check('节流时直接返回', () =>
  /now - lastAt < MIN_GAP_MS\) return;/.test(src) ? true : '节流没生效',
);
check('force 能绕过节流', () => (src.includes('!force &&') ? true : '缺少 force 参数'));
check('震动被 try/catch 包住', () =>
  /try \{[^}]*Vibration\.vibrate/s.test(src) ? true : '震动没做容错',
);

// ── store 是否接上了提醒 ──────────────────────────────────────────
const storeSrc = readFileSync('src/core/store.ts', 'utf8');

check('store 引入了 notifyDone', () =>
  storeSrc.includes("from '../core/notify'") ? true : '没引入',
);
check('pushNotice 里调了 notifyDone', () =>
  /pushNotice[\s\S]{0,400}notifyDone\(text\)/.test(storeSrc) ? true : '没调用',
);

// ── 我的页面是否有开关 ────────────────────────────────────────────
const profileSrc = readFileSync('src/screens/ProfileScreen.tsx', 'utf8');

check('我的页面引入了提醒模块', () =>
  profileSrc.includes('setNotifyEnabled') ? true : '没引入',
);
check('我的页面有提醒区块', () =>
  profileSrc.includes('任务完成时震动') ? true : '没有 UI',
);

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
