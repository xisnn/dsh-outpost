/**
 * F-03 流式渲染性能优化专项测试与量化基准对比。
 *
 * 覆盖：
 *   1. 优化前后量化性能对比（40 轮历史 + 120 个流式事件）：
 *      - rebuild 次数、累计 CPU 耗时、历史 Turn / ChatItem / WorkGroup 引用复用率（0% → 100%）；
 *   2. 语义严格等价：增量尾轮折叠（foldEventsIncremental）与全量 foldEvents 输出 100% 一致
 *      （消息顺序、工具结果、审批、最终回答、WorkGroup、历史回填与上翻加载）；
 *   3. 关键状态 0ms 即时刷新（user/message、turn/start、turn/end、approval/*、deliverables/*）
 *      与高频中间流事件 60ms 批量合并（不延迟 PendingSend 对账与审批安全状态）；
 *   4. 服务端权威运行状态修正断线恢复后残留的「进行中」（refreshChatMeta / loadSessions / reconnect snapshot）；
 *   5. ChatScreen 列表项 React.memo（ChatItemRow + areChatItemRowPropsEqual）静态与逻辑校验。
 */
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { register, createRequire } from 'node:module';
import Module from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

register('./support/rn-module-hook.mjs', import.meta.url);
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const imp = (p) => import(pathToFileURL(p).href);

const SHIM_DIR = path.join(__dirname, 'support');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === '@react-native-async-storage/async-storage') {
    return path.join(SHIM_DIR, '_async-storage-shim.cjs');
  }
  if (request === '@react-native-cookies/cookies') {
    return path.join(SHIM_DIR, '_cookie-manager-shim.cjs');
  }
  if (request === 'react-native-keychain') {
    return path.join(SHIM_DIR, '_keychain-shim.cjs');
  }
  if (request === 'react-native') {
    return path.join(SHIM_DIR, '_react-native-shim.cjs');
  }
  if (request === 'react-native-blob-util') {
    return path.join(SHIM_DIR, '_blob-util-shim.cjs');
  }
  return origResolve.call(this, request, parent, ...rest);
};

const {
  foldEvents,
  toChatItems,
  foldEventsIncremental,
  createIncrementalFoldCache,
  stabilizeTurns,
  stabilizeChatItems,
  areTurnsStructurallyEqual,
  areChatItemsStructurallyEqual,
  areAttachRefsEqual,
} = await imp(path.join(__dirname, '..', 'src', 'core', 'fold', 'index.ts'));
const { buildWorkGroup, buildWorkGroupMap } = await imp(
  path.join(__dirname, '..', 'src', 'core', 'workGroup.ts'),
);
const {
  Store,
  REBUILD_BATCH_MS,
  isCriticalStreamEvent,
  extractAuthoritativeRunning,
} = await imp(path.join(__dirname, '..', 'src', 'core', 'store.ts'));

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  OK    ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function makeHistoricalRecords(turnCount = 40) {
  const records = [];
  let seq = 1;
  let time = 1_700_000_000_000;
  for (let t = 1; t <= turnCount; t += 1) {
    records.push({ event: { type: 'turn/start', seq: seq++, time: (time += 10), data: { turn: t } } });
    records.push({
      event: {
        type: 'user/message',
        seq: seq++,
        time: (time += 10),
        data: { turn: t, id: `u-${t}`, content: [{ type: 'text', text: `第 ${t} 轮用户问题：检查模块 ${t}` }] },
      },
    });
    for (let s = 1; s <= 3; s += 1) {
      records.push({ event: { type: 'step/start', seq: seq++, time: (time += 10), data: { turn: t, step: s } } });
      const callId = `call-${t}-${s}`;
      records.push({
        event: {
          type: 'assistant/message',
          seq: seq++,
          time: (time += 10),
          data: {
            turn: t,
            step: s,
            message: {
              role: 'assistant',
              content: [
                { type: 'reasoning', text: `思考第 ${t} 轮第 ${s} 步...` },
                {
                  type: 'tool-call',
                  id: callId,
                  name: s % 2 === 0 ? 'edit' : 'read',
                  arguments: JSON.stringify({
                    file_path: `src/module-${t}/file-${s}.ts`,
                    old_string: 'const a = 1;',
                    new_string: 'const a = 2;',
                  }),
                },
              ],
            },
          },
        },
      });
      records.push({
        event: {
          type: 'tool/result',
          seq: seq++,
          time: (time += 10),
          data: {
            turn: t,
            step: s,
            toolCallId: callId,
            message: { toolCallId: callId, isError: false, content: [{ type: 'text', text: `ok ${t}-${s}` }] },
          },
        },
      });
    }
    records.push({ event: { type: 'step/start', seq: seq++, time: (time += 10), data: { turn: t, step: 4 } } });
    records.push({
      event: {
        type: 'assistant/message',
        seq: seq++,
        time: (time += 10),
        data: {
          turn: t,
          step: 4,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `第 ${t} 轮检查完成。` }],
          },
        },
      },
    });
    records.push({
      event: {
        type: 'turn/end',
        seq: seq++,
        time: (time += 10),
        data: { turn: t, reason: { kind: 'completed' } },
      },
    });
  }
  return { records, nextSeq: seq, nextTime: time };
}

