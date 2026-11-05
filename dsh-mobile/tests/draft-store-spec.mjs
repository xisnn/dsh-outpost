/**
 * F-04 会话输入草稿持久化专项测试。
 *
 * 纯函数：解析/序列化/清理（过期、已删除会话、容量上限、超长截断）。
 * 类：多会话隔离、防抖落盘、flush、重启恢复、clear/clearAll、订阅通知。
 * 静态接线：ChatScreen 保存/恢复/入队后清除、列表「草稿」标记、清除授权联动。
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

const mod = await import('../src/core/draftStore.ts');
const {
  parseDrafts,
  serializeDrafts,
  pruneDrafts,
  ComposerDraftStore,
  DRAFT_STORAGE_KEY,
  MAX_DRAFTS,
  MAX_DRAFT_CHARS,
  DRAFT_DEBOUNCE_MS,
  DRAFT_TTL_MS,
} = mod;

/** 内存版存储适配器（测试不引入 AsyncStorage 原生模块） */
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    writes: 0,
    async getItem(k) {
      return data.has(k) ? data.get(k) : null;
    },
    async setItem(k, v) {
      this.writes += 1;
      data.set(k, v);
    },
    async removeItem(k) {
      data.delete(k);
    },
  };
}

console.log('\n── 解析 / 序列化容错 ─────────────────────────────────');

check('null / 非法 JSON / 非数组 → 空', () =>
  parseDrafts(null).length === 0 &&
  parseDrafts('not json').length === 0 &&
  parseDrafts('{"a":1}').length === 0
    ? true
    : '非法输入没有安全回退',
);

check('空文本 / 缺 sessionId 丢弃', () => {
  const r = parseDrafts(
    JSON.stringify([
      { sessionId: 's1', text: '   ', updatedAt: 1 },
      { sessionId: '', text: 'x', updatedAt: 1 },
      { sessionId: 's2', text: '保留', updatedAt: 2 },
    ]),
  );
  return r.length === 1 && r[0].sessionId === 's2' ? true : JSON.stringify(r);
});

check('同一会话重复记录取最新', () => {
  const r = parseDrafts(
    JSON.stringify([
      { sessionId: 's1', text: 'old', updatedAt: 10 },
      { sessionId: 's1', text: 'new', updatedAt: 20 },
    ]),
  );
  return r.length === 1 && r[0].text === 'new' ? true : JSON.stringify(r);
});

check('超长草稿原样保留（不静默截断）', () => {
  const long = 'x'.repeat(MAX_DRAFT_CHARS + 500);
  const r = parseDrafts(JSON.stringify([{ sessionId: 's1', text: long, updatedAt: 1 }]));
  return r[0].text.length === long.length ? true : `len=${r[0].text.length}`;
});

check('序列化可按解析还原', () => {
  const records = [
    { sessionId: 'a', text: 'A', updatedAt: 2 },
    { sessionId: 'b', text: 'B', updatedAt: 1 },
  ];
  const back = parseDrafts(serializeDrafts(records));
  return back.length === 2 && back[0].sessionId === 'a' ? true : JSON.stringify(back);
});

console.log('\n── 清理（过期 / 已删除会话 / 容量） ─────────────────');

check('超过 TTL 的草稿被清理', () => {
  const now = 1_000_000_000;
  const kept = pruneDrafts(
    [
      { sessionId: 'old', text: 'x', updatedAt: now - DRAFT_TTL_MS - 1 },
      { sessionId: 'new', text: 'y', updatedAt: now - 1000 },
    ],
    { now },
  );
  return kept.length === 1 && kept[0].sessionId === 'new' ? true : JSON.stringify(kept);
});

check('已删除会话的草稿被清理', () => {
  const known = new Set(['alive']);
  const kept = pruneDrafts(
    [
      { sessionId: 'alive', text: 'x', updatedAt: 2 },
      { sessionId: 'deleted', text: 'y', updatedAt: 3 },
    ],
    { now: 10, knownSessionIds: known },
  );
  return kept.length === 1 && kept[0].sessionId === 'alive' ? true : JSON.stringify(kept);
});

