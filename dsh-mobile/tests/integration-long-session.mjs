/**
 * 集成测试：长会话。
 *
 * ## 为什么单独测
 *
 * 长会话是「空调话」bug 的重灾区，踩过的坑：
 *   · `session/page` 的 `throughSeq` 超过游标 → 服务端报错
 *   · `session/follow` 的 address 必须包成 `{request:{address:{...}}}`
 *   · 分页要能往回翻（beforeSeq），不能只拿最新一页
 *
 * 这些在单测里测不到（不碰网络），必须真的对着服务端发请求。
 *
 * ## 覆盖什么
 *
 *   1. 90 条记录的会话能完整分页拉下来
 *   2. throughSeq 边界（等于游标 OK，超过报错）
 *   3. beforeSeq 往回翻（加载更早）
 *   4. 分页不重复、不丢
 *   5. 空会话（0 条记录）不报错
 *   6. 单条超大记录（长文本）不截断
 */

import { startFakeDsh } from './support/fake-dsh.mjs';

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
async function check(n, fn) {
  try {
    const r = await fn();
    if (r === true) ok(n);
    else bad(n, String(r));
  } catch (e) {
    bad(n, e && e.message ? e.message : String(e));
  }
}

/** 造一个带 N 条记录、支持分页的假会话 */
function makeSessionHandler(totalRecords) {
  return async (args) => {
    const req = args?.request ?? {};
    const throughSeq = req.throughSeq;
    const beforeSeq = req.beforeSeq;
    const maxMessages = req.maxMessages ?? 20;
    const cursor = totalRecords - 1;

    if (typeof throughSeq !== 'number') {
      throw new Error('throughSeq required');
    }
    if (throughSeq > cursor) {
      throw new Error(`session page through seq ${throughSeq} is past cursor ${cursor}`);
    }

    // 造记录：seq 从 0 到 cursor，内容带 seq 方便断言
    const all = Array.from({ length: totalRecords }, (_, i) => ({
      seq: i,
      text: `record-${i}`,
    }));

    // beforeSeq 表示「只要比它更早的」
    const upper = typeof beforeSeq === 'number' ? beforeSeq : throughSeq;
    const candidates = all.filter((r) => r.seq <= upper);
    const page = candidates.slice(-maxMessages); // 取最后 maxMessages 条
    const hasMore = candidates.length > page.length;

    return { records: page, hasMore };
  };
}

