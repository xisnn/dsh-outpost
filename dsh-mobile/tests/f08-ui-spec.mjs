/**
 * F-08 低风险 UI 优化专项测试。
 *
 * 纯逻辑：3 秒连接横幅判定、系统主题解析。
 * 静态接线：动态屏宽、无障碍属性、减少动态效果。
 */
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function ok(name) {
  pass += 1;
  console.log(`  OK    ${name}`);
}
function bad(name, detail) {
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function check(name, fn) {
  try {
    const value = fn();
    if (value === true) ok(name);
    else bad(name, String(value));
  } catch (e) {
    bad(name, e?.message ?? String(e));
  }
}

const { shouldShowConnectionBanner, CONNECTION_BANNER_DELAY_MS } = await import(
  '../src/core/connectionBanner.ts'
);
const { resolveThemeMode, themeLabels, palettes, paletteOf } = await import('../src/design/tokens.ts');

console.log('\n── 连接错误横幅：3 秒延迟与终止态立即显示 ─────────');
check('非终止错误未满 3 秒不显示', () =>
  shouldShowConnectionBanner({
    connection: 'error',
    hint: '网络中断',
    terminal: false,
    errorSince: 1000,
    now: 1000 + CONNECTION_BANNER_DELAY_MS - 1,
  })
    ? '提前显示了'
    : true,
);
check('非终止错误满 3 秒显示', () =>
  shouldShowConnectionBanner({
    connection: 'error',
    hint: '网络中断',
    terminal: false,
    errorSince: 1000,
    now: 1000 + CONNECTION_BANNER_DELAY_MS,
  })
    ? true
    : '到 3 秒仍未显示',
);
check('401/403 终止态立即显示（不等待 3 秒）', () =>
  shouldShowConnectionBanner({
    connection: 'error',
    hint: '登录状态已失效',
    terminal: true,
    errorSince: 9999,
    now: 10_000,
  })
    ? true
    : '终止态被延迟',
);
check('连接正常 / 无提示文案不显示', () =>
  !shouldShowConnectionBanner({ connection: 'connected', hint: 'x', terminal: false, errorSince: 0, now: 99999 }) &&
  !shouldShowConnectionBanner({ connection: 'error', hint: '', terminal: true, errorSince: 0, now: 99999 })
    ? true
    : '无错误也显示横幅',
);
check('自定义延迟参数可覆盖默认 3 秒', () =>
  !shouldShowConnectionBanner({
    connection: 'error',
    hint: 'x',
    terminal: false,
    errorSince: 1000,
    now: 1999,
    delayMs: 2000,
  }) &&
  shouldShowConnectionBanner({
    connection: 'error',
    hint: 'x',
    terminal: false,
    errorSince: 1000,
    now: 3000,
    delayMs: 2000,
  })
    ? true
    : '自定义延迟失效',
);

console.log('\n── 跟随系统主题 ─────────────────────────────────');
check('system + 系统深色 → dark', () => (resolveThemeMode('system', 'dark') === 'dark' ? true : '未解析为深色'));
check('system + 系统浅色 → light', () => (resolveThemeMode('system', 'light') === 'light' ? true : '未解析为浅色'));
check('system + 未知系统值 → light', () => (resolveThemeMode('system', null) === 'light' ? true : '未知值未回退'));
check('显式 light/warm/dark 不被系统覆盖', () =>
  resolveThemeMode('light', 'dark') === 'light' &&
  resolveThemeMode('warm', 'dark') === 'warm' &&
  resolveThemeMode('dark', 'light') === 'dark'
    ? true
    : '显式主题被系统覆盖',
);
check('主题标签包含「跟随系统」且保留原有三项', () => {
  const values = Object.values(themeLabels);
  return values.includes('跟随系统') && values.includes('纯白') && values.includes('暖白') && values.includes('深色')
    ? true
    : JSON.stringify(values);
});
check('system 深色取到 dark 色板', () =>
  paletteOf('system', 'dark').bg === palettes.dark.bg ? true : '色板映射错误',
);

console.log('\n── 动态屏宽 / 无障碍 / 减少动态效果静态接线 ──────');
const nav = readFileSync('src/nav/NavHost.tsx', 'utf8');
const theme = readFileSync('src/design/theme.tsx', 'utf8');
const slide = readFileSync('src/components/SlideSegmented.tsx', 'utf8');
const thinking = readFileSync('src/components/Thinking.tsx', 'utf8');
const toolCard = readFileSync('src/components/ToolCard.tsx', 'utf8');
const scan = readFileSync('src/components/ScanSheet.tsx', 'utf8');
const chat = readFileSync('src/screens/ChatScreen.tsx', 'utf8');
const composer = readFileSync('src/components/ChatComposer.tsx', 'utf8');
const profile = readFileSync('src/screens/ProfileScreen.tsx', 'utf8');
const reduce = readFileSync('src/design/useReduceMotion.ts', 'utf8');

check('NavHost 使用 useWindowDimensions 动态宽度，不再依赖模块级 Dimensions', () =>
  /useWindowDimensions/.test(nav) &&
  /widthRef/.test(nav) &&
  /width=\{isMaster && columns \? columns\.masterWidth : paneWidth\}/.test(nav) &&
  /const paneWidth = columns\?\.detailWidth \?\? width/.test(nav) &&
  /width, height, fontScale.*useWindowDimensions\(\)/.test(nav) &&
  !/SCREEN_WIDTH/.test(nav)
    ? true
    : 'NavHost 仍使用静态屏宽',
);
check('ThemeProvider 接入 useColorScheme 并暴露 resolvedMode', () =>
  /useColorScheme/.test(theme) && /resolvedMode/.test(theme) && /paletteOf\(mode, systemScheme\)/.test(theme)
    ? true
    : '主题未接入系统色板',
);
check('主题选择使用四项标签并带无障碍标签', () =>
  /accessibilityLabel="主题模式"/.test(profile) && /themeLabels\[m\]/.test(profile)
    ? true
    : '主题选择缺少无障碍标签',
);
check('SlideSegmented 提供 adjustable 角色与增减无障碍动作', () =>
  /accessibilityRole="adjustable"/.test(slide) &&
  /accessibilityActions/.test(slide) &&
  /accessibilityValue=\{\{ text: activeLabel \}\}/.test(slide)
    ? true
    : '分段控件无障碍属性缺失',
);
check('Thinking 折叠头提供展开状态与标签', () =>
  /accessibilityState=\{\{ expanded: open \}\}/.test(thinking) && /accessibilityLabel=/.test(thinking)
    ? true
    : '思考折叠头缺少无障碍属性',
);
check('ToolCard / WorkGroupCard 折叠头保留展开状态无障碍属性', () =>
  /accessibilityState=\{\{ expanded: open \}\}/.test(toolCard) &&
  /accessibilityState=\{\{ expanded: open \}\}/.test(readFileSync('src/components/WorkGroupCard.tsx', 'utf8'))
    ? true
    : '工具/执行组折叠头无障碍缺失',
);
check('发送按钮提供无障碍角色、标签与禁用状态', () =>
  /<ChatComposer/.test(chat) && /onSend=\{\(mode\) => void send\(mode\)\}/.test(chat) &&
  /accessibilityRole="button"\s+accessibilityLabel="发送消息"/.test(composer) &&
  /accessibilityState=\{\{ disabled: !canSend, busy: sending \}\}/.test(composer)
    ? true : '发送按钮无障碍缺失',
);
check('useReduceMotion 监听系统减少动态效果设置', () =>
  /isReduceMotionEnabled/.test(reduce) && /reduceMotionChanged/.test(reduce)
    ? true
    : '未监听系统减少动态效果',
);
check('思考点 / 工具脉冲 / 扫码线在减少动态时停止循环', () =>
  /useReduceMotion/.test(thinking) &&
  /useReduceMotion/.test(toolCard) &&
  /useReduceMotion/.test(scan) &&
  /if \(reduceMotion\)/.test(thinking) &&
  /if \(reduceMotion\)/.test(toolCard) &&
  /if \(reduceMotion\)/.test(scan)
    ? true
    : '仍有循环动画未受减少动态控制',
);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
