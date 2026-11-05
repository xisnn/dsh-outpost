import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
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
});

const journalEventSchema = z.object({
  seq: z.number(),
  taskId: z.string(),
  at: z.number(),
  kind: z.string(),
  task: taskSchema,
});

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
