/**
 * 模拟 App 的更新检查逻辑，验证它对真实 GitHub Releases 的判断。
 * 用法：npx tsx tests/manual/check-update.mjs <当前版本>
 */
import { isNewer } from '../../src/core/semver.ts';

const current = process.argv[2] ?? '0.0.0';
const API = 'https://api.github.com/repos/xisnn/dsh-outpost/releases/latest';

const res = await fetch(API, { headers: { Accept: 'application/vnd.github+json' } });
console.log('HTTP', res.status);
if (!res.ok) {
  console.log('请求失败，App 会当作「无更新」');
  process.exit(0);
}

const json = await res.json();
const tag = json.tag_name ?? '';
const version = tag.replace(/^v/i, '');
const asset = (json.assets ?? []).find((a) => (a.name ?? '').toLowerCase().endsWith('.apk'));

console.log('当前版本:', current);
console.log('最新版本:', version, `(${tag})`);
console.log('APK:', asset?.name, asset ? `${(asset.size / 1024 / 1024).toFixed(1)}MB` : '(无)');
console.log('是否提示更新:', isNewer(version, current) ? '是 ✓' : '否');
if (asset) console.log('下载地址:', asset.browser_download_url);
