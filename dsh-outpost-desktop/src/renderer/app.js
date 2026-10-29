/**
 * 渲染层逻辑。
 *
 * 原则：这里只做「显示 + 转发」，所有系统操作（读文件、起进程、剪贴板）
 * 都通过 window.dsh 交给主进程。渲染层没有 Node 权限。
 */

const $ = (id) => document.getElementById(id);

/** 最近一次状态快照 */
let last = null;
/** 上次生成的二维码对应的 URL，避免重复生成 */
let lastQr = { lan: '', tunnel: '' };

// ── 状态刷新 ────────────────────────────────────────────────────

async function refresh() {
  setHint('正在读取状态…');
  let st;
  try {
    st = await window.dsh.getStatus();
  } catch (e) {
    setHint('读取状态失败：' + (e?.message || e), true);
    return;
  }
  last = st;

  // DSH 服务
  //
  // 优先用主进程自己探测的 portListening —— 它用 net 直接连端口，
  // 毫秒级且可信。隧道服务的 dshRunning 曾经因为用 PowerShell 查端口
  // 超时而误报「未启动」。
  const dshOk = st.portListening === true || (!st.serviceDown && st.dshRunning === true);
  setRow('rowDsh', dshOk ? 'ok' : 'bad', dshOk ? '运行中' : st.serviceDown ? '隧道服务未启动' : '未运行');
  syncServiceButtons(dshOk);

  // 局域网
  const lanIp = st.lanIp || '';
  const lanOk = Boolean(lanIp);
  setRow('rowLan', lanOk ? 'ok' : 'bad', lanOk ? `${lanIp}:${st.pairing?.port || 3095}` : '没有可用网卡');

  // 隧道
  const tunnelUrl = st.tunnelInfo?.url || st.tunnel?.url || '';
  const tunnelPairUrl =
    st.tunnelInfo?.pairUrl ||
    (tunnelUrl && st.pairing?.token
      ? `${tunnelUrl.replace(/\/+$/, '')}/?token=${st.pairing.token}`
      : tunnelUrl);
  const tunnelRunning = Boolean(st.tunnelRunning ?? tunnelUrl);
  setRow(
    'rowTunnel',
    tunnelRunning ? 'ok' : 'idle',
    tunnelRunning ? shortUrl(tunnelUrl) : '未启动',
  );

  // IP 变化横幅
  if (st.ipChanged) {
    $('ipBanner').classList.remove('hidden');
    $('ipBannerDetail').textContent = `当前 ${st.currentIp || '?'}，记录的是 ${st.recordedIp || '?'}。点「一键修复」重启 DSH 和隧道。`;
  } else {
    $('ipBanner').classList.add('hidden');
  }

  // 二维码
  await renderQr('lan', st.lanUrl);
  await renderQr('tunnel', tunnelPairUrl);

  // 设备
  void loadDevices();

  // 设置
  $('chkAutoLaunch').checked = Boolean(st.autoLaunch);

  setHint(st.serviceDown ? '隧道服务未启动，点「刷新」重试' : '');
}

/**
 * 根据 DSH 是否在跑，切换两个按钮的可用状态。
 *
 * 设计意图：**没跑的时候「启动」最显眼，跑着的时候「停止」才有意义**。
 * 不要让两个按钮看起来同样重要 —— 用户绝大多数时候是来启动的。
 */
function syncServiceButtons(running) {
  const start = $('btnStartDsh');
  const stop = $('btnStopDsh');
  if (!start || !stop) return;
  start.disabled = running;
  stop.disabled = !running;
  start.className = running ? 'btn' : 'btn primary';
  stop.className = running ? 'btn' : 'btn ghost';
}

function shortUrl(u) {
  if (!u) return '—';
  try {
    return new URL(u).host;
  } catch {
    return u.slice(0, 28);
  }
}

function setRow(rowId, state, value) {
  const row = $(rowId);
  if (!row) return;
  const dot = row.querySelector('.dot');
  if (dot) dot.dataset.state = state;
  const val = row.querySelector('.status-value');
  if (val) val.textContent = value;
}

async function renderQr(which, url) {
  const box = which === 'lan' ? $('qrLanBox') : $('qrTunnelBox');
  if (!box) return;
  if (!url) {
    box.innerHTML = '<div class="qr-placeholder">不可用</div>';
    lastQr[which] = '';
    return;
  }
  if (lastQr[which] === url && box.querySelector('img')) return;

  const dataUrl = await window.dsh.makeQr(url);
  if (!dataUrl) {
    box.innerHTML = '<div class="qr-placeholder">生成失败</div>';
    return;
  }
  box.innerHTML = '';
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = which === 'lan' ? '局域网二维码' : '隧道二维码';
  box.appendChild(img);
  lastQr[which] = url;
}

