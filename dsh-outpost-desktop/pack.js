/**
 * 打包脚本（不依赖 electron-builder 的在线工具下载）。
 *
 * ## 为什么不用 `electron-builder --win`
 *
 * 试过了，在受限环境里必然失败：
 *
 *   1. 它要用 app-builder.exe 从 GitHub **分 8 段并发下载** Electron zip，
 *      某一段写 `.part` 文件时被拒（Access is denied）
 *   2. 跳过下载（用 electronDist 指本地）后，又卡在下载 winCodeSign
 *   3. 再跳过签名（signAndEditExecutable: false），又卡在下载 NSIS
 *
 * 根因是 app-builder 会在 %LOCALAPPDATA%\electron-builder\Cache 下**并发建目录**，
 * 这个环境不允许。
 *
 * ## 所以这个脚本这么做
 *
 * 用 electron-builder 的 `--dir` 模式（只复制文件、不下载任何工具），
 * 这一步实测稳定成功；然后自己用 Node 的 zlib 打 zip。
 *
 * 产物：release/DSH-Outpost-Desktop-<version>-win-x64.zip
 *
 * 解压即用，不需要安装。想要安装包（NSIS）就在有网有桌面的机器上
 * 跑 `npm run build:nsis`。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = __dirname;
const RELEASE = path.join(ROOT, 'release');
const UNPACKED = path.join(RELEASE, 'win-unpacked');

function log(msg) {
  console.log(`[pack] ${msg}`);
}

// ── 1. 用 --dir 生成 win-unpacked ────────────────────────────────

log('用 electron-builder --dir 生成目录（不下载任何工具）…');
try {
  // 直接调 electron-builder 的 JS 入口，不走 npx.cmd ——
  // 走 npx 时子进程输出会被吞掉，出错完全看不到原因（踩过）。
  const builderCli = require.resolve('electron-builder/out/cli/cli.js');
  execFileSync(process.execPath, [builderCli, '--win', '--dir'], {
    cwd: ROOT,
    stdio: 'inherit',
    // 关键：清掉这个变量，否则 Electron 会以纯 Node 模式跑
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });
} catch (e) {
  console.error('[pack] electron-builder --dir 失败：', e?.message || e);
  process.exit(1);
}

if (!fs.existsSync(path.join(UNPACKED, 'DSH Outpost.exe'))) {
  console.error('[pack] 没生成 DSH Outpost.exe');
  process.exit(1);
}

// ── 2. 自己打 zip ────────────────────────────────────────────────
//
// 不用 Compress-Archive：它在某些 PowerShell 版本上对大目录会超时/丢文件。
//
// ## 压缩策略（踩过坑）
//
// 第一版我以为「Electron 的 exe/dll 已经压过了，再压没用」，
// 对这些扩展名用 store（不压缩），结果 zip 是 **260 MB**。
//
// 实测：全都用最高压缩能到 **110 MB**（原来的 42%），耗时只多约 20 秒。
// 那些 .exe/.dll 确实压不了多少，但 icudtl.dat、resources.pak、
// LICENSES.chromium.html 这些可压空间很大，加起来很可观。
//
// 上传体验差别很大：0.79 MB/s 的带宽下，260 MB 要 5.5 分钟且容易断，
// 110 MB 只要 2.3 分钟。
//
// 所以现在**全都尝试压缩**，只有在「压了反而更大」时才退回 store。

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const zipName = `DSH-Outpost-Desktop-${pkg.version}-win-x64.zip`;
const zipPath = path.join(RELEASE, zipName);
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

/** 递归收集文件（相对路径用正斜杠） */
function walk(dir, base = '') {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full, rel));
    else out.push({ full, rel, size: st.size, ext: path.extname(name).toLowerCase() });
  }
  return out;
}

log('收集文件…');
const files = walk(UNPACKED);
log(`共 ${files.length} 个文件，${(files.reduce((a, f) => a + f.size, 0) / 1024 / 1024).toFixed(0)} MB`);

// zip 结构：本地文件头 + 数据 + 中央目录 + 结尾
const localParts = [];
const centralParts = [];
let offset = 0;

/** CRC32 表 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS 时间 */
function dosTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

log('写入 zip…');
let raw = 0;
let packed = 0;
for (const f of files) {
  const data = fs.readFileSync(f.full);
  const crc = crc32(data);
  const nameBuf = Buffer.from(f.rel, 'utf8');
  const { time, date } = dosTime(fs.statSync(f.full).mtime);

  // 决定压缩方式：全都试最高压缩，压不动才 store。
  //
  // level: 9 而不是默认的 6 —— 多花十几秒，但整体能小一半以上。
  // 对「通过慢速网络下载/上传」的场景，这个交换非常划算。
  let method = 0;
  let payload = data;
  if (data.length > 512) {
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    if (deflated.length < data.length) {
      method = 8;
      payload = deflated;
    }
  }
  raw += data.length;
  packed += payload.length;

  // 本地文件头
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4); // version needed
  lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
  lh.writeUInt16LE(method, 8);
  lh.writeUInt16LE(time, 10);
  lh.writeUInt16LE(date, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(payload.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);

  localParts.push(lh, nameBuf, payload);

  // 中央目录项
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4); // version made by
  ch.writeUInt16LE(20, 6); // version needed
  ch.writeUInt16LE(0x0800, 8);
  ch.writeUInt16LE(method, 10);
  ch.writeUInt16LE(time, 12);
  ch.writeUInt16LE(date, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(payload.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt16LE(0, 30);
  ch.writeUInt16LE(0, 32);
  ch.writeUInt16LE(0, 34);
  ch.writeUInt16LE(0, 36);
  ch.writeUInt32LE(0, 38);
  ch.writeUInt32LE(offset, 42);
  centralParts.push(ch, nameBuf);

  offset += lh.length + nameBuf.length + payload.length;
}

const centralStart = offset;
const central = Buffer.concat(centralParts);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(central.length, 12);
eocd.writeUInt32LE(centralStart, 16);
eocd.writeUInt16LE(0, 20);

const fd = fs.openSync(zipPath, 'w');
try {
  for (const p of localParts) fs.writeSync(fd, p);
  fs.writeSync(fd, central);
  fs.writeSync(fd, eocd);
} finally {
  fs.closeSync(fd);
}

const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
log(`✓ ${zipName}（${mb} MB）`);
log(`位置：${zipPath}`);
log('');
log('解压即用，双击「DSH Outpost.exe」运行。');
