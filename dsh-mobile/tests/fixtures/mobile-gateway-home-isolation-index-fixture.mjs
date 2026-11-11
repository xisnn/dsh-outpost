// Minimal pristine fixture for the D-3 home-isolation patch regression tests.
// This is NOT a runnable gateway: it carries only the three exact anchors the
// patch edits, so `test:mgwHomeIsolation` stays independent of whatever is
// currently installed (or already patched) under ~/.dsh or node_modules.

import os from 'node:os';
import path from 'node:path';
import { createGatewayState, GATEWAY_MODES } from './gateway-state.mjs';

void GATEWAY_MODES;

export function applyFragments(options) {
  const deviceFile = options.deviceFile || path.join(os.homedir(), '.dsh', 'mobile-gateway-devices.json');
  const gatewayState = createGatewayState(options.gatewayStateFile || `${deviceFile}.gateway.json`);
  return { deviceFile, gatewayState };
}

export function disposeFragment() {
  const wss = { close() {} };
  const log = () => {};
  if (wss) {
    if (log) {
      wss.close()
      log('plugin stopped, all sockets closed')
    }
  }
}

// Anchor shared with the management-auth patch, so the two patches can be
// exercised together (composition + independent rollback).
export function routeFragment(req, res, sendJson, isSameOrigin) {
  if (req) {
    if (res) {
      if (sendJson) {
        if (isSameOrigin) {
          if (req.method !== 'GET' && req.method !== 'HEAD' && !isSameOrigin(req)) {
            sendJson(res, 403, { error: 'forbidden' });
          }
        }
      }
    }
  }
}