/**
 * v0.18 F-05 / F-06 的专项测试：滚动跟随判定 + 复制文本整形。
 *
 * 这两块在模拟器上都属于「手感」问题（按钮闪、提示错、复制多了空行），
 * 靠肉眼回归既不稳定也容易漏，所以把判据全部抽成纯函数在这里钉死，
 * 再用少量静态检查守住「UI 真的接上了」这一层。
 */

import { readFileSync } from 'node:fs';

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

// ── 加载被测纯函数（tsx 直接吃 TS） ─────────────────────────────────
const scroll = await import('../src/core/scrollFollow.ts');
const copy = await import('../src/core/copyText.ts');

const {
  AWAY_FROM_BOTTOM_PX,
  RETURN_TO_BOTTOM_PX,
  NEAR_BOTTOM_PX,
  tailOf,
  classifyListChange,
  shouldShowJumpToBottom,
  shouldMarkNewContent,
  distanceFromBottom,
} = scroll;
const { normalizeCopyText, buildAssistantCopyText } = copy;

console.log('\n── 阈值常量 ─────────────────────────────────────────────');

check('显示阈值 > 隐藏阈值 > 0（迟滞区间必须存在）', () =>
  AWAY_FROM_BOTTOM_PX > RETURN_TO_BOTTOM_PX && RETURN_TO_BOTTOM_PX > 0
    ? true
    : `away=${AWAY_FROM_BOTTOM_PX} return=${RETURN_TO_BOTTOM_PX}`,
);

check('贴底阈值小于隐藏阈值（回底优先于收起按钮）', () =>
  NEAR_BOTTOM_PX < RETURN_TO_BOTTOM_PX
    ? true
    : `near=${NEAR_BOTTOM_PX} return=${RETURN_TO_BOTTOM_PX}`,
);

console.log('\n── 离底距离 ─────────────────────────────────────────────');

check('正常度量', () =>
  distanceFromBottom({ contentHeight: 2000, offsetY: 900, viewportHeight: 1000 }) === 100
    ? true
    : '算出 100 才正确',
);

check('滚过头（负距离）夹到 0', () =>
  distanceFromBottom({ contentHeight: 1000, offsetY: 1200, viewportHeight: 800 }) === 0
    ? true
    : '负距离必须夹到 0，否则按钮会一直显示',
);

console.log('\n── 按钮显隐（含迟滞） ───────────────────────────────────');

check('贴底不显示', () => (shouldShowJumpToBottom(0, false) === false ? true : '距离 0 还显示'));
check('不足显示阈值不显示', () =>
  shouldShowJumpToBottom(AWAY_FROM_BOTTOM_PX - 1, false) === false ? true : '没到阈值就冒出来了',
);
check('超过显示阈值显示', () =>
  shouldShowJumpToBottom(AWAY_FROM_BOTTOM_PX + 1, false) === true ? true : '超过阈值却没显示',
);
check('已显示时回落到迟滞区间内仍显示', () =>
  shouldShowJumpToBottom(RETURN_TO_BOTTOM_PX + 10, true) === true
    ? true
    : '迟滞失效，按钮会在阈值附近闪',
);
check('已显示时回到贴底区才收起', () =>
  shouldShowJumpToBottom(RETURN_TO_BOTTOM_PX - 1, true) === false ? true : '该收起时没收起',
);
check('NaN 当作贴底（不显示）', () =>
  shouldShowJumpToBottom(Number.NaN, true) === false ? true : 'NaN 不该让按钮出现',
);

console.log('\n── 列表尾部签名 ─────────────────────────────────────────');

const items = (...keys) => keys.map((k) => ({ key: k, kind: 'assistant', blocks: [{ text: 'x' }] }));

check('空列表签名全空', () => {
  const t = tailOf([]);
  return t.length === 0 && t.firstKey === '' && t.lastKey === '' && t.lastSize === 0
    ? true
    : JSON.stringify(t);
});

