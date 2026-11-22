// Rurea C1 + C2 + C4 real-device acceptance loopback stub server.
// Serves scripted OpenAI Chat Completions (/v1/chat/completions) and
// OpenAI Responses (/v1/responses) SSE/HTTP fault-injection flows on 127.0.0.1.
// Zero paid cloud model calls.
import http from 'node:http';

const PORT = Number(process.argv[2] || 8787);
const reports = [];
const trace = [];
const attempts = Object.create(null);

const TAGS = [
  '[C1_STREAM_COMPAT]',
  '[C1_STREAM_RESPONSES]',
  '[C1_MIDSTREAM_STOP]',
  '[C4_HTTP_401]',
  '[C4_HTTP_503]',
  '[C4_SOCKET_DROP]',
  '[C4_BG_RECOVERED]',
  '[C2_POLICY_SUITE]',
];

function extractUserTag(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const raw =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => p?.text ?? '').join(' ')
          : '';
    for (const tag of TAGS) {
      if (raw.includes(tag)) return tag;
    }
    return raw.slice(0, 80);
  }
  return null;
}

function extractResponsesTag(bodyObj) {
  if (Array.isArray(bodyObj?.input)) {
    for (let i = bodyObj.input.length - 1; i >= 0; i--) {
      const item = bodyObj.input[i];
      if (item?.role !== 'user') continue;
      const raw =
        typeof item.content === 'string'
          ? item.content
          : Array.isArray(item.content)
            ? item.content.map((p) => p?.text ?? '').join(' ')
            : '';
      for (const tag of TAGS) {
        if (raw.includes(tag)) return tag;
      }
    }
  }
  return null;
}

let callSeq = 0;
function call(name, args) {
  return { kind: 'call', id: `stub-${++callSeq}`, name, arguments: JSON.stringify(args) };
}

function sseChatChunks(res, chunks, intervalMs, doneText) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const timers = [];
  let closed = false;
  const cleanup = () => {
    closed = true;
    while (timers.length) clearTimeout(timers.pop());
  };
  res.on('close', cleanup);

  chunks.forEach((chunk, idx) => {
    const t = setTimeout(() => {
      if (closed) return;
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
    }, idx * intervalMs);
    timers.push(t);
  });

  const endTimer = setTimeout(() => {
    if (closed) return;
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    if (doneText) trace.push(`chat:completed:${doneText}`);
  }, chunks.length * intervalMs + 40);
  timers.push(endTimer);
}