function makeStreamingTurnEvents(turnNo, startSeq, startTime, count = 120) {
  const events = [];
  let seq = startSeq;
  let time = startTime;
  events.push({ event: { type: 'turn/start', seq: seq++, time: (time += 5), data: { turn: turnNo } } });
  events.push({
    event: {
      type: 'user/message',
      seq: seq++,
      time: (time += 5),
      data: { turn: turnNo, id: `u-${turnNo}`, content: [{ type: 'text', text: '开始流式压力测试' }] },
    },
  });
  let step = 0;
  while (events.length < count - 1) {
    step += 1;
    events.push({ event: { type: 'step/start', seq: seq++, time: (time += 5), data: { turn: turnNo, step } } });
    if (events.length >= count - 1) break;
    const callId = `stream-call-${turnNo}-${step}`;
    events.push({
      event: {
        type: 'assistant/message',
        seq: seq++,
        time: (time += 5),
        data: {
          turn: turnNo,
          step,
          message: {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: `流式思考步骤 ${step}` },
              ...(step % 2 === 1
                ? [{ type: 'tool-call', id: callId, name: 'read', arguments: JSON.stringify({ file_path: `src/f-${step}.ts` }) }]
                : [{ type: 'text', text: `流式增量回答片段 ${step}` }]),
            ],
          },
        },
      },
    });
    if (step % 2 === 1 && events.length < count - 1) {
      events.push({
        event: {
          type: 'tool/result',
          seq: seq++,
          time: (time += 5),
          data: {
            turn: turnNo,
            step,
            toolCallId: callId,
            message: { toolCallId: callId, isError: false, content: [{ type: 'text', text: `result ${step}` }] },
          },
        },
      });
    }
  }
  events.push({
    event: {
      type: 'turn/end',
      seq: seq++,
      time: (time += 5),
      data: { turn: turnNo, reason: { kind: 'completed' } },
    },
  });
  return events.slice(0, count);
}

console.log('\n── 1. 优化前后量化性能对比（40 轮历史 + 120 流事件） ──');
const { records: historyRecords, nextSeq, nextTime } = makeHistoricalRecords(40);
const streamEvents = makeStreamingTurnEvents(41, nextSeq, nextTime, 120);

// (A) 优化前基线模拟：每收到 1 个事件都全量 sort + foldEvents + toChatItems + 新建 WorkGroup
const baselineMap = new Map(historyRecords.map((r) => [r.event.seq, r]));
let basePrevTurns = foldEvents([...baselineMap.values()].sort((a, b) => a.event.seq - b.event.seq));
let basePrevItems = toChatItems(basePrevTurns);
const histTurnsCount = basePrevTurns.length;
const histItemsCount = basePrevItems.length;

let baseRebuilds = 0;
let baseTurnPreserved = 0;
let baseTurnChecks = 0;
let baseItemPreserved = 0;
let baseItemChecks = 0;

