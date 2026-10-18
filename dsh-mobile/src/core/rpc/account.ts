/**
 * 账户 API：余额、用量、登录态。
 *
 * 实测载荷（易错，注意 client 是**对象参数**）：
 *   account/getBalance { client: { version, locale, timezoneOffsetSeconds } }
 *     → { status:'ready', value:[{currency,balance}], bonusWallets:[{currency,balance}] }
 *     → 或 { status:'failed' }
 *   account/getState {} → { status, attempt, links:{usageUrl,topUpUrl} }
 */

import type { DshConnection } from '../transport';

export interface WalletBalance {
  currency: 'CNY' | 'USD';
  balance: string;
}

export interface BalanceResult {
  status: 'ready' | 'failed';
  value: WalletBalance[];
  bonusWallets: WalletBalance[];
}

export interface AccountState {
  status: string;
  attempt: unknown;
  links: { usageUrl?: string; topUpUrl?: string };
}

/** 构造 client 元数据 —— 三个字段都必填 */
export function clientMeta(locale = 'zh-CN'): {
  version: string;
  locale: string;
  timezoneOffsetSeconds: number;
} {
  return {
    version: '1',
    locale,
    // 东八区为正；用设备本地偏移更准
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  };
}

export class AccountApi {
  constructor(private readonly conn: DshConnection) {}

  async getState(): Promise<AccountState> {
    const res = await this.conn.call<AccountState>('account/getState', {});
    return {
      status: res?.status ?? 'unknown',
      attempt: res?.attempt ?? null,
      links: res?.links ?? {},
    };
  }

  async getBalance(locale = 'zh-CN'): Promise<BalanceResult> {
    const res = await this.conn.call<BalanceResult | null>('account/getBalance', {
      client: clientMeta(locale),
    });
    if (!res) return { status: 'failed', value: [], bonusWallets: [] };
    return {
      status: res.status,
      value: res.value ?? [],
      bonusWallets: res.bonusWallets ?? [],
    };
  }
}

/** 汇总多个钱包（同币种相加） */
export function sumWallets(...groups: WalletBalance[][]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of groups) {
    for (const w of g) {
      const n = Number.parseFloat(w.balance);
      if (!Number.isFinite(n)) continue;
      out[w.currency] = (out[w.currency] ?? 0) + n;
    }
  }
  return out;
}

export function formatMoney(amount: number, currency: string): string {
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency + ' ';
  return `${symbol}${amount.toFixed(2)}`;
}

/** 大数字缩写：12345 → 12.3k */
export function formatCount(n: number | undefined): string {
  if (!n || !Number.isFinite(n)) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
