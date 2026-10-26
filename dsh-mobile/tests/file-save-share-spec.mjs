/**
 * 文件保存 / 转发 / 图片长按保存的测试。
 *
 * ## 守什么
 *
 * 用户要求「跟微信阅读文件时一样」：
 *   · 阅读文件时右上角三个点，里面有转发、下载
 *   · 图片点开后可以长按保存
 *
 * 这类功能最容易出的问题是：
 *   · 点了没反应（回调没接上）
 *   · 存了但用户找不到（没告诉他存哪）
 *   · 文件名带非法字符导致保存直接失败
 *   · 转发的用 ACTION_VIEW 而不是 ACTION_SEND —— 微信收不到
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

const saveSrc = readFileSync('src/core/fileSave.ts', 'utf8');
const sheetSrc = readFileSync('src/components/FileActionSheet.tsx', 'utf8');
const docSrc = readFileSync('src/components/DocumentViewer.tsx', 'utf8');
const imgSrc = readFileSync('src/components/ImageViewer.tsx', 'utf8');
const cardSrc = readFileSync('src/components/FileCard.tsx', 'utf8');

// ══════════════════════════════════════════════════════════════
// 保存能力
// ══════════════════════════════════════════════════════════════

check('保存用 MediaCollection（Android 10+ 不需要存储权限）', () => {
  if (!saveSrc.includes('copyToMediaStore')) return '没用 MediaStore，可能要申请敏感权限';
  return saveSrc.includes("'Download'") ? true : '没有存到「下载」集合';
});

check('MediaStore 的 filedescriptor 三个键都传了', () => {
  // Android 原生侧要求 name / parentFolder / mimeType 同时存在，
  // 少一个直接 reject "invalid filedata"
  const need = ['name:', 'parentFolder:', 'mimeType:'];
  const missing = need.filter((k) => !saveSrc.includes(k));
  return missing.length === 0 ? true : `缺 ${missing.join('、')}，原生侧会拒绝`;
});

check('低版本 Android 退回分享（不申请 WRITE_EXTERNAL_STORAGE）', () => {
  // 只检查真实代码，注释里提到权限名不算
  const code = saveSrc
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  if (/WRITE_EXTERNAL_STORAGE/.test(code)) {
    return '申请了敏感权限，不该为一个保存功能要权限';
  }
  return /Platform\.Version\)\s*>=\s*29/.test(code) ? true : '没有版本分支';
});

check('文件名做了清洗（非法字符会导致保存失败）', () => {
  if (!saveSrc.includes('sanitizeFileName')) return '没有清洗文件名';
  const i = saveSrc.indexOf('function sanitizeFileName');
  const body = saveSrc.slice(i, i + 600);
  if (!/replace\(/.test(body)) return '没有做替换';
  // 冒号是真实踩过的坑：某些 ROM 直接拒绝
  return /\//.test(body) ? true : '没有处理路径分隔符';
});

check('保留中文和空格（可读性优先）', () => {
  const i = saveSrc.indexOf('function sanitizeFileName');
  const body = saveSrc.slice(i, i + 700);
  // 不能把非 ASCII 全干掉
  if (/\[\\x00-\\x7F\]/.test(body)) return '把中文也过滤了';
  return /u0000-\\u001f/.test(body) || /\\u0000/.test(body)
    ? true
    : '没有处理控制字符';
});

check('保存失败给出可操作的原因（不是「保存失败」了事）', () => {
  if (!/同名文件/.test(saveSrc)) return '没处理同名冲突';
  return /权限/.test(saveSrc) ? true : '没处理权限失败';
});

check('保存成功后告诉用户存到哪了', () => {
  const i = cardSrc.indexOf('const doSave');
  if (i < 0) return '找不到 doSave';
  const body = cardSrc.slice(i, i + 800);
  if (!/已存到/.test(body)) return '只说「已保存」，用户还得自己找';
  return /r\.where/.test(body) ? true : '没说是哪个目录';
});

// ══════════════════════════════════════════════════════════════
// 转发
// ══════════════════════════════════════════════════════════════

check('转发和「用系统应用打开」是两个动作', () => {
  if (!/export async function shareFile/.test(saveSrc)) return '没有独立的 shareFile';
  if (!/export async function openLocalFile/.test(readFileSync('src/core/fileUrl.ts', 'utf8'))) {
    return '找不到 openLocalFile';
  }
  return true;
});

check('转发用 ACTION_SEND（Share），不是 ACTION_VIEW', () => {
  // blob-util 只有 actionViewIntent（= ACTION_VIEW「打开」），
  // 用它做「转发」微信收不到 —— 用户会以为功能坏了。
  const i = saveSrc.indexOf('export async function shareFile');
  if (i < 0) return '找不到 shareFile';
  const body = saveSrc.slice(i, i + 1200);
  if (/actionViewIntent/.test(body)) {
    return '用的是 ACTION_VIEW，微信不会收到 —— 转发等于打开';
  }
  return /Share\.share/.test(body) ? true : '没有用 RN 的 Share（ACTION_SEND）';
});

check('转发给了 mimeType（否则部分 App 不认这个类型）', () => {
  const i = saveSrc.indexOf('export async function shareFile');
  // 窗口要覆盖整个函数（Share.share 的 options 在最后）
  const body = saveSrc.slice(i, i + 2400);
  return /type:\s*mime/.test(body) ? true : '没传 mimeType，接收方可能不显示';
});

check('FileCard 接上了转发和保存', () => {
  if (!/const doShare/.test(cardSrc)) return '没有 doShare';
  if (!/const doSave/.test(cardSrc)) return '没有 doSave';
  return true;
});

// ══════════════════════════════════════════════════════════════
// 三点菜单 UI
// ══════════════════════════════════════════════════════════════

check('有可复用的动作面板组件', () => {
  if (!/export function FileActionSheet/.test(sheetSrc)) return '没有 FileActionSheet';
  return sheetSrc.includes('Modal') ? true : '不是弹层';
});

check('动作项带说明文字（用户能看懂两个动作的区别）', () => {
  if (!/hint\?:/.test(sheetSrc)) return '动作项没有 hint 字段';
  const i = sheetSrc.indexOf('a.hint');
  return i > 0 ? true : '渲染时没用 hint';
});

check('点面板外或返回键能关闭', () => {
  if (!/onRequestClose=\{onClose\}/.test(sheetSrc)) return '返回键关不掉';
  return /onPress=\{onClose\}/.test(sheetSrc) ? true : '点遮罩关不掉';
});

check('面板内点击不穿透到遮罩', () => {
  // 内层 Pressable 要吃掉事件，否则点空白处会误关
  return /onPress=\{\(\) => undefined\}/.test(sheetSrc)
    ? true
    : '点面板内容会穿透关闭';
});

// ══════════════════════════════════════════════════════════════
// DocumentViewer 右上角三点
// ══════════════════════════════════════════════════════════════

check('DocumentViewer 右上角有 ⋯ 按钮', () => {
  if (!/moreBtn/.test(docSrc)) return '没有三点按钮';
  return /⋯/.test(docSrc) ? true : '找不到 ⋯ 符号';
});

check('点 ⋯ 打开动作面板', () => {
  if (!/setMenuOpen\(true\)/.test(docSrc)) return '点了没打开菜单';
  return /<FileActionSheet/.test(docSrc) ? true : '没有渲染面板';
});

check('菜单项按回调是否存在动态显示', () => {
  // 没传 onShare 就不该显示「转发」，否则点了没反应
  if (!/\.\.\.\(onShare/.test(docSrc)) return '转发项没有条件渲染';
  return /\.\.\.\(onSave/.test(docSrc) ? true : '保存项没有条件渲染';
});

check('菜单项文案是中文且区分明确', () => {
  if (!/转发/.test(docSrc)) return '没有「转发」';
  if (!/保存到手机/.test(docSrc)) return '没有「保存到手机」';
  return true;
});

// ══════════════════════════════════════════════════════════════
// 图片长按保存
// ══════════════════════════════════════════════════════════════

check('图片支持长按', () => {
  if (!/onLongPress=\{\(\) => handleLongPress/.test(imgSrc)) return '图片没有长按处理';
  return /const handleLongPress/.test(imgSrc) ? true : '没有 handleLongPress';
});

check('图片保存进相册（不是下载目录）', () => {
  if (!/\bsaveImageToGallery\b/.test(imgSrc)) return '长按没有调保存';
  if (!/saveImageToGallery/.test(saveSrc)) return '没有 saveImageToGallery';
  return saveSrc.includes("'Image'") ? true : '没存到 Image 集合（相册）';
});

check('长按保存后有反馈（不然用户以为没按到）', () => {
  const i = imgSrc.indexOf('const handleLongPress');
  const body = imgSrc.slice(i, i + 1200);
  return /Alert\.alert/.test(body) ? true : '保存后没提示';
});

check('图片没有本地路径时长按不报错', () => {
  const i = imgSrc.indexOf('const handleLongPress');
  const body = imgSrc.slice(i, i + 1200);
  return /if \(!target\) return/.test(body) ? true : '可能对网络图报错';
});

check('FileCard 给图片传了保存信息', () => {
  if (!/save:\s*\{\s*fsPath:/.test(cardSrc)) return '没传 save 字段';
  return true;
});

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