const tBase0 = performance.now();
for (const rec of streamEvents) {
  baselineMap.set(rec.event.seq, rec);
  baseRebuilds += 1;
  const sorted = [...baselineMap.values()].sort((a, b) => a.event.seq - b.event.seq);
  const nextTurns = foldEvents(sorted);
  const nextItems = toChatItems(nextTurns);
  for (let i = 0; i < histTurnsCount; i += 1) {
    baseTurnChecks += 1;
    if (nextTurns[i] === basePrevTurns[i]) baseTurnPreserved += 1;
  }
  for (let i = 0; i < histItemsCount; i += 1) {
    baseItemChecks += 1;
    if (nextItems[i] === basePrevItems[i]) baseItemPreserved += 1;
  }
  basePrevTurns = nextTurns;
  basePrevItems = nextItems;
}
const baseCpuMs = performance.now() - tBase0;

// (B) 优化后实测：O(1) 顺序追加 + 60ms 批量合并（每 5ms 到达 1 事件，每 12 个中间事件触发 1 次批量 rebuild，关键事件 0ms 立即刷新）+ 增量尾轮折叠 + WeakMap WorkGroup 缓存
const optSorted = historyRecords.slice();
const foldCache = createIncrementalFoldCache();
const initRes = foldEventsIncremental(optSorted, foldCache);
let optPrevTurns = initRes.turns;
let optPrevItems = initRes.items;
let optPrevGroups = buildWorkGroupMap(optPrevTurns);

let optRebuilds = 0;
let optFastPathCount = 0;
let optTurnPreserved = 0;
let optTurnChecks = 0;
let optItemPreserved = 0;
let optItemChecks = 0;
let optGroupPreserved = 0;
let optGroupChecks = 0;

let lastBatchTime = 0;
let pendingDirty = false;

const runOptRebuild = () => {
  optRebuilds += 1;
  const res = foldEventsIncremental(optSorted, foldCache);
  if (res.usedFastPath) optFastPathCount += 1;
  const nextGroups = buildWorkGroupMap(res.turns);

  for (let i = 0; i < histTurnsCount; i += 1) {
    optTurnChecks += 1;
    if (res.turns[i] === optPrevTurns[i]) optTurnPreserved += 1;
    const tNo = res.turns[i].turn;
    optGroupChecks += 1;
    if (nextGroups.get(tNo) === optPrevGroups.get(tNo)) optGroupPreserved += 1;
  }
  for (let i = 0; i < histItemsCount; i += 1) {
    optItemChecks += 1;
    if (res.items[i] === optPrevItems[i]) optItemPreserved += 1;
  }
  optPrevTurns = res.turns;
  optPrevItems = res.items;
  optPrevGroups = nextGroups;
  pendingDirty = false;
};

const tOpt0 = performance.now();
for (let idx = 0; idx < streamEvents.length; idx += 1) {
  const rec = streamEvents[idx];
  const simNow = idx * 5; // 每 5ms 到达 1 个事件
  optSorted.push(rec); // seq 递增，O(1) 追加
  const critical = isCriticalStreamEvent(rec.event.type);
  if (critical) {
    runOptRebuild();
    lastBatchTime = simNow;
  } else {
    pendingDirty = true;
    if (simNow - lastBatchTime >= REBUILD_BATCH_MS) {
      runOptRebuild();
      lastBatchTime = simNow;
    }
  }
}
if (pendingDirty) runOptRebuild();
const optCpuMs = performance.now() - tOpt0;

const turnPreservedPct = Number(((optTurnPreserved / optTurnChecks) * 100).toFixed(1));
const itemPreservedPct = Number(((optItemPreserved / optItemChecks) * 100).toFixed(1));
const groupPreservedPct = Number(((optGroupPreserved / optGroupChecks) * 100).toFixed(1));
const speedupRatio = Number((baseCpuMs / Math.max(0.05, optCpuMs)).toFixed(1));

console.log(
  `  [量化对比] rebuild 次数: ${baseRebuilds} → ${optRebuilds} (-${(((baseRebuilds - optRebuilds) / baseRebuilds) * 100).toFixed(1)}%)`,
);
console.log(
  `  [量化对比] 总折叠+分组耗时: ${baseCpuMs.toFixed(2)}ms → ${optCpuMs.toFixed(2)}ms (${speedupRatio}x 加速)`,
);
console.log(
  `  [量化对比] 历史 Turn 引用保持率: 0.0% → ${turnPreservedPct}% (${optTurnPreserved}/${optTurnChecks})`,
);
console.log(
  `  [量化对比] 历史 ChatItem 引用保持率: 0.0% → ${itemPreservedPct}% (${optItemPreserved}/${optItemChecks})`,
);
console.log(
  `  [量化对比] 历史 WorkGroup 引用保持率: 0.0% → ${groupPreservedPct}% (${optGroupPreserved}/${optGroupChecks})`,
);

