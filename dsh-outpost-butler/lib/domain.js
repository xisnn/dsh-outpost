import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { MEMORY_KINDS, MEMORY_LIMITS, MEMORY_ID_PATTERN, BUTLER_ID_PATTERN } from './memory-limits.js';
import * as zod from 'zod';

const z = zod.z ?? zod.default;

export const TASK_STATUSES = [
  'created',
  'preparing',
  'running',
  'waiting_user',
  'blocked',
  'completed',
  'failed',
  'cancelled',
];

const deliverableSchema = z.object({
  path: z.string(),
  description: z.string().optional(),
  relativePath: z.string().optional(),
  size: z.number().nonnegative().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  unavailableReason: z.string().optional(),
});

const pendingApprovalSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  askedAt: z.number(),
});

export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  objective: z.string(),
  status: z.enum(TASK_STATUSES),
  cwd: z.string(),
  sessionId: z.string().nullable(),
  goalId: z.string().nullable(),
  goalRevision: z.number(),
  goalPhase: z.string().nullable(),
  maxGoalRounds: z.number(),
  autoResume: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  revision: z.number(),
  lastAssistantText: z.string().nullable(),
  deliverables: z.array(deliverableSchema),
  pendingApproval: pendingApprovalSchema.nullable(),
  pendingApprovals: z.array(pendingApprovalSchema).default([]),
  lastError: z.string().nullable(),
  managedRpcIds: z.array(z.string()),
  idempotencyKey: z.string().nullable(),
  localAuthorization: z.string().nullable().optional(),
  queueOrder: z.number().int().positive().optional(),
  recoveryRequired: z.boolean().optional(),
  unsettledWrites: z.array(z.object({ callId: z.string(), argumentDigest: z.string() })).optional(),
});

const receiptSchema = z.object({
  version: z.literal(1), commandId: z.string(), generation: z.string(),
  operation: z.enum(['create', 'enqueue', 'resume', 'interrupt', 'cancel', 'approval']),
  digest: z.string(), state: z.enum(['accepted', 'completed', 'rejected', 'unknown']),
  taskId: z.string().nullable(), at: z.number(), revision: z.number().optional(),
  code: z.string().optional(),
});

const journalEventSchema = z.union([
  z.object({
    seq: z.number(), taskId: z.string(), at: z.number(),
    kind: z.enum(['created', 'updated']), task: taskSchema,
    receipt: receiptSchema.optional(),
  }),
  z.object({ seq: z.number(), at: z.number(), kind: z.literal('command'), receipt: receiptSchema }),
]);

export const taskDomainSpec = defineDomain({
  name: 'outpost_butler',
  version: 1,
  layout: 'per-record',
  tables: {
    tasks: domainTable(taskSchema),
    journal: domainTable(journalEventSchema),
    idempotency: domainTable(z.object({ taskId: z.string() })),
  },
});

/**
 * P4 identity/memory domain. It is separate from the task domain so a memory
 * failure can never block task execution or alter task/approval authority.
 * Entries are user-authored only; no model writes and no tool permissions here.
 */
export { MEMORY_KINDS, MEMORY_LIMITS } from './memory-limits.js';

export const memoryEntrySchema = z.object({
  id: z.string().regex(MEMORY_ID_PATTERN),
  kind: z.enum(MEMORY_KINDS),
  key: z.string().min(1).max(MEMORY_LIMITS.key),
  value: z.string().min(1).max(MEMORY_LIMITS.value),
  source: z.literal('user'),
  createdAt: z.number(),
  updatedAt: z.number(),
  revision: z.number().int().positive(),
});

export const memoryChangeSchema = z.object({
  seq: z.number().int().positive(), at: z.number(), action: z.enum(['set', 'delete']),
  id: z.string().regex(MEMORY_ID_PATTERN),
  kind: z.enum(MEMORY_KINDS).optional(), key: z.string().max(MEMORY_LIMITS.key).optional(),
  revision: z.number().int().positive().optional(),
});

const memoryEventSchema = z.union([
  z.object({
    seq: z.number().int().positive(), at: z.number(), kind: z.literal('snapshot'),
    entries: z.array(memoryEntrySchema).max(MEMORY_LIMITS.entries),
    changes: z.array(memoryChangeSchema).max(MEMORY_LIMITS.history).default([]),
  }),
  z.object({
    seq: z.number().int().positive(), at: z.number(), kind: z.literal('set'),
    entry: memoryEntrySchema,
  }),
  z.object({
    seq: z.number().int().positive(), at: z.number(), kind: z.literal('delete'),
    id: z.string().regex(MEMORY_ID_PATTERN),
  }),
]);

export const memoryDomainSpec = defineDomain({
  name: 'outpost_butler_memory',
  version: 1,
  layout: 'per-record',
  tables: {
    meta: domainTable(z.object({ butlerId: z.string().regex(BUTLER_ID_PATTERN) })),
    journal: domainTable(memoryEventSchema),
  },
});
