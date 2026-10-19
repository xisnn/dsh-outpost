/**
 * 当前 App 版本号。
 *
 * 单一来源：`dsh-mobile/package.json` 的 version。
 * CI 会用 tag（如 v0.2.0）覆盖它，保证「安装包版本」和「更新检查基准」一致。
 */
import pkg from '../../package.json';

const raw = (pkg as { version?: string }).version ?? '0.0.0';

/** 纯版本号，如 "0.2.0" */
export const APP_VERSION = raw.replace(/^v/i, '');

/** 展示用，如 "v0.2.0" */
export const APP_VERSION_LABEL = `v${APP_VERSION}`;