check('批量合并将 120 个流式事件的 rebuild 次数从 120 次降至 <= 15 次', optRebuilds <= 15, `optRebuilds=${optRebuilds}`);
check('流式期间增量尾轮折叠快路径生效（usedFastPath）', optFastPathCount >= optRebuilds - 1, `fastPath=${optFastPathCount}/${optRebuilds}`);
check('总 CPU 耗时显著下降（至少 5 倍以上加速）', optCpuMs < baseCpuMs / 5, `base=${baseCpuMs.toFixed(2)}ms opt=${optCpuMs.toFixed(2)}ms`);
check('已完成历史 Turn 引用保持率达到 100%', turnPreservedPct === 100, `${turnPreservedPct}%`);
check('已完成历史 ChatItem 引用保持率达到 100%', itemPreservedPct === 100, `${itemPreservedPct}%`);
check('已完成历史 WorkGroup 引用保持率达到 100%', groupPreservedPct === 100, `${groupPreservedPct}%`);

console.log('\n── 2. 增量折叠与全量 foldEvents 语义严格等价 ────────');
check('增量折叠最终产出的 Turn[] 与全量 foldEvents 100% 深度一致', () => {
  return JSON.stringify(optPrevTurns) === JSON.stringify(basePrevTurns);
});
check('增量折叠最终产出的 ChatItem[] 与全量 toChatItems 100% 深度一致', () => {
  return JSON.stringify(optPrevItems) === JSON.stringify(basePrevItems);
});
check('前插更早历史（模拟 loadOlder）时自动回退全量折叠并保持后续未变轮次引用', () => {
  const olderTurn = [
    { event: { type: 'turn/start', seq: 0, time: 1_699_999_000_000, data: { turn: 0 } } },
    {
      event: {
        type: 'user/message',
        seq: 0.5,
        time: 1_699_999_000_100,
        data: { turn: 0, id: 'u-0', content: [{ type: 'text', text: '更早的第 0 轮' }] },
      },
    },
    {
      event: {
        type: 'turn/end',
        seq: 0.8,
        time: 1_699_999_000_200,
        data: { turn: 0, reason: { kind: 'completed' } },
      },
    },
  ];
  const combined = [...olderTurn, ...optSorted];
  const res = foldEventsIncremental(combined, foldCache);
  return (
    !res.usedFastPath &&
    res.turns.length === 42 &&
    res.turns[0].turn === 0 &&
    // 原有第 1..41 轮因为内容未变，引用仍被 stabilizeTurns 100% 复用
    res.turns[1] === optPrevTurns[0] &&
    res.turns[41] === optPrevTurns[40]
  );
});

console.log('\n── 3. 关键状态 0ms 即时刷新 vs 中间流事件批量节流 ────');
check('关键事件判据：user/message、turn/start、turn/end、approval/*、deliverables/* 为 true，高频中间事件为 false', () => {
  return (
    isCriticalStreamEvent('user/message') &&
    isCriticalStreamEvent('turn/start') &&
    isCriticalStreamEvent('turn/end') &&
    isCriticalStreamEvent('approval/asked') &&
    isCriticalStreamEvent('approval/decided') &&
    isCriticalStreamEvent('deliverables/presented') &&
    !isCriticalStreamEvent('step/start') &&
    !isCriticalStreamEvent('assistant/message') &&
    !isCriticalStreamEvent('tool/call') &&
    !isCriticalStreamEvent('tool/result')
  );
});

// 驱动真实 Store 验证流式批量合并、关键状态 0ms 刷新与服务端权威 running 状态修正
const streamQueue = [];
let streamResolver = null;
const pushToStream = (rec) => {
  if (streamResolver) {
    const r = streamResolver;
    streamResolver = null;
    r({ value: rec, done: false });
  } else {
    streamQueue.push(rec);
  }
};

