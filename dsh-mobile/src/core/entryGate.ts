/**
 * 应用入口判定（P3 本机独立首启）。
 *
 * - 已配对的电脑用户：与升级前完全一致；
 * - 未配对用户：只有在「本机位置 + 管家模式」同时成立时才进入应用；
 *   其他情况仍然显示配对页，不能用本机模式绕过电脑连接的既有安全路径。
 */
import type { HostLocation } from './hostLocation';

export interface EntryGateInput {
  authed: boolean;
  location: HostLocation;
  butlerMode: boolean;
}

export function shouldEnterApp(input: EntryGateInput): boolean {
  return input.authed || (input.location === 'local' && input.butlerMode);
}
