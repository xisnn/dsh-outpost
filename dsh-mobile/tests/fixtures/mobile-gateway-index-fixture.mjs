// Minimal pristine fixture for mobile-gateway patch regression tests.
// This is NOT a runnable gateway; it contains only the exact anchor, route
// names, and LAN listener fragment that the patch test needs.
//
// Keeping this fixture in-repo makes `test:mgwPatch` independent of the
// currently installed/patched plugin under ~/.dsh.

const wsPath = '/ws/mobile';

function isSameOrigin() {
  return true;
}

function installRoutes() {
          if (req.method !== 'GET' && req.method !== 'HEAD' && !isSameOrigin(req)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }

  const routeChecks = [
    "p === '/mgw/status'",
    "p === '/mgw/tools/restart-web'",
    "p === '/mgw/tools/stop-web'",
    "p === '/mgw/public-setup'",
    "p === '/mgw/gateway'",
    "p === '/mgw/cloudflare'",
    "p === '/mgw/auth'",
    "p === '/mgw/devices'",
    "p === '/mgw/pair'",
  ];
  void routeChecks;
}

const lanServer = {
  on(event, handler) {
    if (event === 'upgrade') handler();
  },
};

lanServer.on('upgrade', (req, socket) => {
  const pathname = new URL(req.url || '/', 'http://x').pathname;
  if (pathname !== wsPath) {
    socket.destroy();
    return;
  }
  socket.end();
});
