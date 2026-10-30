/**
 * v0.18 F-05 / F-06 的专项测试：滚动跟随判定 + 复制文本整形。
 *
 * 这两块在模拟器上都属于「手感」问题（按钮闪、提示错、复制多了空行），
 * 靠肉眼回归既不稳定也容易漏，所以把判据全部抽成纯函数在这里钉死，
 * 再用少量静态检查守住「UI 真的接上了」这一层。
 */

import fs from 'node:fs';

const { readFileSync } = fs;

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

// ── 流式 / 思考 / 工具场景（对应本轮交互规范的 6/7/8） ────────────────
check('流式中的半句也能复制（不要求整轮结束）', () => {
  const partial = buildAssistantCopyText([{ kind: 'text', text: '正在生成的半句' }]);
  return partial === '正在生成的半句' ? true : '流式正文被吞掉';
});

check('只有思考时复制结果为空（不弹/不复制思考）', () => {
  const text = buildAssistantCopyText([
    { kind: 'reasoning', text: '想了很久' },
    { kind: 'reasoning', text: '继续想' },
  ]);
  return text === '' ? true : JSON.stringify(text);
});

check('工具执行中（多有 tool 块）不混入日志', () => {
  const text = buildAssistantCopyText([
    { kind: 'reasoning', text: '先看看文件' },
    { kind: 'text', text: '我先读一下配置。' },
    { kind: 'tool', text: '{"path":"a.ts","stdout":"SECRET LOG"}' },
    { kind: 'tool', text: 'exit 0' },
  ]);
  return text === '我先读一下配置。' ? true : JSON.stringify(text);
});

check('多轮对话各自只取自己的正文', () => {
  const t1 = buildAssistantCopyText([{ kind: 'text', text: '第一轮答案' }]);
  const t2 = buildAssistantCopyText([{ kind: 'text', text: '第二轮答案' }]);
  return t1 === '第一轮答案' && t2 === '第二轮答案' ? true : '两轮正文串了';
});

// ── 静态检查：UI 是否真的接上了（少量、只守结构不变式） ─────────────
console.log('\n── UI 接线静态检查 ─────────────────────────────────────');

const chatSrc = readFileSync('src/screens/ChatScreen.tsx', 'utf8');
const mdSrc = readFileSync('src/components/MarkdownView.tsx', 'utf8');
const fabSrc = readFileSync('src/components/JumpToBottomFab.tsx', 'utf8');
const clipSrc = readFileSync('src/components/clipboard.ts', 'utf8');
const msgSrc = readFileSync('src/components/Message.tsx', 'utf8');
const sheetSrc = readFileSync('src/components/MessageActionSheet.tsx', 'utf8');

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

// ── 复制交互：长按面板，不再有常驻按钮 ──────────────────────────────
check('助手消息不再有常驻「复制」行（AssistantCopyRow 已移除）', () => {
  const hasRow = /AssistantCopyRow/.test(chatSrc) || /AssistantCopyRow/.test(msgSrc);
  return hasRow ? false : true;
});