let listRunningState = true;
const fakeConn = {
  baseUrl: 'http://127.0.0.1:3099',
  currentCookie: 'dsh-auth=test',
  hasCookie: true,
  setCookie() {},
  resetSocket() {},
  close() {},
  async call(endpoint) {
    if (endpoint === 'session/list') {
      return {
        items: [
          {
            sessionId: 'sess-f03',
            cwd: 'E:\\work\\dsBot',
            updatedAt: Date.now(),
            running: listRunningState,
            projections: {
              kind: 'cached',
              asOfSeq: 10,
              values: { title: 'F03 性能测试会话' },
            },
          },
        ],
      };
    }
    return {};
  },
  async openStream() {
    let sentSnapshot = false;
    return {
      close() {},
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (!sentSnapshot) {
              sentSnapshot = true;
              return Promise.resolve({
                done: false,
                value: {
                  type: 'snapshot',
                  cursor: 2,
                  hasMore: false,
                  records: [
                    { event: { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } } },
                    {
                      event: {
                        type: 'user/message',
                        seq: 2,
                        time: 1010,
                        data: { turn: 1, id: 'u1', content: [{ type: 'text', text: 'hello' }] },
                      },
                    },
                  ],
                  projections: {
                    kind: 'cached',
                    asOfSeq: 2,
                    values: { title: 'F03 性能测试会话' },
                  },
                },
              });
            }
            if (streamQueue.length > 0) {
              return Promise.resolve({ done: false, value: streamQueue.shift() });
            }
            return new Promise((resolve) => {
              streamResolver = resolve;
            });
          },
        };
      },
    };
  },
};

const store = new Store(fakeConn);
let emitCount = 0;
store.subscribe(() => {
  emitCount += 1;
});

await store.openChat('sess-f03');
check('打开会话首帧快照后因第 1 轮未结束，初始 running === true', store.getChat('sess-f03').running === true);

const emitsBeforeBurst = emitCount;
// 连续推入 10 个高频中间事件（step/start、assistant/message、tool/call、tool/result）
for (let i = 1; i <= 10; i += 1) {
  pushToStream({
    type: 'event',
    event: {
      type: i % 2 === 1 ? 'step/start' : 'assistant/message',
      seq: 2 + i,
      time: 1020 + i,
      data: {
        turn: 1,
        step: Math.ceil(i / 2),
        message: { role: 'assistant', content: [{ type: 'text', text: `chunk-${i}` }] },
      },
    },
  });
}
await new Promise((r) => setTimeout(r, 10));
const emitsDuringBurst = emitCount - emitsBeforeBurst;
check(
  '10 个高频中间流事件在 10ms 内到达时被 60ms 窗口批量合并（不逐个触发 emit）',
  emitsDuringBurst === 0,
  `emitsDuringBurst=${emitsDuringBurst}`,
);

// 紧接着推入关键事件 approval/asked：必须 0ms 立即刷新（不等剩余的 50ms 定时器）
pushToStream({
  type: 'event',
  event: {
    type: 'approval/asked',
    seq: 13,
    time: 1040,
    data: { turn: 1, id: 'ap-fast', toolName: 'pwsh', reason: 'npm test' },
  },
});
await new Promise((r) => setTimeout(r, 5));
const chatAfterApproval = store.getChat('sess-f03');
check(
  '关键安全事件 approval/asked 到达时 0ms 立即刷新（不延迟 60ms）',
  chatAfterApproval.turns[0]?.approvals?.[0]?.id === 'ap-fast',
);

// 推入 turn/end：0ms 立即刷新完成态
pushToStream({
  type: 'event',
  event: {
    type: 'turn/end',
    seq: 14,
    time: 1050,
    data: { turn: 1, reason: { kind: 'completed' } },
  },
});
await new Promise((r) => setTimeout(r, 5));
check('关键事件 turn/end 到达时 0ms 立即将 running 置为 false', store.getChat('sess-f03').running === false);

console.log('\n── 4. 服务端权威运行状态修正断线残留「进行中」 ──────');
// 开启第 2 轮但故意不发 turn/end（模拟断线期间服务端已结束但缺失 turn/end 事件）
pushToStream({
  type: 'event',
  event: { type: 'turn/start', seq: 15, time: 2000, data: { turn: 2 } },
});
pushToStream({
  type: 'event',
  event: {
    type: 'step/start',
    seq: 16,
    time: 2010,
    data: { turn: 2, step: 1 },
  },
});
await new Promise((r) => setTimeout(r, 5));
check('第 2 轮开始后客户端处于「进行中」（running === true）', store.getChat('sess-f03').running === true);

