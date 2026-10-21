/**
 * 会话加载失败的可见性测试。
 *
 * 踩过的坑：`openChat` 失败时（WebSocket 连不上），界面只显示「空调话」，
 * 因为错误条被这个条件挡住了：
 *
 *   {chat.error && (chat.items.length > 0 || !isBlankChat) ? ... : null}
 *
 * 设计意图是「空会话静默重试」，实际后果是：后端有 46 条记录、
 * App 一条都加载不出来，用户对着空白猜了两小时，完全不知道
 * 是 WebSocket 401 导致的。
 *
 * 结论：加载失败必须显式告诉用户。这条测试把该行为钉死。
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

const chat = readFileSync('src/screens/ChatScreen.tsx', 'utf8');
const transport = readFileSync('src/core/transport/index.ts', 'utf8');
const store = readFileSync('src/core/store.ts', 'utf8');
const card = readFileSync('src/components/FileCard.tsx', 'utf8');

// ── 错误必须无条件可见 ────────────────────────────────────────────
check('错误条不再被「空会话」条件挡住', () => {
  // 找渲染 chat.error 的那段
  const m = /\{chat\.error\s*(\?|\&\&)/.exec(chat);
  if (!m) return '找不到 chat.error 的渲染';
  // 后面不能跟 items.length / isBlankChat 这类条件
  const around = chat.slice(m.index, m.index + 120);
  if (/items\.length|isBlankChat/.test(around)) {
    return '仍有「空会话就不显示」的条件';
  }
  return true;
});

check('错误条直接渲染 chat.error', () =>
  /\{chat\.error \? \(/.test(chat) ? true : '渲染条件不是直接判 chat.error',
);

// ── WS 失败要给出可操作的提示 ────────────────────────────────────
check('WS 失败提示说明查地址/服务', () =>
  chat.includes('WebSocket') || transport.includes('WebSocket 连接失败')
    ? true
    : '缺少 WS 失败提示',
);

check('openChat 失败会把错误写进 chat', () =>
  /catch \(e\)[\s\S]{0,400}error:/.test(store) ? true : 'openChat 没有记录错误',
);

// ── WebSocket 鉴权注释要写清楚（避免以后又被误改） ────────────────
check('openWebSocket 注释解释了 cookie 容器机制', () =>
  /openWebSocket[\s\S]{0,900}(cookie 容器|原生 cookie)/.test(transport)
    ? true
    : '缺少机制说明',
);

check('注释提醒排查时先看 cookie 域', () =>
  transport.includes('域匹配') || transport.includes('域和 WS') ? true : '缺少排查提示',
);

// ── 图片：下载失败要能看出来 ──────────────────────────────────────
check('FileCard 有 onError 回调', () =>
  card.includes('onError=') ? true : 'Image 没有 onError',
);

check('图片失败显示原因', () =>
  /图片加载失败/.test(card) ? true : '没有把失败原因显示出来',
);

// ── 绝对路径不走网关（网关只收相对路径） ──────────────────────────
check('绝对路径跳过网关下载', () =>
  /\^\[A-Za-z\]:\[\\\\\/\]/.test(card) || card.includes('^[A-Za-z]:[\\\\/]')
    ? true
    : '绝对路径仍会尝试网关（会被拒）',
);

// ── 图片显示兜底：base64 ─────────────────────────────────────────
check('有 base64 data URI 兜底', () =>
  card.includes('data:') && card.includes('base64') ? true : '缺少 base64 兜底',
);

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
