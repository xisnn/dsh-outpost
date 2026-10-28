/**
 * 待发送记录的纯状态机。
 *
 * 设计原则：
 *   · 只有用户明确重试，才允许从 unknown/failed 重新进入发送流程；
 *   · 进程重启只做保守归类，不自动重发任何东西；
 *   · requestId 在状态迁移中永远不可变。
 */

import {
  isTerminalState,
  type PendingSendError,
  type PendingSendRecord,
  type PendingSendState,
} from './types';

export type PendingSendEvent =
  | { type: 'begin-preparing' }
  | { type: 'attachments-ready' }
  | { type: 'begin-send' }
  | { type: 'accept' }
  | { type: 'definite-failure'; code: string; message?: string }
  | { type: 'unknown-failure'; code: string; message?: string }
  | { type: 'confirm' }
  | { type: 'abandon' }
  | { type: 'expire' }
  /** 只可由用户显式操作触发；普通新发送绝不使用 */
  | { type: 'user-retry' }
  /** App 重启后的恢复归类；不产生任何网络动作 */
  | { type: 'recover-after-restart' };

export interface PendingSendTransitionErrorDetails {
  requestId: string;
  from: PendingSendState;
  event: PendingSendEvent['type'];
}

export class PendingSendTransitionError extends Error {
  readonly code = 'PENDING_SEND_INVALID_TRANSITION';
  readonly details: PendingSendTransitionErrorDetails;

  constructor(details: PendingSendTransitionErrorDetails) {
    super(
      `invalid pending-send transition: ${details.from} --${details.event}--> (${details.requestId})`,
    );
    this.name = 'PendingSendTransitionError';
    this.details = details;
  }
}

function errorOf(
  classification: PendingSendError['classification'],
  code: string,
  message = '',
): PendingSendError {
  return {
    classification,
    code: code.slice(0, 80),
    // 防止把消息正文/服务端敏感返回写进持久化文档
    message: message.slice(0, 200),
  };
}

function patched(
  record: PendingSendRecord,
  patch: Partial<PendingSendRecord>,
  now: number,
): PendingSendRecord {
  return {
    ...record,
    ...patch,
    requestId: record.requestId, // 不变量：任何迁移都不能改 ID
    updatedAt: now,
  };
}

/** 是否允许用户显式重试/继续。 */
export function canUserRetry(record: PendingSendRecord): boolean {
  return (
    record.state === 'queued' ||
    record.state === 'preparing' ||
    record.state === 'ready' ||
    record.state === 'unknown' ||
    record.state === 'failed'
  );
}

/**
 * 应用一个状态迁移。非法迁移抛错，绝不猜测。
 *
 * @param now 由调用方注入，便于测试；生产传 Date.now()。
 */
export function transitionPendingSend(
  record: PendingSendRecord,
  event: PendingSendEvent,
  now: number = Date.now(),
): PendingSendRecord {
  const from = record.state;
  const fail = (): never => {
    throw new PendingSendTransitionError({
      requestId: record.requestId,
      from,
      event: event.type,
    });
  };

  switch (event.type) {
    case 'begin-preparing':
      if (from !== 'queued') return fail();
      return patched(record, { state: 'preparing' }, now);

    case 'attachments-ready':
      if (from !== 'preparing') return fail();
      return patched(record, { state: 'ready' }, now);

    case 'begin-send':
      if (from !== 'ready') return fail();
      return patched(record, { state: 'sending' }, now);

    case 'accept':
      if (from !== 'sending') return fail();
      return patched(record, { state: 'accepted', acceptedAt: now }, now);

    case 'definite-failure':
      if (from !== 'queued' && from !== 'preparing' && from !== 'sending') return fail();
      return patched(
        record,
        {
          state: 'failed',
          lastError: errorOf('definite', event.code, event.message),
        },
        now,
      );

    case 'unknown-failure':
      if (from !== 'sending') return fail();
      return patched(
        record,
        {
          state: 'unknown',
          lastError: errorOf('unknown', event.code, event.message),
        },
        now,
      );

    case 'confirm':
      if (from !== 'accepted') return fail();
      return patched(record, { state: 'confirmed', confirmedAt: now }, now);

    case 'abandon':
      if (isTerminalState(from)) return fail();
      return patched(record, { state: 'abandoned' }, now);

    case 'expire':
      if (isTerminalState(from)) return fail();
      return patched(record, { state: 'expired' }, now);

    case 'user-retry':
      if (!canUserRetry(record)) return fail();
      return patched(
        record,
        {
          state: 'preparing',
          attemptCount: record.attemptCount + 1,
          lastError: undefined,
        },
        now,
      );

    case 'recover-after-restart':
      // 不产生网络动作：只把重启时的中间态保守归类。
      if (from === 'sending') {
        return patched(
          record,
          {
            state: 'unknown',
            lastError: errorOf(
              'unknown',
              'process-restarted',
              '进程在等待发送回执时退出，结果未知',
            ),
          },
          now,
        );
      }
      if (from === 'preparing') {
        // 附件准备阶段一定还没调用 prompt，可以明确归为失败。
        return patched(
          record,
          {
            state: 'failed',
            lastError: errorOf(
              'definite',
              'process-restarted-before-send',
              '进程在附件准备阶段退出，消息未发出',
            ),
          },
          now,
        );
      }
      return record;

    default: {
      // exhaustive check
      const neverEvent: never = event;
      void neverEvent;
      return fail();
    }
  }
}

/** 判断两个绑定是否允许这条记录在当前上下文重试。 */
export interface CurrentServiceBinding {
  baseUrl: string;
  gatewayId: string | null;
  authContextHash: string;
}

export type BindingRejectionReason =
  | 'service-address-changed'
  | 'server-identity-unverifiable'
  | 'server-instance-changed'
  | 'authorization-context-changed';

export type BindingVerdict =
  | { ok: true }
  | { ok: false; reason: BindingRejectionReason };

function normalizeBaseUrl(value: string): string {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

/**
 * 重试前必须通过：地址、服务端实例、授权上下文三者全匹配。
 *
 * 任何一项缺失都不能当作“同一台服务器”放行。
 */
export function evaluatePendingSendBinding(
  recordBinding: PendingSendRecord['binding'],
  current: CurrentServiceBinding,
): BindingVerdict {
  if (normalizeBaseUrl(recordBinding.baseUrl) !== normalizeBaseUrl(current.baseUrl)) {
    return { ok: false, reason: 'service-address-changed' };
  }
  if (!recordBinding.gatewayId || !current.gatewayId) {
    return { ok: false, reason: 'server-identity-unverifiable' };
  }
  if (recordBinding.gatewayId !== current.gatewayId) {
    return { ok: false, reason: 'server-instance-changed' };
  }
  if (recordBinding.authContextHash !== current.authContextHash) {
    return { ok: false, reason: 'authorization-context-changed' };
  }
  return { ok: true };
}