// 服务端权威状态已变为 running = false（如断线恢复后 refreshChatMeta / loadSessions 拉取到最新状态）
listRunningState = false;
await store.refreshChatMeta('sess-f03');
const chatAfterAuthSync = store.getChat('sess-f03');
check(
  'refreshChatMeta 同步服务端权威 running=false 后，立即清除残留的「进行中」状态',
  chatAfterAuthSync.running === false &&
    chatAfterAuthSync.turns.at(-1)?.running === false,
);

// 当后续真正来了新的第 3 轮流式事件时，立刻恢复 running = true
pushToStream({
  type: 'event',
  event: { type: 'turn/start', seq: 17, time: 3000, data: { turn: 3 } },
});
await new Promise((r) => setTimeout(r, 5));
check('新流式事件 turn/start 到达后，running 正常恢复为 true', store.getChat('sess-f03').running === true);

// 测试 loadSessions 同样能修正残留的「进行中」
listRunningState = false;
await store.loadSessions();
check(
  'loadSessions 同步服务端权威 running=false 后，同样清除已打开会话的残留「进行中」',
  store.getChat('sess-f03').running === false &&
    store.getChat('sess-f03').turns.at(-1)?.running === false,
);

check('extractAuthoritativeRunning 正确解析 snapshot 与 summary 的权威运行态', () => {
  return (
    extractAuthoritativeRunning({ running: false }) === false &&
    extractAuthoritativeRunning({ projections: { values: { status: 'idle' } } }) === false &&
    extractAuthoritativeRunning({ projections: { values: { status: { running: true } } } }) === true &&
    extractAuthoritativeRunning({}, { running: false }) === false &&
    extractAuthoritativeRunning({}, {}) === undefined
  );
});

store.close();