async function loadDevices() {
  const list = $('deviceList');
  const count = $('deviceCount');
  let res;
  try {
    res = await window.dsh.listDevices();
  } catch {
    list.innerHTML = '<li class="muted">读取失败</li>';
    count.textContent = '—';
    return;
  }
  const devices = res?.devices ?? [];
  count.textContent = devices.length ? `${devices.length} 台` : '暂无';
  if (!devices.length) {
    list.innerHTML =
      '<li class="muted">还没有手机连过。用上面的二维码扫一下就能配对。</li>';
    return;
  }
  list.innerHTML = '';
  for (const d of devices) {
    const li = document.createElement('li');
    const name = d.name || d.deviceName || '未命名设备';
    const when = d.lastSeenAt || d.lastSeen || d.createdAt;
    li.innerHTML = `<span class="dev-name"></span><span class="muted dev-when"></span>`;
    li.querySelector('.dev-name').textContent = name;
    li.querySelector('.dev-when').textContent = when ? relTime(when) : '';
    list.appendChild(li);
  }
}

function relTime(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

function setHint(text, isError) {
  const h = $('hint');
  h.textContent = text || '';
  h.classList.toggle('error', Boolean(isError));
}

// ── 事件 ────────────────────────────────────────────────────────

$('btnRefresh').addEventListener('click', () => void refresh());

$('btnHide').addEventListener('click', () => window.dsh.hide());
$('btnQuit').addEventListener('click', () => window.dsh.quit());

// ── DSH 服务启停 ────────────────────────────────────────────────
//
// 启动可能要等几十秒（DSH 起得慢），所以按钮状态要一直提示着，
// 别让用户以为没点着。

$('btnStartDsh').addEventListener('click', async () => {
  const btn = $('btnStartDsh');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '启动中…';
  setHint('正在启动 DSH 服务，通常需要 10-30 秒…');

  try {
    const r = await window.dsh.dsh('start');
    if (r?.ok) {
      setHint(r.message || 'DSH 已启动');
      await refresh();
    } else {
      setHint('启动失败：' + (r?.error || '未知错误'), true);
    }
  } catch (e) {
    setHint('启动出错：' + (e?.message || e), true);
  } finally {
    btn.textContent = original;
    // refresh() 里的 syncServiceButtons 会按实际状态恢复 disabled
    await refresh();
  }
});

$('btnStopDsh').addEventListener('click', async () => {
  const btn = $('btnStopDsh');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '停止中…';
  setHint('正在停止 DSH 服务…');

  try {
    const r = await window.dsh.dsh('stop');
    if (r?.ok) {
      setHint(r.message || 'DSH 已停止');
    } else {
      setHint('停止失败：' + (r?.error || '未知错误'), true);
    }
  } catch (e) {
    setHint('停止出错：' + (e?.message || e), true);
  } finally {
    btn.textContent = original;
    await refresh();
  }
});

$('btnStartTunnel').addEventListener('click', async () => {
  const btn = $('btnStartTunnel');
  btn.disabled = true;
  btn.textContent = '启动中…';
  setHint('正在启动隧道，大约 60-90 秒，别关窗口…');
  try {
    const r = await window.dsh.tunnel('start');
    if (r?.ok) {
      setHint('隧道已启动');
      await refresh();
    } else {
      setHint('启动失败：' + (r?.error || r?.message || '未知错误'), true);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '启动隧道';
  }
});

$('btnStopTunnel').addEventListener('click', async () => {
  $('btnStopTunnel').disabled = true;
  try {
    const r = await window.dsh.tunnel('stop');
    setHint(r?.ok ? '隧道已停止' : '停止失败：' + (r?.error || '未知错误'), !r?.ok);
    await refresh();
  } finally {
    $('btnStopTunnel').disabled = false;
  }
});

$('btnRepair').addEventListener('click', async () => {
  const btn = $('btnRepair');
  btn.disabled = true;
  btn.textContent = '修复中…';
  setHint('正在用新地址重启 DSH 和隧道…');
  try {
    const r = await window.dsh.tunnel('repair');
    setHint(r?.ok ? '已修复' : '修复失败：' + (r?.error || '未知错误'), !r?.ok);
    await refresh();
  } finally {
    btn.disabled = false;
    btn.textContent = '一键修复';
  }
});

document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const which = btn.dataset.copy;
    const rawTunnelUrl = last?.tunnelInfo?.url || last?.tunnel?.url || '';
    const tunnelCopyUrl =
      last?.tunnelInfo?.pairUrl ||
      (rawTunnelUrl && last?.pairing?.token
        ? `${rawTunnelUrl.replace(/\/+$/, '')}/?token=${last.pairing.token}`
        : rawTunnelUrl);
    const url = which === 'lan' ? last?.lanUrl : tunnelCopyUrl;
    if (!url) {
      setHint('还没有可复制的链接', true);
      return;
    }
    await window.dsh.copy(url);
    setHint('已复制到剪贴板');
  });
});

$('chkAutoLaunch').addEventListener('change', async (e) => {
  const ok = await window.dsh.setAutoLaunch(e.target.checked);
  setHint(ok ? (e.target.checked ? '已开启开机自启' : '已关闭开机自启') : '设置失败', !ok);
});

$('chkAutoHide').addEventListener('change', async (e) => {
  await window.dsh.setAutoHide(e.target.checked);
});

// ESC 隐藏面板
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.dsh.hide();
});

// 打开面板时刷新一次
void refresh();
// 每 5 秒轻量刷新（只更新状态，不重复生成二维码）
setInterval(() => {
  void refresh();
}, 5000);