check('首尾 key 与长度正确', () => {
  const t = tailOf(items('a', 'b', 'c'));
  return t.firstKey === 'a' && t.lastKey === 'c' && t.length === 3 ? true : JSON.stringify(t);
});

check('末项内容长度被统计（用于识别流式增长）', () => {
  const t = tailOf([{ key: 'a', kind: 'assistant', blocks: [{ text: '12345' }, { text: '678' }] }]);
  return t.lastSize === 8 ? true : `lastSize=${t.lastSize}`;
});

console.log('\n── 变化分类（新内容提示只认末尾增长） ───────────────────');

const base = tailOf(items('a', 'b', 'c'));

check('首次（无历史）不算变化', () =>
  classifyListChange(null, base) === 'none' ? true : '首次挂载不该亮提示',
);
check('末尾新增 → appended', () =>
  classifyListChange(base, tailOf(items('a', 'b', 'c', 'd'))) === 'appended' ? true : '末尾新增没识别',
);
check('加载更早（头部变化）→ prepended', () =>
  classifyListChange(base, tailOf(items('x', 'a', 'b', 'c'))) === 'prepended'
    ? true
    : '头部插入被误判成新内容',
);
check('头尾都变 → replaced（换会话/整体重载）', () =>
  classifyListChange(base, tailOf(items('x', 'y', 'z'))) === 'replaced' ? true : '整体重载没识别',
);
check('末项同 key 但变长 → grew（流式输出）', () => {
  const prev = tailOf([{ key: 'a', kind: 'assistant', blocks: [{ text: 'ab' }] }]);
  const next = tailOf([{ key: 'a', kind: 'assistant', blocks: [{ text: 'abcdef' }] }]);
  return classifyListChange(prev, next) === 'grew' ? true : '流式增长没识别';
});
check('完全没变 → none', () =>
  classifyListChange(base, tailOf(items('a', 'b', 'c'))) === 'none' ? true : '无变化被判成有变化',
);

console.log('\n── 要不要亮「有新内容」圆点 ─────────────────────────────');

check('末尾新增 + 离底 → 亮', () =>
  shouldMarkNewContent('appended', 500) === true ? true : '该亮没亮',
);
check('流式增长 + 离底 → 亮', () => (shouldMarkNewContent('grew', 500) === true ? true : '流式没亮'));
check('末尾新增但贴底 → 不亮（内容会自己跟到底）', () =>
  shouldMarkNewContent('appended', NEAR_BOTTOM_PX - 1) === false ? true : '贴底还亮提示',
);
check('加载更早 → 绝不亮', () =>
  shouldMarkNewContent('prepended', 900) === false ? true : '加载更早被当成新内容',
);
check('整体重载 → 不亮', () =>
  shouldMarkNewContent('replaced', 900) === false ? true : '重载不该亮',
);

console.log('\n── 复制文本整形 ─────────────────────────────────────────');

check('CRLF 归一成 LF', () =>
  normalizeCopyText('a\r\nb') === 'a\nb' ? true : JSON.stringify(normalizeCopyText('a\r\nb')),
);
check('去掉行尾空白', () =>
  normalizeCopyText('a  \nb\t\n') === 'a\nb' ? true : JSON.stringify(normalizeCopyText('a  \nb\t\n')),
);
check('去掉首尾空行（代码块尾换行不会带进剪贴板）', () =>
  normalizeCopyText('\n\n  const a = 1;\n\n\n') === '  const a = 1;' ? true : '首尾空行没清干净',
);
check('保留正文内部空行与首行缩进', () =>
  normalizeCopyText('  if (x) {\n\n    y();\n  }') === '  if (x) {\n\n    y();\n  }'
    ? true
    : '内部空行/缩进被破坏',
);
check('空文本 → 空串', () => (normalizeCopyText('') === '' ? true : '空文本应返回空串'));
check('纯空白 → 空串', () =>
  normalizeCopyText('   \n\t\n') === '' ? true : '纯空白应返回空串',
);

