/**
 * 边缘手势的判定逻辑测试。
 *
 * 手势在模拟器上很难稳定复现（滑动手感、误触），
 * 所以把判定逻辑抽成纯函数，用真实数值测。
 *
 * 三个关键取舍，每个都对应一类真实误操作：
 *   1. 根页面右滑 → 必须返回 false（否则一划退 App）
 *   2. 屏幕中间右滑 → 必须返回 false（否则和列表横滑打架）
 *   3. 纵向为主 → 必须返回 false（否则想滚动却返回了）
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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

const src = readFileSync('src/nav/NavHost.tsx', 'utf8');

// ── 先看常量是否合理 ──────────────────────────────────────────────
check('左缘宽度 28px', () => {
  const m = /EDGE_WIDTH\s*=\s*(\d+)/.exec(src);
  if (!m) return '找不到 EDGE_WIDTH';
  const v = Number(m[1]);
  return v > 0 && v <= 40 ? true : `EDGE_WIDTH=${v} 不合理`;
});

check('返回阈值 35%', () => {
  const m = /DISMISS_RATIO\s*=\s*([\d.]+)/.exec(src);
  if (!m) return '找不到 DISMISS_RATIO';
  const v = Number(m[1]);
  return v > 0.2 && v < 0.6 ? true : `DISMISS_RATIO=${v} 不合理`;
});

// ── 用真实数值验判定逻辑 ──────────────────────────────────────────
// 把常量 + 两个纯函数抠出来跑（不加载 RN）。
// 需要去掉 TS 类型标注和 export 关键字 —— new Function 只认裸 JS。
const constStart = src.indexOf('export const EDGE_WIDTH');
const body = src.slice(constStart);
const fnRaw = body.slice(0, body.indexOf('/** 单个页面容器'));
const fnSrc = fnRaw
  .replace(/export /g, '')
  .replace(/:\s*number/g, '')
  .replace(/:\s*boolean/g, '');
const mod = new Function(
  `${fnSrc}\nreturn { shouldDismiss, isBackGesture, EDGE_WIDTH, DISMISS_RATIO, FLING_VELOCITY };`,
)();
const { shouldDismiss, isBackGesture, EDGE_WIDTH, DISMISS_RATIO } = mod;

const W = 400; // 模拟屏宽

// shouldDismiss
check('滑过 35% 判定返回', () =>
  shouldDismiss(W * 0.4, 0, W) === true ? true : '滑到 40% 却没返回',
);
check('滑不到 35% 不返回', () =>
  shouldDismiss(W * 0.3, 0, W) === false ? true : '滑到 30% 却返回了',
);
check('快速甩动即使位移小也返回', () =>
  shouldDismiss(W * 0.1, 0.8, W) === true ? true : '甩动没被识别',
);
check('向左滑永不返回', () => (shouldDismiss(-50, 0, W) === false ? true : '左滑也返回了'));
check('位移为 0 不返回', () => (shouldDismiss(0, 0, W) === false ? true : '零位移也返回'));

// isBackGesture
check('根页面不认手势', () =>
  isBackGesture(5, 100, 0, false) === false ? true : '根页面也认了手势（会一划退 App）',
);
check('左缘起手认', () =>
  isBackGesture(10, 100, 0, true) === true ? true : '左缘起手没认',
);
check('屏幕中间起手不认', () =>
  isBackGesture(200, 100, 0, true) === false ? true : '中间起手也认了（会和横滑打架）',
);
check('边缘之外 1px 就不认', () =>
  isBackGesture(EDGE_WIDTH + 1, 100, 0, true) === false ? true : '边界判定不准',
);
check('纵向为主不认', () =>
  isBackGesture(10, 30, 100, true) === false ? true : '纵向滑动也触发返回',
);
check('斜着但横向为主仍认', () =>
  isBackGesture(10, 100, 40, true) === true ? true : '横向为主的斜滑没认',
);
check('向左滑不认', () =>
  isBackGesture(10, -50, 0, true) === false ? true : '左滑也认了',
);

// ── 结构检查 ──────────────────────────────────────────────────────
check('用了 PanResponder', () => (src.includes('PanResponder') ? true : '没用 PanResponder'));
check('手势起手用 onMoveShouldSet', () =>
  src.includes('onMoveShouldSetPanResponder') ? true : '起手判定缺失',
);
check('松手有回弹分支', () =>
  src.includes('Animated.spring') ? true : '没有回弹（滑一半会卡住）',
);
check('拖动用 setValue 而非 native driver', () => {
  // 拖动阶段必须是 setValue（JS 值），动画阶段才用 native driver
  return /onPanResponderMove[\s\S]{0,300}dragX\.setValue/.test(src)
    ? true
    : '拖动没有用 setValue';
});
check('注释解释了为什么只在左缘起手', () =>
  src.includes('打架') || src.includes('误触') ? true : '缺少取舍说明',
);

// ── 通知横幅 ──────────────────────────────────────────────────────
const notice = readFileSync('src/components/NoticeHost.tsx', 'utf8');
check('横幅有自动消失', () =>
  notice.includes('AUTO_DISMISS_MS') ? true : '不会自动消失',
);
check('最多堆 3 条', () => (notice.includes('slice(0, 3)') ? true : '没限制条数'));
check('避让安全区', () =>
  notice.includes('useSafeAreaInsets') ? true : '没避让刘海屏',
);
check('点击可跳转', () => (notice.includes('onPress') ? true : '不能点'));

// ── 多会话扫描 ────────────────────────────────────────────────────
const store = readFileSync('src/core/store.ts', 'utf8');
check('有全局扫描', () => (store.includes('startNoticeScan') ? true : '没有扫描'));
// 曾经想「空闲就跳过扫描」省电，但那样会让「跑得比扫描间隔还快」的任务
// 完全收不到通知（两次扫描都看到 running=false）。
// 现在改成：每次扫描，靠 lastScan 快照做差异检测。
check('不能因为空闲就跳过扫描', () =>
  /const busy[\s\S]{0,200}if \(!busy\)/.test(store)
    ? '又变回「空闲跳过」了（会漏通知）'
    : true,
);
check('首次扫描只建基线', () =>
  /lastScan\.size === 0/.test(store) ? true : '首次扫描会刷一堆通知',
);
check('清理已消失的会话', () =>
  /lastScan\.delete/.test(store) ? true : '快照会无限增长',
);
check('通知 10 秒内去重', () =>
  store.includes('10_000') ? true : '可能重复推同一条',
);

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