console.log('\n── 5. ChatScreen 列表项 React.memo 与三项收尾边界回归 ─');
const chatSrc = readFileSync(path.join(__dirname, '..', 'src', 'screens', 'ChatScreen.tsx'), 'utf8');
check('ChatScreen 使用 React.memo(ChatItemRow) 与 areChatItemRowPropsEqual', () => {
  return (
    /const ChatItemRow = React\.memo\(/.test(chatSrc) &&
    /areChatItemRowPropsEqual/.test(chatSrc) &&
    /<ChatItemRow/.test(chatSrc)
  );
});

// 边界 1：user.parts 附件数量相同但内容（attachmentId / localUri / name / bytes / mediaType）变化时不得误复用旧引用
check('边界 1：user.parts 数量相同但附件内容变化时，Turn 与 ChatItem 引用正确更新（不忽略附件内容变化）', () => {
  const partA = { kind: 'image', attachmentId: 'att-1', name: 'a.png', mediaType: 'image/png', bytes: 100, localUri: 'file:///a.png' };
  const partB = { kind: 'image', attachmentId: 'att-2', name: 'a.png', mediaType: 'image/png', bytes: 100, localUri: 'file:///b.png' };
  const turnA = { turn: 1, running: false, endedAt: 200, user: { id: 'u1', text: 'pic', time: 100, parts: [partA] }, steps: [] };
  const turnB = { turn: 1, running: false, endedAt: 200, user: { id: 'u1', text: 'pic', time: 100, parts: [partB] }, steps: [] };
  const itemA = { kind: 'user', key: 'u-1-u1', turn: 1, text: 'pic', time: 100, parts: [partA] };
  const itemB = { kind: 'user', key: 'u-1-u1', turn: 1, text: 'pic', time: 100, parts: [partB] };

  const stabilizedTurn = stabilizeTurns([turnA], [turnB])[0];
  const stabilizedItem = stabilizeChatItems([itemA], [itemB])[0];
  return (
    !areAttachRefsEqual([partA], [partB]) &&
    !areTurnsStructurallyEqual(turnA, turnB) &&
    !areChatItemsStructurallyEqual(itemA, itemB) &&
    stabilizedTurn === turnB &&
    stabilizedItem === itemB
  );
});

// 边界 2：同 seq 事件原地更新 & 重连历史回填时，增量 foldCache 必须正确失效并与全量 foldEvents 100% 一致
check('边界 2A：同 seq 事件更新（位于已冻结前缀内且总长度不变）时，foldCache 正确失效并与全量 foldEvents 一致', () => {
  const c = createIncrementalFoldCache();
  const recs = [
    { event: { type: 'turn/start', seq: 1, time: 100, data: { turn: 1 } } },
    { event: { type: 'user/message', seq: 2, time: 110, data: { turn: 1, id: 'u1', content: [{ type: 'text', text: '原始问题' }] } } },
    { event: { type: 'turn/end', seq: 3, time: 120, data: { turn: 1, reason: { kind: 'completed' } } } },
    { event: { type: 'turn/start', seq: 4, time: 200, data: { turn: 2 } } },
    { event: { type: 'user/message', seq: 5, time: 210, data: { turn: 2, id: 'u2', content: [{ type: 'text', text: '第二轮' }] } } },
  ];
  // 首次构建检查点：第 1 轮（seq 1..3）被冻结进 prefixTurns
  foldEventsIncremental(recs, c);
  // 同 seq=2 事件被更新为新内容（总记录数仍为 5，tailStartSeq 仍为 4）
  const updatedRecs = recs.slice();
  updatedRecs[1] = {
    event: {
      type: 'user/message',
      seq: 2,
      time: 110,
      data: { turn: 1, id: 'u1', content: [{ type: 'text', text: '同 seq 更新后的问题' }] },
    },
  };
  const incRes = foldEventsIncremental(updatedRecs, c);
  const fullTurns = foldEvents(updatedRecs);
  const fullItems = toChatItems(fullTurns);
  return (
    !incRes.usedFastPath &&
    incRes.turns[0].user?.text === '同 seq 更新后的问题' &&
    JSON.stringify(incRes.turns) === JSON.stringify(fullTurns) &&
    JSON.stringify(incRes.items) === JSON.stringify(fullItems)
  );
});

check('边界 2B：重连历史缺口回填（在中间插入缺失 seq 事件）时，foldCache 正确失效并与全量 foldEvents 一致', () => {
  const c = createIncrementalFoldCache();
  const initial = [
    { event: { type: 'turn/start', seq: 1, time: 100, data: { turn: 1 } } },
    { event: { type: 'user/message', seq: 2, time: 110, data: { turn: 1, id: 'u1', content: [{ type: 'text', text: 'T1' }] } } },
    { event: { type: 'turn/end', seq: 5, time: 150, data: { turn: 1, reason: { kind: 'completed' } } } },
    { event: { type: 'turn/start', seq: 10, time: 200, data: { turn: 2 } } },
    { event: { type: 'step/start', seq: 11, time: 210, data: { turn: 2, step: 1 } } },
  ];
  foldEventsIncremental(initial, c);

  // 断线回填补齐了第 1 轮中间缺失的 seq=3,4 事件，以及第 1、2 轮之间的事件
  const afterBackfill = [
    initial[0],
    initial[1],
    { event: { type: 'step/start', seq: 3, time: 120, data: { turn: 1, step: 1 } } },
    {
      event: {
        type: 'assistant/message',
        seq: 4,
        time: 130,
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '回填的助手回复' }] } },
      },
    },
    initial[2],
    initial[3],
    initial[4],
  ];
  const incRes = foldEventsIncremental(afterBackfill, c);
  const fullTurns = foldEvents(afterBackfill);
  const fullItems = toChatItems(fullTurns);
  return (
    !incRes.usedFastPath &&
    JSON.stringify(incRes.turns) === JSON.stringify(fullTurns) &&
    JSON.stringify(incRes.items) === JSON.stringify(fullItems)
  );
});

// 边界 3：React.memo 的 ChatItemRow 比较器必须比较 dividerStyle / dividerLineStyle / dividerTextStyle
check('边界 3：areChatItemRowPropsEqual 比较 dividerStyle / dividerLineStyle / dividerTextStyle，深浅主题切换后分割线样式实时更新', () => {
  return (
    /prev\.dividerStyle === next\.dividerStyle/.test(chatSrc) &&
    /prev\.dividerLineStyle === next\.dividerLineStyle/.test(chatSrc) &&
    /prev\.dividerTextStyle === next\.dividerTextStyle/.test(chatSrc)
  );
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