console.log('\n── 助手消息「复制全文」拼装 ─────────────────────────────');

check('只取正文块，跳过思考/工具/交付物', () => {
  const text = buildAssistantCopyText([
    { kind: 'reasoning', text: '内部思考不该被复制' },
    { kind: 'text', text: '第一段答案' },
    { kind: 'tool', text: '工具输出也不该进剪贴板' },
    { kind: 'file', text: '/tmp/a.png' },
    { kind: 'text', text: '第二段答案' },
  ]);
  return text === '第一段答案\n\n第二段答案' ? true : JSON.stringify(text);
});

check('没有正文 → 空串（不显示复制入口）', () =>
  buildAssistantCopyText([{ kind: 'tool', text: 'x' }]) === '' ? true : '没有正文还拼出内容',
);

check('正文内部空行保留、块间用空行分隔', () => {
  const text = buildAssistantCopyText([
    { kind: 'text', text: 'a\n\nb' },
    { kind: 'text', text: 'c' },
  ]);
  return text === 'a\n\nb\n\nc' ? true : JSON.stringify(text);
});

// ── 静态检查：UI 是否真的接上了（少量、只守结构不变式） ─────────────
console.log('\n── UI 接线静态检查 ─────────────────────────────────────');

const chatSrc = readFileSync('src/screens/ChatScreen.tsx', 'utf8');
const mdSrc = readFileSync('src/components/MarkdownView.tsx', 'utf8');
const fabSrc = readFileSync('src/components/JumpToBottomFab.tsx', 'utf8');
const clipSrc = readFileSync('src/components/clipboard.ts', 'utf8');

check('聊天页渲染回到底部按钮并传入新内容状态', () => {
  const hasFab = /<JumpToBottomFab[\s\S]{0,200}hasNewContent=\{hasNewContent\}/.test(chatSrc);
  return hasFab ? true : 'ChatScreen 没有接上 JumpToBottomFab / hasNewContent';
});

check('聊天页给列表配了阅读位置锁定（且首次落底后才启用）', () => {
  const hasProp = /maintainVisibleContentPosition=\{anchorReady \? \{ minIndexForVisible: 0 \} : undefined\}/.test(
    chatSrc,
  );
  return hasProp ? true : '缺少 maintainVisibleContentPosition（或没做首次落底门控）';
});

check('聊天页用纯函数判定离底与显隐（没有内联魔数）', () => {
  const usesHelper = /shouldShowJumpToBottom\(/.test(chatSrc) && /distanceFromBottom\(/.test(chatSrc);
  return usesHelper ? true : 'ChatScreen 没走 core/scrollFollow 的判定函数';
});

check('聊天页复制入口只挂在每轮最后一条助手步骤', () =>
  /finalAssistantKeys/.test(chatSrc) && /buildAssistantCopyText\(item\.blocks\)/.test(chatSrc)
    ? true
    : '复制入口没有按「每轮最后一步」收敛',
);

check('Markdown 代码块渲染复制按钮', () =>
  /case 'code':[\s\S]{0,600}<CopyTextButton[\s\S]{0,200}accessibilityLabel="复制代码"/.test(mdSrc)
    ? true
    : '代码块没有复制按钮',
);

check('复制统一经过 normalizeCopyText 再写剪贴板', () =>
  /normalizeCopyText/.test(clipSrc) && /Clipboard\.setString\(payload\)/.test(clipSrc)
    ? true
    : 'clipboard 封装没做文本整形',
);

check('按钮带无障碍语义', () =>
  /accessibilityRole="button"/.test(fabSrc) && /accessibilityLabel=\{label\}/.test(fabSrc)
    ? true
    : 'JumpToBottomFab 缺无障碍属性',
);

// ── 汇总 ────────────────────────────────────────────────────────────
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
