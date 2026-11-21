// Rurea B1 acceptance: reactive loopback stub model (OpenAI-compatible SSE).
// Drives a REAL agent Run through the phone_* tools on the Shizuku secondary
// display, picking element ids from live phone_screen results. Loopback only
// (the agent allows HTTP solely for 127.0.0.1/localhost). No paid cloud model.
//
// Run: node tests/acceptance/stub-model-server.mjs [port]   (default 8787)
// The isolated verification app points baseUrl at http://10.0.2.2:<port>/v1
// (10.0.2.2 = emulator host loopback) and POSTs its summary to /report.
import http from 'node:http';

const PORT = Number(process.argv[2] || 8787);
const reports = [];

// Count-driven script (matches the agent loop's message flow): open contacts
// (vivo package; emulator falls back below) -> screen -> scroll -> screen ->
// type -> screen -> tap -> key -> done. Element ids resolved from live screens.
function nextAction(messages) {
  const toolResults = messages.filter((m) => m.role === 'tool');
  const step = toolResults.length;
  const lastScreen = () => {
    for (let i = toolResults.length - 1; i >= 0; i--) {
      const j = extractJson(toolResults[i].content);
      if (j && Array.isArray(j.elements)) return j;
    }
    return null;
  };
  const pick = (pred) => lastScreen()?.elements?.find(pred)?.id ?? null;
  // If the primary contacts package timed out (emulator alias), retry the other.
  const lastContent = toolResults[toolResults.length - 1]?.content || '';
  if (step === 1 && lastContent.startsWith('OPEN_TIMEOUT')) {
    return call('phone_open', { package: 'com.google.android.contacts' });
  }
  switch (step) {
    case 0:
      return call('phone_open', { package: 'com.android.contacts' });
    case 1:
      return call('phone_screen', {});
    case 2:
      return call('phone_scroll', { direction: 'down' });
    case 3:
      return call('phone_screen', {});
    case 4: {
      const id = pick((e) => e.editable);
      return id
        ? call('phone_type', { element: id, text: 'Hello 测试 123' })
        : call('phone_screen', {});
    }
    case 5:
      return call('phone_screen', {});
    case 6: {
      const id = pick((e) => e.clickable && !e.editable);
      return id ? call('phone_tap', { element: id }) : text('NO_CLICKABLE_TARGET');
    }
    case 7:
      return call('phone_key', { key: 'home' });
    default:
      return text('ACCEPTANCE_DONE');
  }
}

let callSeq = 0;
function call(name, args) {
  return { kind: 'call', id: `stub-${++callSeq}`, name, arguments: JSON.stringify(args) };
}
function text(t) {
  return { kind: 'text', text: t };
}
function extractJson(content) {
  if (typeof content !== 'string') return null;
  const i = content.indexOf('{');
  if (i < 0) return null;
  try {
    return JSON.parse(content.slice(i));
  } catch {
    return null;
  }
}

function sse(res, action) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
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

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let messages = [];
      try {
        messages = JSON.parse(body).messages ?? [];
      } catch {}
      const action = nextAction(messages);
      console.log(`[stub] step -> ${action.kind} ${action.name ?? action.text}`);
      sse(res, action);
    });
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
      console.log('[stub] report received:', body.slice(0, 400));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/report') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reports));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[stub] Rurea acceptance stub model on http://127.0.0.1:${PORT}/v1`);
});