check('knownSessionIds 为空集合时不误删草稿（防列表未加载完误清）', () => {
  const kept = pruneDrafts(
    [
      { sessionId: 's1', text: '草稿1', updatedAt: 2 },
      { sessionId: 's2', text: '草稿2', updatedAt: 3 },
    ],
    { now: 10, knownSessionIds: new Set() },
  );
  return kept.length === 2 ? true : JSON.stringify(kept);
});

check('超过上限只保留最近 50 条', () => {
  const now = 1_000_000;
  const records = Array.from({ length: 60 }, (_, i) => ({
    sessionId: `s${i}`,
    text: `t${i}`,
    updatedAt: now - i,
  }));
  const kept = pruneDrafts(records, { now });
  return kept.length === MAX_DRAFTS ? true : `kept=${kept.length}`;
});

console.log('\n── 存储类：多会话隔离 / 防抖 / 重启恢复 ─────────────');

async function run() {
  const storage = memoryStorage();
  const store = new ComposerDraftStore(storage);
  await store.ensureHydrated();

  store.set('s1', '第一会话草稿');
  store.set('s2', '第二会话草稿');
  check('按 sessionId 独立保存', () => {
    return store.get('s1') === '第一会话草稿' && store.get('s2') === '第二会话草稿'
      ? true
      : JSON.stringify({ s1: store.get('s1'), s2: store.get('s2') });
  });
  check('has() 只对非空草稿为 true', () =>
    store.has('s1') && !store.has('s3') ? true : '空/不存在会话误报',
  );

  check('set 超长文本不截断（由输入框 maxLength 负责）', () => {
    const long = '长'.repeat(MAX_DRAFT_CHARS + 200);
    const longStore = new ComposerDraftStore(memoryStorage());
    longStore.set('long-session', long);
    return longStore.get('long-session').length === long.length
      ? true
      : `len=${longStore.get('long-session').length}`;
  });

  check('300ms 防抖内不写盘（防输入卡顿）', () => storage.writes === 0, `writes=${storage.writes}`);
  await new Promise((r) => setTimeout(r, DRAFT_DEBOUNCE_MS + 120));
  check('防抖窗口结束后自动落盘一次', () => storage.writes === 1, `writes=${storage.writes}`);

  // 模拟 App 重启：新实例从同一存储恢复
  const revived = new ComposerDraftStore(storage);
  await revived.ensureHydrated();
  check('重启后（新实例）恢复全部草稿', () =>
    revived.get('s1') === '第一会话草稿' && revived.get('s2') === '第二会话草稿'
      ? true
      : JSON.stringify({ s1: revived.get('s1'), s2: revived.get('s2') }),
  );

  // flush：页面卸载时立即落盘
  store.set('s3', '未防抖完成就退出');
  await store.flush();
  const revived2 = new ComposerDraftStore(storage);
  await revived2.ensureHydrated();
  check('flush 后新实例能恢复', () => (revived2.get('s3') === '未防抖完成就退出' ? true : 'flush 丢失'));

  // clear：发送入队成功后删除
  await store.clear('s1');
  const revived3 = new ComposerDraftStore(storage);
  await revived3.ensureHydrated();
  check('clear 后持久化里也删掉', () =>
    store.get('s1') === '' && revived3.get('s1') === '' ? true : 'clear 没落盘',
  );

  // 订阅通知
  let notified = 0;
  const unsub = store.subscribe(() => {
    notified += 1;
  });
  store.set('s4', 'x');
  unsub();
  check('草稿变化会通知列表刷新', () => (notified > 0 ? true : '没有通知订阅者'));

  // 容量上限
  const bulk = memoryStorage();
  const bulkStore = new ComposerDraftStore(bulk);
  await bulkStore.ensureHydrated();
  for (let i = 0; i < 55; i += 1) {
    bulkStore.set(`bulk-${i}`, `text-${i}`);
    await new Promise((r) => setTimeout(r, 2));
  }
  await bulkStore.flush();
  const restoredBulk = new ComposerDraftStore(bulk);
  await restoredBulk.ensureHydrated();
  check('写入 55 条后只保留 50 条', () =>
    restoredBulk.size() <= MAX_DRAFTS ? true : `size=${restoredBulk.size()}`,
  );

  // prune 已删除会话
  const orphanStore = new ComposerDraftStore(storage);
  await orphanStore.ensureHydrated();
  orphanStore.set('orphan-session', '没有对应会话的残稿');
  await orphanStore.flush();
  const prunedCount = await orphanStore.prune(['s2', 's3', 's4']);
  check('prune 清掉已删除会话的草稿', () =>
    prunedCount >= 1 && !orphanStore.has('orphan-session') ? true : `pruned=${prunedCount}`,
  );

  // clearAll（退出并清除所有授权）
  await revived3.clearAll();
  const afterClear = new ComposerDraftStore(storage);
  await afterClear.ensureHydrated();
  check('clearAll 清空持久化（退出并清除授权）', () =>
    afterClear.size() === 0 && !storage.data.has(DRAFT_STORAGE_KEY) ? true : 'clearAll 有残留',
  );

  // ── 竞态：防抖中 clear 不能被旧写入复活 ────────────────────────
  const raceStorage = memoryStorage();
  const raceStore = new ComposerDraftStore(raceStorage);
  await raceStore.ensureHydrated();
  raceStore.set('race-1', '要删除的草稿');
  await raceStore.clear('race-1'); // clear 早于 300ms 防抖触发
  await new Promise((r) => setTimeout(r, DRAFT_DEBOUNCE_MS + 200));
  const raceReload = new ComposerDraftStore(raceStorage);
  await raceReload.ensureHydrated();
  check('防抖窗口内 clear 后，旧草稿不会复活', () =>
    raceReload.get('race-1') === '' ? true : `resurrected=${JSON.stringify(raceReload.get('race-1'))}`,
  );

  // ── 竞态：慢存储下写入顺序错乱不覆盖新状态 ──────────────────────
  let delayed = null;
  const slowStorage = {
    data: new Map(),
    async getItem(k) {
      return this.data.has(k) ? this.data.get(k) : null;
    },
    async setItem(k, v) {
      // 第一次写入故意延迟，模拟「旧写入姗姗来迟」
      if (!delayed) {
        delayed = new Promise((resolve) => setTimeout(resolve, 120));
        await delayed;
      }
      this.data.set(k, v);
    },
    async removeItem(k) {
      this.data.delete(k);
    },
  };
  const slowStore = new ComposerDraftStore(slowStorage);
  await slowStore.ensureHydrated();
  slowStore.set('slow-1', '旧内容');
  const slowFlush1 = slowStore.flush(); // 这次写会慢
  slowStore.set('slow-1', '新内容');
  const slowFlush2 = slowStore.flush();
  await Promise.all([slowFlush1, slowFlush2]);
  const slowReload = new ComposerDraftStore(slowStorage);
  await slowReload.ensureHydrated();
  check('慢存储下后写的新草稿不被旧写入覆盖', () =>
    slowReload.get('slow-1') === '新内容' ? true : `got=${JSON.stringify(slowReload.get('slow-1'))}`,
  );

  // ── 快速切换会话：各会话草稿独立 ────────────────────────────────
  const switchStorage = memoryStorage();
  const switchStore = new ComposerDraftStore(switchStorage);
  await switchStore.ensureHydrated();
  switchStore.set('sess-A', 'A 的草稿');
  switchStore.set('sess-B', 'B 的草稿');
  switchStore.set('sess-A', 'A 的新草稿');
  await switchStore.flush();
  const switchReload = new ComposerDraftStore(switchStorage);
  await switchReload.ensureHydrated();
  check('快速切换会话草稿不串、不丢', () =>
    switchReload.get('sess-A') === 'A 的新草稿' && switchReload.get('sess-B') === 'B 的草稿'
      ? true
      : JSON.stringify({ a: switchReload.get('sess-A'), b: switchReload.get('sess-B') }),
  );

  // ── hydrate 与输入竞态：输入内容不能被磁盘旧值覆盖 ──────────────
  const hydrationStorage = memoryStorage({
    [DRAFT_STORAGE_KEY]: JSON.stringify([{ sessionId: 'hyd-1', text: '磁盘旧值', updatedAt: 1 }]),
  });
  const hydrationStore = new ComposerDraftStore(hydrationStorage);
  const hydratePromise = hydrationStore.ensureHydrated();
  hydrationStore.set('hyd-1', '用户刚输入的新值');
  await hydratePromise;
  check('hydrate 竞态下用户输入不被旧草稿覆盖', () =>
    hydrationStore.get('hyd-1') === '用户刚输入的新值'
      ? true
      : JSON.stringify(hydrationStore.get('hyd-1')),
  );

  // ── 竞态：ensureHydrated 慢读在 clearAll 之后返回，不得复活旧草稿 ──
  const slowHydrateStorage = {
    raw: JSON.stringify([{ sessionId: 'ghost-1', text: '本该被清掉的旧草稿', updatedAt: 100 }]),
    async getItem() {
      await new Promise((r) => setTimeout(r, 80));
      return this.raw;
    },
    async setItem(_k, v) {
      this.raw = v;
    },
    async removeItem() {
      this.raw = null;
    },
  };
  const ghostStore = new ComposerDraftStore(slowHydrateStorage);
  const inflightHydrate = ghostStore.ensureHydrated();
  await new Promise((r) => setTimeout(r, 10));
  await ghostStore.clearAll();
  await inflightHydrate;
  check('clearAll 与进行中的 ensureHydrated 竞态时不复活旧草稿', () =>
    ghostStore.size() === 0 && ghostStore.get('ghost-1') === ''
      ? true
      : `size=${ghostStore.size()}`,
  );

  // ── clearAll 失败处理：即使内存尚未 hydrate，存储删除失败也必须抛错 ──
  const failingClearStorage = {
    async getItem() {
      return JSON.stringify([{ sessionId: 'leftover', text: '残留草稿', updatedAt: 1 }]);
    },
    async setItem() {},
    async removeItem() {
      // 模拟 removeItem 静默未生效或抛错
    },
  };
  const unhydratedClearStore = new ComposerDraftStore(failingClearStorage);
  let clearThrew = false;
  try {
    await unhydratedClearStore.clearAll();
  } catch {
    clearThrew = true;
  }
  check('clearAll 回读发现仍有残留时必须抛错（即使调用前未 hydrate）', () =>
    clearThrew ? true : 'clearAll 未抛错，删除失败被静默忽略',
  );
}

