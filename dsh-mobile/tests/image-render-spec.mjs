/**
 * 图片渲染与下载的回归测试。
 *
 * 钉死两个真实踩过的坑：
 *
 * 1. `AssistantText` 必须走 AssistantRichText。
 *    之前它是纯 <Text>，管家贴的 `![封面](cover.jpg)` 在手机上就是
 *    一串字或直接消失 —— 用户报「图片显示不了」的根因之一。
 *
 * 2. 图片下载要走网关的 file-download-* 流程，且 offset 必须是
 *    「上一块 offset + 解码字节数」。协议明确不支持续传，写错就报
 *    `file-transfer-offset offset must match the next unread byte`。
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

const msg = readFileSync('src/components/Message.tsx', 'utf8');
const rich = readFileSync('src/components/AssistantRichText.tsx', 'utf8');
const card = readFileSync('src/components/FileCard.tsx', 'utf8');
const files = readFileSync('src/core/gatewayFiles.ts', 'utf8');
const chat = readFileSync('src/screens/ChatScreen.tsx', 'utf8');

// ── AssistantText 必须解析文件引用 ────────────────────────────────
check('AssistantText 用 AssistantRichText', () =>
  /export function AssistantText[\s\S]{0,600}AssistantRichText/.test(msg)
    ? true
    : '还在用纯 Text',
);
check('AssistantText 接受 sessionId', () =>
  /export function AssistantText[\s\S]{0,200}sessionId/.test(msg) ? true : '缺少 sessionId',
);
check('AssistantText 不再直接渲染 <Text>', () => {
  const body = /export function AssistantText[\s\S]*?\n}/.exec(msg);
  if (!body) return '找不到函数体';
  return body[0].includes('<Text') ? '仍在用 <Text>' : true;
});

// ── RichText 透传 ─────────────────────────────────────────────────
check('AssistantRichText 接受 sessionId', () =>
  rich.includes('sessionId?: string') ? true : '缺少参数',
);
check('RichText 把 sessionId 传给 FileCard', () =>
  /FileCard[\s\S]{0,200}sessionId=\{sessionId\}/.test(rich) ? true : '没透传',
);
check('分割出图片引用', () =>
  rich.includes('splitFileRefs') ? true : '没有解析 markdown',
);

// ── FileCard 下载顺序 ─────────────────────────────────────────────
check('FileCard 优先走网关', () =>
  /store\.gatewayChannel[\s\S]{0,400}downloadWorkspaceFile/.test(card)
    ? true
    : '没有先试网关',
);
check('网关失败退回 /api/file', () =>
  /downloadWorkspaceFile[\s\S]{0,800}fetchRemoteFile/.test(card) ? true : '没有回退',
);
check('FileCard 接受 sessionId', () =>
  card.includes('sessionId?: string') ? true : '缺少参数',
);

// ── 下载协议 ──────────────────────────────────────────────────────
check('发 file-download-open', () =>
  files.includes("'file-download-open'") ? true : '缺少',
);
check('发 file-download-read', () =>
  files.includes("'file-download-read'") ? true : '缺少',
);
check('失败时发 cancel', () =>
  files.includes("'file-download-cancel'") ? true : '缺少取消',
);
check('offset 用累加而非块内值', () => {
  // 必须见到 offset += bytes 这种写法
  return /offset \+= bytes/.test(files) ? true : 'offset 计算可能不对';
});
check('base64 字节数计算去掉 padding', () =>
  files.includes("endsWith('==')") ? true : 'padding 没处理',
);
check('eof 判断用 chunk.eof', () => files.includes('chunk.eof') ? true : '没有 eof 判断');
check('落盘用 base64 模式', () =>
  /writeFile\(dest, base64, 'base64'\)/.test(files) ? true : '写入方式不对',
);

// ── ChatScreen 透传 ──────────────────────────────────────────────
check('ChatScreen 给 AssistantText 传 sessionId', () =>
  /AssistantText[\s\S]{0,150}sessionId=\{sessionId\}/.test(chat) ? true : '没传',
);
check('ChatScreen 给 FileCard 传 sessionId', () =>
  (chat.match(/<FileCard[\s\S]{0,200}sessionId=\{sessionId\}/g) || []).length >= 2
    ? true
    : '有 FileCard 没传 sessionId',
);

// ── 危险文件名 ────────────────────────────────────────────────────
check('识别带冒号等危险名', () =>
  files.includes('hasRiskyName') ? true : '缺少判断函数',
);
check('危险名正则含中文冒号', () => {
  // 源码里应该出现中文全角冒号（U+FF1A）
  return files.includes('\uFF1A') ? true : '正则没覆盖中文冒号';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
