/**
 * 会话搜索 / 重命名 / 长会话虚拟化的测试。
 *
 * 搜索逻辑是纯函数，直接测。重命名和虚拟化是接入检查（读源码断言）。
 */

import { readFileSync } from 'node:fs';
import { filterSessions } from '../src/core/sessionSearch.ts';

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

// ── 搜索 ────────────────────────────────────────────────────────
const s = (title) => ({ projections: { values: { title } } });

check('空查询返回全部', () => {
  const list = [s('aaaa'), s('bbbb')];
  return filterSessions(list, '').length === 2 ? true : '空查询不该过滤';
});

check('只有空格也返回全部', () => {
  const list = [s('aaaa'), s('bbbb')];
  return filterSessions(list, '   ').length === 2 ? true : '空格查询不该过滤';
});

check('按标题匹配', () => {
  const list = [s('设计 Bot 方案'), s('计算 1 到 100')];
  const r = filterSessions(list, 'bot');
  return r.length === 1 && r[0].projections.values.title === '设计 Bot 方案'
    ? true
    : JSON.stringify(r);
});

check('大小写不敏感', () => {
  const list = [s('DSH Pocket'), s('其他')];
  return (
    filterSessions(list, 'dsh').length === 1 && filterSessions(list, 'DSH').length === 1
  );
});

check('中文匹配', () => {
  const list = [s('测试文档'), s('生产环境')];
  const r = filterSessions(list, '文档');
  return r.length === 1 ? true : JSON.stringify(r);
});

check('多个关键词 AND', () => {
  const list = [s('设计 Bot 方案'), s('设计 一个 页面'), s('Bot 部署')];
  const r = filterSessions(list, '设计 bot');
  return r.length === 1 && r[0].projections.values.title === '设计 Bot 方案'
    ? true
    : JSON.stringify(r.map((x) => x.projections.values.title));
});

check('标题为 null 不崩', () => {
  const list = [{ projections: { values: { title: null } } }, s('正常标题')];
  const r = filterSessions(list, '正常');
  return r.length === 1 ? true : JSON.stringify(r);
});

check('没有 projections 不崩', () => {
  const list = [{}, s('有标题')];
  const r = filterSessions(list, '有');
  return r.length === 1 ? true : JSON.stringify(r);
});

check('没匹配返回空数组', () => {
  const list = [s('aaa'), s('bbb')];
  return filterSessions(list, 'zzz').length === 0 ? true : '应该返回空';
});

check('前后空格被忽略', () => {
  const list = [s('测试文档')];
  return filterSessions(list, '  测试  ').length === 1 ? true : '没忽略空格';
});

// ── 重命名 ──────────────────────────────────────────────────────
const store = readFileSync('src/core/store.ts', 'utf8');
const sessions = readFileSync('src/screens/SessionsScreen.tsx', 'utf8');
const rename = readFileSync('src/components/RenameSheet.tsx', 'utf8');

check('store 暴露 renameSession', () =>
  /async renameSession\(/.test(store) ? true : 'store 没有 renameSession',
);

check('renameSession 调用了 DSH 的 session/rename', () => {
  const i = store.indexOf('async renameSession');
  if (i < 0) return '找不到方法';
  return /this\.api\.rename\(/.test(store.slice(i, i + 500)) ? true : '没调用 api.rename';
});

check('重命名后同步本地列表', () => {
  const i = store.indexOf('async renameSession');
  const body = store.slice(i, i + 1200);
  return /this\.sessions = this\.sessions\.map/.test(body) ? true : '没同步 sessions 缓存';
});

check('重命名后同步聊天缓存', () => {
  const i = store.indexOf('async renameSession');
  const body = store.slice(i, i + 1200);
  return /this\.chats\.set/.test(body) ? true : '没同步 chats 缓存';
});

check('改名弹层有输入框和字数限制', () =>
  rename.includes('TextInput') && rename.includes('MAX_TITLE_LEN')
    ? true
    : '缺少输入框或字数限制',
);

check('空名字不能保存', () =>
  /trimmed\.length > 0/.test(rename) ? true : '空名字也能保存',
);

check('长按弹操作菜单而不是直接删除', () =>
  /askActions\(/.test(sessions) && !/onLongPress=\{\(\) => askDelete/.test(sessions)
    ? true
    : '长按还是直接走删除',
);

check('操作菜单里有重命名和删除两项', () =>
  sessions.includes('重命名') && sessions.includes('删除') ? true : '菜单项不全',
);

// ── 虚拟化 ──────────────────────────────────────────────────────
const chat = readFileSync('src/screens/ChatScreen.tsx', 'utf8');

check('聊天页用 FlatList 而不是 ScrollView+map', () =>
  /<FlatList/.test(chat) ? true : '聊天页还是 ScrollView',
);

check('聊天页不再有 items.map 全量渲染', () => {
  // 允许注释里出现，但不能有实际的 chat.items.map
  const code = chat
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  return /chat\.items\.map\(/.test(code) ? '还在全量 map 渲染' : true;
});

check('FlatList 配置了分批渲染', () =>
  chat.includes('initialNumToRender') && chat.includes('maxToRenderPerBatch')
    ? true
    : '没配分批渲染参数',
);

check('滚动到底部用 scrollToEnd', () =>
  chat.includes('scrollToEnd') ? true : '自动滚动失效',
);

check('scorllRef 类型是 FlatList', () =>
  /useRef<FlatList<ChatItem>>/.test(chat) ? true : 'ref 类型不对',
);

// ── 会话列表也做了虚拟化参数 ────────────────────────────────────
check('会话列表也配了分批渲染', () => {
  return sessions.includes('initialNumToRender') && sessions.includes('maxToRenderPerBatch')
    ? true
    : '会话列表没配分批渲染';
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