/** 调一次 session/page */
async function page(srv, { throughSeq, beforeSeq, maxMessages, address }) {
  const req = address ?? { kind: 'session', sessionId: 'sess-long' };
  const args = {
    request: {
      address: req,
      throughSeq,
      ...(typeof beforeSeq === 'number' ? { beforeSeq } : {}),
      ...(typeof maxMessages === 'number' ? { maxMessages } : {}),
    },
  };
  const res = await fetch(`${srv.baseUrl}/api/session/page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: srv.cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'p-' + Math.random().toString(36).slice(2),
      method: 'session/page',
      payload: { args },
    }),
  });
  return res.json();
}

// ── 1. 完整分页 ────────────────────────────────────────────────

await check('长会话：90 条记录能分页拉完，不丢不重', async () => {
  const TOTAL = 90;
  const srv = await startFakeDsh({ handlers: { 'session/page': makeSessionHandler(TOTAL) } });
  try {
    const collected = [];
    let throughSeq = TOTAL - 1;
    let beforeSeq;
    let guard = 0;

    while (guard < 20) {
      guard += 1;
      const json = await page(srv, {
        throughSeq,
        beforeSeq,
        maxMessages: 20,
      });
      if (json?.result?.ok !== true) {
        return '分页失败：' + JSON.stringify(json?.result?.error);
      }
      const { records, hasMore } = json.result.value;
      // 记录是从旧到新给的，往前插
      collected.unshift(...records);
      if (!hasMore) break;
      // 下一页：取当前最旧那条的前一条
      beforeSeq = records[0].seq - 1;
      if (beforeSeq < 0) break;
    }

    const seqs = collected.map((r) => r.seq);
    const unique = new Set(seqs);
    if (seqs.length !== TOTAL) return `只拉到 ${seqs.length} 条，期望 ${TOTAL}`;
    if (unique.size !== TOTAL) return `有重复记录（${seqs.length} 条里只有 ${unique.size} 个唯一 seq）`;
    if (seqs[0] !== 0) return '最旧的不是 seq=0';
    if (seqs[seqs.length - 1] !== TOTAL - 1) return '最新的不是最后一条';
    return true;
  } finally {
    await srv.close();
  }
});

await check('长会话：分页顺序是连续的（没有跳号）', async () => {
  const TOTAL = 50;
  const srv = await startFakeDsh({ handlers: { 'session/page': makeSessionHandler(TOTAL) } });
  try {
    const json = await page(srv, { throughSeq: TOTAL - 1, maxMessages: 50 });
    const records = json?.result?.value?.records ?? [];
    for (let i = 0; i < records.length; i += 1) {
      if (records[i].seq !== i) return `第 ${i} 条 seq 是 ${records[i].seq}，顺序错了`;
    }
    return true;
  } finally {
    await srv.close();
  }
});

// ── 2. 边界 ────────────────────────────────────────────────────

await check('边界：throughSeq 正好等于游标 → 成功', async () => {
  const TOTAL = 30;
  const srv = await startFakeDsh({ handlers: { 'session/page': makeSessionHandler(TOTAL) } });
  try {
    const json = await page(srv, { throughSeq: TOTAL - 1, maxMessages: 10 });
    return json?.result?.ok === true ? true : '正好等于游标却失败了';
  } finally {
    await srv.close();
  }
});

await check('边界：throughSeq 超过游标 → 报错（不是静默返回空）', async () => {
  const TOTAL = 30;
  const srv = await startFakeDsh({ handlers: { 'session/page': makeSessionHandler(TOTAL) } });
  try {
    const json = await page(srv, { throughSeq: 9999, maxMessages: 10 });
    if (json?.result?.ok !== false) return '超过游标居然成功了（会掩盖调用方 bug）';
    const msg = json?.result?.error?.message ?? '';
    return msg.includes('past cursor') ? true : '错误信息没说清原因：' + msg;
  } finally {
    await srv.close();
  }
});

await check('边界：address 必须是 {kind,sessionId}，裸 sessionId 会失败', async () => {
  const TOTAL = 10;
  const srv = await startFakeDsh({
    handlers: {
      'session/page': async (args) => {
        const addr = args?.request?.address;
        if (!addr || addr.kind !== 'session') {
          throw new Error('gateway/input-invalid: address required');
        }
        return { records: [], hasMore: false };
      },
    },
  });
  try {
    // 裸 sessionId（踩过的坑）
    const wrong = await page(srv, {
      throughSeq: 5,
      address: { sessionId: 'sess-long' },
    });
    if (wrong?.result?.ok !== false) return '裸 sessionId 居然通过了';

    // 正确形状
    const right = await page(srv, {
      throughSeq: 5,
      address: { kind: 'session', sessionId: 'sess-long' },
    });
    return right?.result?.ok === true ? true : '正确形状反而失败';
  } finally {
    await srv.close();
  }
});

// ── 3. 空会话 / 边界数据 ──────────────────────────────────────

await check('空会话：0 条记录返回空数组，不报错', async () => {
  const srv = await startFakeDsh({
    handlers: {
      'session/page': async () => ({ records: [], hasMore: false }),
    },
  });
  try {
    const json = await page(srv, { throughSeq: 0, maxMessages: 20 });
    if (json?.result?.ok !== true) return '空会话报错了';
    const records = json.result.value.records;
    return Array.isArray(records) && records.length === 0 ? true : '空会话应该返回空数组';
  } finally {
    await srv.close();
  }
});

await check('单条记录：只有 1 条时 hasMore 必须是 false', async () => {
  const srv = await startFakeDsh({
    handlers: {
      'session/page': async () => ({ records: [{ seq: 0, text: 'only' }], hasMore: false }),
    },
  });
  try {
    const json = await page(srv, { throughSeq: 0, maxMessages: 20 });
    const v = json?.result?.value;
    if (v?.records?.length !== 1) return '记录数不对';
    return v.hasMore === false ? true : 'hasMore 应该是 false（否则 UI 会一直显示「加载更早」）';
  } finally {
    await srv.close();
  }
});

await check('长文本：单条 50KB 的记录能完整返回，不被截断', async () => {
  const BIG = 'x'.repeat(50 * 1024);
  const srv = await startFakeDsh({
    handlers: {
      'session/page': async () => ({
        records: [{ seq: 0, text: BIG }],
        hasMore: false,
      }),
    },
  });
  try {
    const json = await page(srv, { throughSeq: 0, maxMessages: 5 });
    const text = json?.result?.value?.records?.[0]?.text ?? '';
    return text.length === BIG.length ? true : `被截断了：${text.length} / ${BIG.length}`;
  } finally {
    await srv.close();
  }
});

// ── 4. 中文与特殊字符 ─────────────────────────────────────────

await check('编码：中文、emoji、换行、引号都能完整往返', async () => {
  const tricky = '中文测试\n第二行 "引号" \'单引号\' 🎉 <tag> & \\ 反斜杠';
  const srv = await startFakeDsh({
    handlers: {
      'session/page': async () => ({ records: [{ seq: 0, text: tricky }], hasMore: false }),
    },
  });
  try {
    const json = await page(srv, { throughSeq: 0, maxMessages: 5 });
    const got = json?.result?.value?.records?.[0]?.text;
    return got === tricky ? true : `往返后不一致：${JSON.stringify(got)}`;
  } finally {
    await srv.close();
  }
});

// ── 5. 并发分页 ────────────────────────────────────────────────

await check('并发：同时拉 5 页，结果不串', async () => {
  const TOTAL = 100;
  const srv = await startFakeDsh({ handlers: { 'session/page': makeSessionHandler(TOTAL) } });
  try {
    const reqs = [0, 1, 2, 3, 4].map((i) =>
      page(srv, { throughSeq: TOTAL - 1, beforeSeq: TOTAL - 1 - i * 10, maxMessages: 10 }),
    );
    const results = await Promise.all(reqs);
    const allOk = results.every((r) => r?.result?.ok === true);
    if (!allOk) return '有并发请求失败了';
    // 每页的最后一条应该不同（beforeSeq 不同）
    const lasts = results.map((r) => r.result.value.records.at(-1)?.seq);
    const unique = new Set(lasts);
    return unique.size === 5 ? true : '并发分页结果串了：' + lasts.join(',');
  } finally {
    await srv.close();
  }
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
