// Rurea C3 persistence acceptance loopback stub server (OpenAI Chat Completions SSE).
// Zero paid cloud calls. Supports port 0 for offline unit tests.
import http from 'node:http';

const PORT = Number(process.argv[2] ?? 8787);
const reports = [];
const trace = [];
let callSeq = 0;

function sseToolOrText(res, messages) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const toolResults = Array.isArray(messages) ? messages.filter((m) => m?.role === 'tool') : [];
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  if (toolResults.length === 0) {
    const id = `c3-stub-${++callSeq}`;
    trace.push(`tool:workspace_list:${id}`);
    send({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name: 'workspace_list', arguments: '{}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    trace.push('text:C3_PERSIST_OK');
    send({ choices: [{ index: 0, delta: { content: 'C3_PERSIST_OK' }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {}
      sseToolOrText(res, parsed.messages);
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
      console.log(`[stub] report #${reports.length} received (${body.length} bytes)`);
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
    reports.length = 0;
    trace.length = 0;
    callSeq = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"reset":true}');
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`[stub] listening=http://127.0.0.1:${actualPort}`);
});