await run();

console.log('\n── UI 接线静态检查 ─────────────────────────────────');

const chatSrc = readFileSync('src/screens/ChatScreen.tsx', 'utf8');
const composerSrc = readFileSync('src/components/ChatComposer.tsx', 'utf8');
const sessionsSrc = readFileSync('src/screens/SessionsScreen.tsx', 'utf8');
const workspacesSrc = readFileSync('src/screens/WorkspacesScreen.tsx', 'utf8');
const appSrc = readFileSync('src/App.tsx', 'utf8');
const draftSrc = readFileSync('src/core/draftStore.ts', 'utf8');

check('ChatScreen 进入会话时恢复草稿', () =>
  /draftStore\.get\(sessionId\)/.test(chatSrc) && /draftStore\.ensureHydrated\(\)/.test(chatSrc)
    ? true
    : '没有恢复草稿',
);
check('ChatScreen 输入变化写入草稿', () =>
  /onChangeText=\{\(text\) => \{[\s\S]{0,200}setDraft\(text\);[\s\S]{0,200}draftStore\.set\(sessionId, text\)/.test(chatSrc) &&
  /onChangeText=\{onChangeText\}/.test(composerSrc) ? true : '输入没有接草稿存储',
);
check('ChatScreen 发送成功后清除草稿', () =>
  /await store\.sendPending[\s\S]{0,240}await draftStore\.clear\(sessionId\)/.test(chatSrc)
    ? true
    : 'sendPending 成功后没有清草稿',
);
check('入队失败恢复文本且保留草稿（不丢字）', () =>
  /setDraft\(text\)/.test(chatSrc) && /draftStore\.set\(sessionId, text\)/.test(chatSrc)
    ? true
    : '失败路径没有恢复草稿',
);
check('入队成功但发送失败时不重复留草稿', () =>
  /queued[\s\S]{0,200}draftStore\.clear\(sessionId\)/.test(chatSrc) ? true : '缺少 queued 判定',
);
check('页面卸载时 flush 防抖草稿', () =>
  /draftStore\.flush\(\)/.test(chatSrc) ? true : '卸载没有 flush',
);
check('切后台时 flush 缩小强制停止丢字窗口', () =>
  /AppState\.addEventListener\('change'[\s\S]{0,120}draftStore\.flush\(\)/.test(chatSrc)
    ? true
    : '缺少 AppState flush',
);
check('输入框达到上限时有可见提示（不静默丢字）', () =>
  /maxLength=\{MAX_DRAFT_CHARS\}/.test(chatSrc) &&
  /maxLength=\{maxLength\}/.test(composerSrc) &&
  /已达 \{maxLength\} 字草稿上限/.test(composerSrc)
    ? true
    : '缺少草稿上限提示或 maxLength', 
);
check('会话列表显示「草稿」标记', () =>
  /✎ 草稿/.test(sessionsSrc) && /draftStore\.has\(item\.sessionId\)/.test(sessionsSrc)
    ? true
    : 'SessionsScreen 缺少草稿标记',
);
check('工作区列表显示「草稿」标记', () =>
  /✎ 草稿/.test(workspacesSrc) && /draftStore\.has\(s\.sessionId\)/.test(workspacesSrc)
    ? true
    : 'WorkspacesScreen 缺少草稿标记',
);
check('退出并清除授权时同步清理草稿且不静默吞错', () =>
  /await draftStore\.clearAll\(\)/.test(appSrc) &&
  !/draftStore\.clearAll\(\)\.catch/.test(appSrc) &&
  /result\.local\.drafts === 'cleared'/.test(appSrc) &&
  /result\.local\.drafts === 'failed'/.test(appSrc)
    ? true
    : 'clearAuthorization 仍静默忽略草稿清除失败或未纳入 isFullyClear/notifyClearResult',
);
check('列表 prune 仅在完整加载无错时按全量 store.sessions 清理（不用过滤后的 workspaces）', () =>
  /!store\.sessionsLoading/.test(sessionsSrc) &&
  /!store\.sessionsError/.test(sessionsSrc) &&
  /store\.sessions\.length > 0/.test(sessionsSrc) &&
  !/draftStore\.prune\(store\.workspaces/.test(sessionsSrc) &&
  !/draftStore\.prune\(store\.workspaces/.test(workspacesSrc) &&
  /await draftStore\.clear\(targetId\)/.test(sessionsSrc)
    ? true
    : 'SessionsScreen / WorkspacesScreen 的 prune 条件不安全',
);
check('草稿模块不依赖通信/认证/审批/PendingSend', () => {
  const imports = [...draftSrc.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const forbidden = imports.filter((p) =>
    /pendingSend|transport|approval|secureStore|deviceRevocation|credential/i.test(p),
  );
  return forbidden.length === 0 ? true : `引入了：${forbidden.join(', ')}`;
});
check('草稿内容不写日志', () => (/console\.(log|warn|error)/.test(draftSrc) ? '草稿模块有日志输出' : true));
check('草稿存储 key 固定为 @dsh/chatDrafts', () =>
  DRAFT_STORAGE_KEY === '@dsh/chatDrafts' ? true : DRAFT_STORAGE_KEY,
);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