check('全仓库没有旧的消息级复制组件残留', () => {
  // AssistantCopyRow / 消息下方的 bar 变体都应该彻底消失
  const compDir = 'src/components';
  const offenders = [];
  for (const name of fs.readdirSync(compDir)) {
    if (!name.endsWith('.tsx') && !name.endsWith('.ts')) continue;
    const src = fs.readFileSync(`${compDir}/${name}`, 'utf8');
    if (/AssistantCopyRow/.test(src)) offenders.push(`${name}:AssistantCopyRow`);
    if (/variant\s*=\s*['"]bar['"]/.test(src)) offenders.push(`${name}:bar-variant`);
  }
  return offenders.length === 0 ? true : `残留：${offenders.join(', ')}`;
});

check('CopyTextButton 只被 MarkdownView（代码块）使用', () => {
  const importers = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = `${dir}/${name}`;
      if (fs.statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(tsx|ts)$/.test(name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (/from ['"].*CopyTextButton['"]/.test(src)) importers.push(p);
    }
  };
  walk('src');
  return importers.length === 1 && importers[0].endsWith('src/components/MarkdownView.tsx')
    ? true
    : `CopyTextButton 使用点异常：${importers.join(', ')}`;
});

check('长按消息打开 MessageActionSheet，且传入正文', () => {
  const usesSheet = /<MessageActionSheet[\s\S]{0,200}text=\{actionText/.test(chatSrc);
  const opensOnLongPress = /onLongPress=\{openMessageActions\}/.test(chatSrc);
  return usesSheet && opensOnLongPress ? true : '没有把长按连接到 MessageActionSheet';
});

check('助手正文把长按回调透传到 Markdown 文本', () => {
  const chatPasses = /<AssistantText[\s\S]{0,200}onLongPress=\{opts\?\.onLongPressText\}/.test(chatSrc);
  const msgPasses = /<AssistantRichText[\s\S]{0,200}onLongPress=\{onLongPress\}/.test(msgSrc);
  // 长按由 MarkdownView 外层 Pressable 承担（Text 级 onLongPress 在 Fabric 下不可靠）
  const mdUses = /<Pressable onLongPress=\{onLongPress\}/.test(mdSrc);
  return chatPasses && msgPasses && mdUses ? true : '长按回调没有透传到正文';
});

check('正文长按与原生选择分开承载（正文保持 selectable）', () => {
  const sheetHasCopy = /复制全文/.test(sheetSrc) && /copyTextToClipboard\(text\)/.test(sheetSrc);
  // 正文必须是 selectable：双击选词 / 拖动选择手柄都靠它
  const bodySelectable = /bodyTextProps[\s\S]{0,120}selectable: true/.test(mdSrc);
  return sheetHasCopy && bodySelectable ? true : '正文不可选，或面板缺少复制入口';
});

check('Thinking / 工具输出没有独立复制按钮', () => {
  // thinking 用 ThinkingAccordion、工具用 ToolCard；两者都不接受 copy 相关属性
  const thinkingSrc = readFileSync('src/components/Thinking.tsx', 'utf8');
  const toolSrc = readFileSync('src/components/ToolCard.tsx', 'utf8');
  const bad = /CopyTextButton|AssistantCopyRow|复制全文/.test(thinkingSrc) ||
    /CopyTextButton|AssistantCopyRow|复制全文/.test(toolSrc);
  return bad ? '思考/工具组件里出现了复制入口' : true;
});

check('面板有「复制全文」写入剪贴板（带成功反馈）', () => {
  const hasCopy = /copyTextToClipboard\(text\)/.test(sheetSrc);
  const hasLabel = /复制全文/.test(sheetSrc);
  const hasFeedback = /已复制/.test(sheetSrc);
  return hasCopy && hasLabel && hasFeedback ? true : '面板缺少复制/反馈';
});

check('Markdown 代码块渲染复制按钮', () =>
  /case 'code':[\s\S]{0,600}<CopyTextButton[\s\S]{0,200}accessibilityLabel="复制代码"/.test(mdSrc)
    ? true
    : '代码块没有复制按钮',
);

check('代码块正文仍可选择（selectable）', () =>
  /<Text style=\{styles\.codeText\} selectable>/.test(mdSrc) ? true : '代码块正文不可选择',
);

check('代码块不被外层长按 Pressable 包裹（避免抢复制按钮点击与代码选区）', () =>
  /b\.kind === 'code'/.test(mdSrc) ? true : '代码块仍被外层长按 Pressable 包裹',
);

check('代码块复制按钮具备清晰对比度与触控热区', () => {
  const btnSrc = readFileSync('src/components/CopyTextButton.tsx', 'utf8');
  return /color:\s*C\.textSecondary/.test(btnSrc) &&
    /minHeight:\s*28/.test(btnSrc) &&
    /minWidth:\s*48/.test(btnSrc) &&
    /hitSlop=/.test(btnSrc)
    ? true
    : 'CopyTextButton 对比度或热区不足';
});

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
