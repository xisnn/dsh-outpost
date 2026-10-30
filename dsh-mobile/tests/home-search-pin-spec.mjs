/**
 * F-07 首页全局搜索、会话置顶与状态徽标专项测试。
 *
 * 纯逻辑直接跑 Node；置顶存储注入内存适配器，不加载 RN/AsyncStorage。
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

const { searchSessionsAcrossWorkspaces, filterSessions } = await import(
  '../src/core/sessionSearch.ts'
);
const {
  parsePinnedSessions,
  sortSessionsWithPins,
  SessionPinStore,
  PINNED_SESSIONS_KEY,
} = await import('../src/core/sessionPins.ts');
const { approvalSessionIds, retrySessionIds, anySessionInSet } = await import(
  '../src/core/sessionStatus.ts'
);

const session = (sessionId, title, updatedAt = 1) => ({
  sessionId,
  updatedAt,
  projections: { values: { title } },
});
const ws1 = {
  path: 'E:\\work\\dsBot',
  name: 'dsBot',
  sessions: [session('a-1', 'Alpha 配置检查', 30), session('a-2', 'Beta 发布复盘', 20)],
};
const ws2 = {
  path: 'E:\\work\\demo',
  name: 'demo',
  sessions: [session('g-1', 'Gamma 搜索目标', 10)],
};
const workspaces = [ws1, ws2];

console.log('\n── 跨工作区搜索 ─────────────────────────────────');
check('空查询不产生全局结果（首页仍展示原工作区列表）', () =>
  searchSessionsAcrossWorkspaces(workspaces, '   ').length === 0 ? true : '空查询不应伪造结果',
);
check('按标题跨工作区搜索并保留工作区信息', () => {
  const r = searchSessionsAcrossWorkspaces(workspaces, 'gamma');
  return r.length === 1 && r[0].session.sessionId === 'g-1' && r[0].workspaceName === 'demo'
    ? true
    : JSON.stringify(r);
});
check('大小写不敏感', () =>
  searchSessionsAcrossWorkspaces(workspaces, 'ALPHA').length === 1 ? true : '未命中 Alpha',
);
check('可按工作区名 / 目录 / sessionId 搜索', () =>
  searchSessionsAcrossWorkspaces(workspaces, 'demo').length === 1 &&
  searchSessionsAcrossWorkspaces(workspaces, 'work\\dsbot').length === 2 &&
  searchSessionsAcrossWorkspaces(workspaces, 'a-2').length === 1
    ? true
    : '工作区/目录/sessionId 匹配失败',
);
check('多关键词 AND 过滤', () =>
  searchSessionsAcrossWorkspaces(workspaces, 'gamma demo').length === 1 &&
  searchSessionsAcrossWorkspaces(workspaces, 'gamma dsbot').length === 0
    ? true
    : '多关键词逻辑错误',
);
check('结果保持原列表顺序，不额外重排', () => {
  const r = searchSessionsAcrossWorkspaces(workspaces, ' ');
  // 空查询上面的用例已覆盖；这里用共同关键词验证原顺序
  const all = searchSessionsAcrossWorkspaces(workspaces, 'work');
  return r.length === 0 && all.map((x) => x.session.sessionId).join(',') === 'a-1,a-2,g-1'
    ? true
    : all.map((x) => x.session.sessionId).join(',');
});
check('原工作区内 filterSessions 行为不被全局搜索改变', () =>
  filterSessions(ws1.sessions, 'beta').length === 1 && filterSessions(ws1.sessions, '').length === 2
    ? true
    : '原搜索行为变化',
);

console.log('\n── 置顶解析与稳定排序 ─────────────────────────────');
check('置顶 JSON 容错、去重、过滤脏数据', () => {
  const r = parsePinnedSessions('["a","a",1,null,"b"]');
  return r.join(',') === 'a,b' && parsePinnedSessions('bad').length === 0
    ? true
    : JSON.stringify(r);
});
const base = [session('a', 'A'), session('b', 'B'), session('c', 'C')];
check('单个置顶排到最前，其余顺序不变', () =>
  sortSessionsWithPins(base, new Set(['c'])).map((s) => s.sessionId).join(',') === 'c,a,b'
    ? true
    : sortSessionsWithPins(base, new Set(['c'])).map((s) => s.sessionId).join(','),
);
check('多个置顶项之间也保持原相对顺序', () =>
  sortSessionsWithPins(base, new Set(['a', 'c'])).map((s) => s.sessionId).join(',') === 'a,c,b'
    ? true
    : sortSessionsWithPins(base, new Set(['a', 'c'])).map((s) => s.sessionId).join(','),
);
check('取消全部置顶后恢复原顺序', () =>
  sortSessionsWithPins(base, new Set()).map((s) => s.sessionId).join(',') === 'a,b,c'
    ? true
    : '原顺序变化',
);

function memoryStorage(initial = {}) {
  return {
    data: new Map(Object.entries(initial)),
    writes: 0,
    async getItem(k) {
      return this.data.has(k) ? this.data.get(k) : null;
    },
    async setItem(k, v) {
      this.writes += 1;
      this.data.set(k, v);
    },
  };
}

console.log('\n── 置顶持久化与失败回滚 ───────────────────────────');
const pinStorage = memoryStorage();
const pinStore = new SessionPinStore(pinStorage);
await pinStore.ensureHydrated();
await pinStore.toggle('a');
await pinStore.toggle('c');
const revivedPins = new SessionPinStore(pinStorage);
await revivedPins.ensureHydrated();
check('置顶在新实例（模拟 App 重启）后恢复', () =>
  revivedPins.isPinned('a') && revivedPins.isPinned('c') && !revivedPins.isPinned('b')
    ? true
    : revivedPins.list().join(','),
);
check('持久化 key 固定为 @dsh/pinnedSessions', () =>
  PINNED_SESSIONS_KEY === '@dsh/pinnedSessions' && pinStorage.data.has(PINNED_SESSIONS_KEY)
    ? true
    : '持久化 key 或未写盘',
);
let pinNotified = 0;
const unsubPin = revivedPins.subscribe(() => {
  pinNotified += 1;
});
await revivedPins.toggle('a');
unsubPin();
check('取消置顶立即通知 UI 并持久化', () =>
  !revivedPins.isPinned('a') && pinNotified > 0 ? true : `notified=${pinNotified}`,
);
const afterUnpin = new SessionPinStore(pinStorage);
await afterUnpin.ensureHydrated();
check('取消置顶后重启也不复活', () =>
  !afterUnpin.isPinned('a') && afterUnpin.isPinned('c') ? true : afterUnpin.list().join(','),
);
const failingStorage = memoryStorage();
failingStorage.setItem = async () => {
  throw new Error('disk full');
};
const failingStore = new SessionPinStore(failingStorage);
await failingStore.ensureHydrated();
let toggleThrew = false;
try {
  await failingStore.toggle('x');
} catch {
  toggleThrew = true;
}
check('置顶写盘失败抛错并回滚内存，不伪造已置顶', () =>
  toggleThrew && !failingStore.isPinned('x') ? true : '写失败被静默吞掉或内存未回滚',
);

console.log('\n── 状态徽标只来自真实数据 ─────────────────────────');
check('待审批只来自 PendingApproval.sessionId', () => {
  const ids = approvalSessionIds([
    { sessionId: 'a', rpcId: 'r1' },
    { sessionId: 'g', rpcId: 'r2' },
  ]);
  return ids.has('a') && ids.has('g') && !ids.has('b') ? true : '审批集合错误';
});
const record = (sessionId, state) => ({ sessionId, state });
check('待重试复用 canUserRetry，不包含发送中/已受理/已确认', () => {
  const ids = retrySessionIds([
    record('queued', 'queued'),
    record('preparing', 'preparing'),
    record('ready', 'ready'),
    record('unknown', 'unknown'),
    record('failed', 'failed'),
    record('sending', 'sending'),
    record('accepted', 'accepted'),
    record('confirmed', 'confirmed'),
    record('abandoned', 'abandoned'),
    record('expired', 'expired'),
  ]);
  return ['queued', 'preparing', 'ready', 'unknown', 'failed'].every((x) => ids.has(x)) &&
    ['sending', 'accepted', 'confirmed', 'abandoned', 'expired'].every((x) => !ids.has(x))
    ? true
    : [...ids].join(',');
});
check('工作区徽标只在内部会话真实命中时显示', () =>
  anySessionInSet([{ sessionId: 'a' }, { sessionId: 'b' }], new Set(['b'])) &&
  !anySessionInSet([{ sessionId: 'a' }], new Set(['z']))
    ? true
    : '工作区状态误报',
);

console.log('\n── UI 接线与既有行为静态检查 ──────────────────────');
const home = readFileSync('src/screens/WorkspacesScreen.tsx', 'utf8');
const sessions = readFileSync('src/screens/SessionsScreen.tsx', 'utf8');
check('首页有跨工作区搜索框', () =>
  /placeholder="搜索全部会话"/.test(home) && /searchSessionsAcrossWorkspaces/.test(home)
    ? true
    : '缺少全局搜索',
);
check('搜索结果直接进入 Chat', () =>
  /nav\.push\('Chat', \{ sessionId: session\.sessionId, title \}\)/.test(home)
    ? true
    : '搜索结果未直达聊天',
);
check('工作区待审批/待重试来自真实集合', () =>
  /approvalSessionIds\(store\.pendingApprovals\)/.test(home) &&
  /retrySessionIds\(records\)/.test(home) &&
  /anySessionInSet\(item\.sessions, approvalIds\)/.test(home) &&
  /anySessionInSet\(item\.sessions, retryIds\)/.test(home)
    ? true
    : '工作区状态来源不正确',
);
check('会话卡片有显式 ⋯ 操作入口且保留长按', () =>
  /styles\.moreText/.test(sessions) && /⋯/.test(sessions) && /onLongPress=/.test(sessions)
    ? true
    : '缺少 ⋯ 或长按被移除',
);
check('操作菜单支持置顶/取消置顶并持久化', () =>
  /sessionPinStore\.toggle\(id\)/.test(sessions) &&
  /sessionPinStore\.isPinned\(actionTarget\.id\) \? '取消置顶' : '置顶'/.test(sessions)
    ? true
    : '缺少置顶操作',
);
check('置顶排序通过稳定纯函数，不改变服务端顺序', () =>
  /sortSessionsWithPins\(filterSessions\(sessions, query\)/.test(sessions)
    ? true
    : '未使用稳定置顶排序',
);
check('删除确认与归档逻辑仍保留', () =>
  /<ConfirmSheet/.test(sessions) && /store\.archiveSession\(targetId\)/.test(sessions) &&
  /title="删除这个对话？"/.test(sessions)
    ? true
    : '删除确认或归档行为被破坏',
);
check('会话卡待审批/待重试来自真实 store 数据', () =>
  /approvalSessionIds\(store\.pendingApprovals\)/.test(sessions) &&
  /store\.pendingSends\.list\(\)/.test(sessions) && /⚠ 待审批/.test(sessions) && /↻ 待重试/.test(sessions)
    ? true
    : '会话状态来源不正确',
);
check('没有引入重型 UI 依赖', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return !deps['react-native-paper'] && !deps['@rneui/base'] && !deps['nativebase']
    ? true
    : '出现额外 UI 组件库';
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
