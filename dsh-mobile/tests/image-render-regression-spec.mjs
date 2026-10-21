/**
 * 图片渲染的回归测试。
 *
 * ## 踩的坑（查了很久，值得记下来）
 *
 * 现象：打开有图片的会话，图片位置是一块灰底空白。
 *
 * 排查过程中逐一排除掉的（都是好的）：
 *   - 文件存在、大小正确（2,506,055 字节）
 *   - 文件头是标准 PNG（89 50 4e 47）
 *   - `/api/file` 返回 200
 *   - App 成功下载到缓存（`cache/xxxxxxxx.png-xxxx.png`）
 *   - base64 读取成功
 *   - `<Image>` 的 onLoad 回调正常触发
 *
 * 真正的根因：**容器上的 `overflow: 'hidden'`**。
 * RN 0.81 + 新架构（Fabric）下，带 overflow:'hidden' 的容器会把里面的
 * <Image> 裁剪成 0 尺寸，渲染结果就是一块灰底。
 * 但 onLoad 照样触发、尺寸计算也对，所以极难定位。
 *
 * 另外 `<Image>` 不能用 `width: '100%'`，必须给固定像素宽高。
 *
 * 这条测试把这两个约束钉死，防止以后有人「顺手」加回来。
 */

import { readFileSync } from 'node:fs';

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
function check(n, fn) {
  try {
    const r = fn();
    if (r === true) ok(n);
    else bad(n, String(r));
  } catch (e) {
    bad(n, e && e.message ? e.message : String(e));
  }
}

const card = readFileSync('src/components/FileCard.tsx', 'utf8');

// ── 核心回归：imageWrap 不能有 overflow:'hidden' ──────────────────
check('imageWrap 没有 overflow:hidden（Fabric 会把 Image 裁成 0）', () => {
  // 取出 imageWrap 的样式块
  const m = /imageWrap:\s*\{([\s\S]*?)\}/.exec(card);
  if (!m) return '找不到 imageWrap 样式';
  const body = m[1];
  // 允许注释里提到 overflow，但不能有真正的 overflow 属性
  const code = body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  return /overflow\s*:\s*['"]hidden['"]/.test(code)
    ? 'imageWrap 又有 overflow:hidden 了 —— 图片会变灰块'
    : true;
});

// ── Image 不能是 width:'100%' ────────────────────────────────────
check('Image 不用 width:100%（Fabric 算不出宽度）', () => {
  // 精确定位 <Image ...> 到它自己的 /> 为止（不含外层 Pressable）
  const start = card.indexOf('<Image\n');
  const idx = start >= 0 ? start : card.indexOf('<Image ');
  if (idx < 0) return '找不到 <Image>';
  const end = card.indexOf('/>', idx);
  if (end < 0) return '找不到 Image 的结束标签';
  const block = card.slice(idx, end);
  // 排除注释行
  const code = block
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  return /width\s*:\s*['"]100%['"]/.test(code)
    ? "Image 还在用 width:'100%'"
    : true;
});

check('Image 有明确的数值宽度', () => {
  const m = /<Image\b[\s\S]*?style=\{([\s\S]*?)\}\s*\/>/.exec(card);
  if (!m) return '找不到 Image 的 style';
  const style = m[1];
  // 要么直接写 width: imageWidth，要么引用了含宽度的变量
  return /width\s*:\s*imageWidth/.test(style) ? true : '没看到数值宽度';
});

// ── 图片下载/兜底链路要保留 ──────────────────────────────────────
check('绝对路径仍然跳过网关', () =>
  /\^\[A-Za-z\]:\[\\\\\/\]/.test(card) ? true : '绝对路径会走网关（会被拒）',
);

check('保留 base64 兜底', () =>
  card.includes('data:') && card.includes('base64') ? true : 'base64 兜底被删了',
);

check('Image 有 onError', () =>
  card.includes('onError=') ? true : 'Image 没有 onError',
);

check('失败时显示原因', () =>
  /图片加载失败/.test(card) ? true : '失败不显示原因',
);

// ── 清理检查：不能留诊断代码 ────────────────────────────────────
check('没有遗留诊断标记', () => {
  const bads = ['★FILE_CARD', '[诊断]', 'borderColor: \'red\'', "backgroundColor: '#00ff00'"];
  const hit = bads.find((b) => card.includes(b));
  return hit ? `还留着诊断代码：${hit}` : true;
});

// ── 注释要留住（避免以后有人改回去） ────────────────────────────
check('注释说明了 overflow 的坑', () =>
  card.includes('overflow') && /灰底|裁成 0/.test(card)
    ? true
    : '缺少 overflow 的踩坑说明',
);

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