function sseChatToolCall(res, action) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  if (action.kind === 'call') {
    send({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: action.id,
                type: 'function',
                function: { name: action.name, arguments: action.arguments },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    send({ choices: [{ index: 0, delta: { content: action.text }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function nextC2PolicyAction(messages) {
  const toolResults = messages.filter((m) => m.role === 'tool');
  const step = toolResults.length;
  switch (step) {
    case 0:
      return call('phone_open', { package: 'com.eg.android.AlipayGphone' });
    case 1:
      return call('phone_open', { package: 'com.android.settings' });
    case 2:
      return call('workspace_write', { path: 'c2-vivo-probe.txt', content: 'C2_VIVO_OK\n' });
    case 3:
      return call('phone_tap', { element: 'n1' });
    case 4:
      return call('phone_open', { package: 'com.android.bbkcalculator' });
    case 5:
      return call('phone_screen', {});
    case 6:
      return call('phone_scroll', { direction: 'down' });
    case 7:
      return call('phone_key', { key: 'back' });
    default:
      return { kind: 'text', text: 'C2_POLICY_DONE' };
  }
}

function handleChatCompletions(req, res, body) {
  let parsed = {};
  try {
    parsed = JSON.parse(body);
  } catch {}
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const tag = extractUserTag(messages);
  const toolCount = messages.filter((m) => m.role === 'tool').length;
  const n = (attempts[tag] = (attempts[tag] || 0) + 1);
  trace.push(`chat:${tag ?? 'unknown'}:attempt=${n}:tools=${toolCount}`);
  console.log(`[stub] POST /chat/completions tag=${tag} attempt=${n} tools=${toolCount}`);

  if (tag === '[C1_STREAM_COMPAT]') {
    sseChatChunks(res, ['第一段', '，第二段', '，第三段', '，完成🎉'], 220, 'compat');
    return;
  }

  if (tag === '[C1_MIDSTREAM_STOP]') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const timers = [];
    let closed = false;
    const stopAll = () => {
      if (closed) return;
      closed = true;
      trace.push('chat:[C1_MIDSTREAM_STOP]:client-closed');
      while (timers.length) clearTimeout(timers.pop());
    };
    req.on('close', stopAll);
    res.on('close', stopAll);

    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '半截输出' }, finish_reason: null }] })}\n\n`);
    timers.push(
      setTimeout(() => {
        if (closed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '，继续生成中' }, finish_reason: null }] })}\n\n`);
      }, 150),
    );
    timers.push(
      setTimeout(() => {
        if (closed) return;
        res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, 15000),
    );
    return;
  }

  if (tag === '[C4_HTTP_401]') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
    return;
  }

  if (tag === '[C4_HTTP_503]') {
    if (n === 1) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream overloaded' } }));
      return;
    }
    sseChatChunks(res, ['C4_RETRY_', '503_OK'], 60, '503-retry');
    return;
  }

  if (tag === '[C4_SOCKET_DROP]') {
    if (n === 1) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      res.write(': keepalive before abrupt socket drop\n\n');
      setTimeout(() => {
        req.socket?.destroy();
        res.destroy();
      }, 40);
      return;
    }
    sseChatChunks(res, ['C4_RETRY_', 'NET_OK'], 60, 'socket-retry');
    return;
  }

  if (tag === '[C4_BG_RECOVERED]') {
    sseChatChunks(res, ['C4_BG_', 'RECOVERED_OK'], 60, 'bg-recovered');
    return;
  }

  if (tag === '[C2_POLICY_SUITE]') {
    const action = nextC2PolicyAction(messages);
    trace.push(`c2:step=${toolCount}:${action.kind}:${action.name ?? action.text}`);
    console.log(`[stub] C2 step=${toolCount} -> ${action.kind} ${action.name ?? action.text}`);
    sseChatToolCall(res, action);
    return;
  }

  sseChatChunks(res, ['STUB_DEFAULT_OK'], 40, 'default');
}

function handleResponses(req, res, body) {
  let parsed = {};
  try {
    parsed = JSON.parse(body);
  } catch {}
  const tag = extractResponsesTag(parsed);
  const n = (attempts[tag] = (attempts[tag] || 0) + 1);
  trace.push(`responses:${tag ?? 'unknown'}:attempt=${n}`);
  console.log(`[stub] POST /responses tag=${tag} attempt=${n}`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const deltas = ['Responses ', '流式增量', '验证成功'];
  const fullText = deltas.join('');
  const timers = [];
  let closed = false;
  res.on('close', () => {
    closed = true;
    while (timers.length) clearTimeout(timers.pop());
  });

  deltas.forEach((delta, idx) => {
    timers.push(
      setTimeout(() => {
        if (closed) return;
        res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`);
      }, idx * 200),
    );
  });

  timers.push(
    setTimeout(() => {
      if (closed) return;
      const completed = {
        type: 'response.completed',
        response: {
          id: `resp-${n}`,
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: fullText }],
            },
          ],
        },
      };
      res.write(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      trace.push('responses:completed');
    }, deltas.length * 200 + 60),
  );
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handleChatCompletions(req, res, body));
    return;
  }
  if (req.method === 'POST' && req.url?.endsWith('/responses')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handleResponses(req, res, body));
    return;
  }
  if (req.method === 'POST' && req.url === '/report') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        reports.push(JSON.parse(body));
      } catch {
        reports.push({ raw: body });
      }
      console.log(`[stub] report received (${body.length} bytes)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/report') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reports, trace }));
    return;
  }
  if (req.method === 'POST' && req.url === '/reset') {
    for (const k of Object.keys(attempts)) delete attempts[k];
    trace.length = 0;
    reports.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"reset":true}');
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[stub] Rurea C1+C2+C4 acceptance server on http://127.0.0.1:${PORT}/v1`);
});
