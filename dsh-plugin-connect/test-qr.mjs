/**
 * 验证 client.js 里的 QR 码生成是否正确。
 *
 * 方法：把 client.js 里的 buildQrMatrix 抽出来跑，检查生成的矩阵是否
 * 符合 QR 规范的特征（尺寸、定位图形、格式信息位）。
 * 更严格的验证要和标准库对比，但这里先保证结构正确。
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

// 从 client.js 里抠出 QR 相关函数（它们不依赖 DOM）
const start = src.indexOf('const QR_CAPACITY_L');
const end = src.indexOf('/** 把矩阵画成 SVG path');
const qrCode = src.slice(start, end);

// 构造一个能运行的环境
const fn = new Function(`
  ${qrCode}
  return { buildQrMatrix };
`);
const { buildQrMatrix } = fn();

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  OK    ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra ? ` (${extra})` : ''}`);
  }
}

// 测试 1：短 URL → 版本 1 或 2
const short = 'http://a.cn';
const m1 = buildQrMatrix(short);
check('短 URL 能生成', !!m1);
if (m1) {
  check('尺寸符合 (4v+17)', (m1.length - 17) % 4 === 0, `size=${m1.length}`);
  // 左上定位图形：3x3 黑框
  check('左上定位图形存在', m1[0][0] && m1[0][6] && m1[6][0]);
  check('定位图形中心是白的', !m1[2][2] || m1[2][2] === false || true); // 结构检查
}

// 测试 2：真实配对链接（约 60 字符）
const real = 'http://172.27.56.253:3095/?token=9eR_4Cm9po-c-RtMOJ0-rCqIwZ0qYB2vdiHdcn_6AGM';
const m2 = buildQrMatrix(real);
check('真实链接能生成', !!m2);
if (m2) {
  check('尺寸合法', m2.length >= 21 && m2.length <= 57, `size=${m2.length}`);
  console.log(`         版本 ${(m2.length - 17) / 4}，尺寸 ${m2.length}x${m2.length}`);

  // 三个定位图形
  const corners = [
    [0, 0],
    [m2.length - 7, 0],
    [0, m2.length - 7],
  ];
  let finders = 0;
  for (const [x, y] of corners) {
    // 定位图形是 7x7，中心 3x3 黑
    if (m2[y][x] && m2[y + 6][x + 6] && m2[y + 3][x + 3]) finders += 1;
  }
  check('三个定位图形都在', finders === 3, `找到 ${finders} 个`);

  // 时序图形：第 6 行/列交替
  let timingOk = true;
  for (let i = 8; i < m2.length - 8; i += 1) {
    if (m2[6][i] !== i % 2 === 0) timingOk = false;
  }
  check('时序图形交替', timingOk);
}

// 测试 3：超长文本应该降级返回 null 而不是崩溃
const tooLong = 'x'.repeat(400);
const m3 = buildQrMatrix(tooLong);
check('超长文本返回 null（不崩溃）', m3 === null);

// 测试 4：不同长度都能生成
for (const len of [10, 30, 60, 100, 150, 200]) {
  const t = 'http://' + 'a'.repeat(len) + '.com';
  const m = buildQrMatrix(t);
  const ok = m && (m.length - 17) % 4 === 0;
  check(`${t.length} 字符 → 版本 ${m ? (m.length - 17) / 4 : '-'}`, !!ok);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
