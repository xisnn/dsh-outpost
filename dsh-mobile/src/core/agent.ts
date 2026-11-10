import { NativeModules, Platform } from 'react-native';

export type AgentPhase =
  | 'idle'
  | 'queued'
  | 'preparing'
  | 'running'
  | 'waiting_user'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type AgentApprovalRisk = 'read' | 'write' | 'phone' | 'dangerous';

export interface AgentApproval {
  callId: string;
  toolName: string;
  digest: string;
  reason: string;
  arguments: Record<string, unknown>;
  risk: AgentApprovalRisk;
  /** Live per-snapshot state; the top-level backgroundLost is step-boundary only. */
  backgroundLost: boolean;
}

export const APPROVAL_BACKGROUND_LOST_TEXT = '后台屏已断开，允许后不会执行工具。';

export function isApprovalAllowBlocked(approval: AgentApproval | null | undefined): boolean {
  return approval?.backgroundLost === true;
}

export interface AgentHandoff {
  reason: string;
}

export interface AgentRecovery {
  runId: string;
  phase: AgentPhase;
  reason: string | null;
  requiresReconciliation: boolean;
  goal: string | null;
  lastToolName: string | null;
  lastToolStatus: string | null;
  updatedAt: number;
}

export interface AgentSnapshot {
  supported: boolean;
  /** False only on a refused action; `parse` turns that into a thrown code. */
  ok: boolean;
  runId: string | null;
  phase: AgentPhase;
  step: number;
  paused: boolean;
  backgroundLost: boolean;
  streamText: string | null;
  backgroundDisplayId: number | null;
  events: AgentRunEvent[];
  text: string | null;
  error: string | null;
  output: string | null;
  pendingApproval: AgentApproval | null;
  pendingHandoff: AgentHandoff | null;
  queue: AgentQueuedTask[];
  recovery: AgentRecovery | null;
}

export interface AgentQueuedTask {
  id: string;
  goal: string;
}

export interface AgentRunEvent {
  seq: number;
  type: 'tool_started' | 'tool_finished' | string;
  toolName: string | null;
  status: string | null;
  detail: string;
  at: number;
}

export interface AgentThreadMessage {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

export interface AgentHistoryItem {
  runId: string;
  goal: string | null;
  phase: AgentPhase;
  reason: string | null;
  resultText: string | null;
  requiresReconciliation: boolean;
  lastToolName: string | null;
  updatedAt: number;
}

export interface AgentMemoryEntry {
  id: string;
  key: string;
  value: string;
  createdAt: number;
  updatedAt: number;
}

export interface PhoneCapabilities {
  supported: boolean;
  accessibilityEnabled: boolean;
  accessibilityConnected: boolean;
  overlayAllowed: boolean;
  screenLocked: boolean;
}

export interface BackgroundAutoStart {
  enabled: boolean;
}

export interface BackgroundDisplayStatus {
  supported: boolean;
  installed: boolean;
  shizukuRunning: boolean;
  permissionGranted: boolean;
  connected: boolean;
  displayId: number;
  frameAvailable: boolean;
  state: string;
  error: string | null;
}

export interface BackgroundShizukuOpenResult {
  opened: boolean;
  installed: boolean;
}

export type AgentProtocol =
  | 'OPENAI_COMPAT'
  | 'OPENAI_RESPONSES'
  | 'ANTHROPIC'
  | 'GEMINI';

export interface AgentModelSettings {
  supported: boolean;
  protocol: AgentProtocol;
  baseUrl: string;
  model: string;
  /** The key itself is never returned to JS; this only says one is stored. */
  hasKey: boolean;
}

interface NativeAgent {
  snapshot(): Promise<string>;
  startDemo(): Promise<string>;
  startCloud(goal: string): Promise<string>;
  decide(callId: string, digest: string, allow: boolean): Promise<string>;
  pause(): Promise<string>;
  resume(): Promise<string>;
  stop(): Promise<string>;
  resumeHandoff(): Promise<string>;
  dismissRecovery(): Promise<string>;
  history(): Promise<string>;
  thread(): Promise<string>;
  clearThread(): Promise<string>;
  getMemory(): Promise<string>;
  saveMemory(id: string | null, key: string, value: string): Promise<string>;
  deleteMemory(id: string): Promise<boolean>;
  getPhoneCapabilities(): Promise<string>;
  openAccessibilitySettings(): Promise<boolean>;
  openOverlaySettings(): Promise<boolean>;
  getModelSettings(): Promise<string>;
  saveModelSettings(
    protocol: AgentProtocol,
    baseUrl: string,
    model: string,
    apiKey: string | null,
  ): Promise<string>;
  clearModelSettings(): Promise<string>;
  backgroundStatus(): Promise<string>;
  backgroundStart(): Promise<string>;
  backgroundLaunch(packageName: string): Promise<string>;
  backgroundStop(): Promise<string>;
  backgroundRetry(): Promise<string>;
  backgroundArm(): Promise<string>;
  backgroundOpenShizuku(): Promise<string>;
  backgroundFrame(): Promise<string | null>;
  getBackgroundAutoStart(): Promise<string>;
  setBackgroundAutoStart(enabled: boolean): Promise<string>;
}

function native(): NativeAgent {
  const bridge = NativeModules.OutpostAgent as NativeAgent | undefined;
  if (Platform.OS !== 'android' || !bridge) throw new Error('AGENT_UNSUPPORTED');
  return bridge;
}

const parse = (text: string): AgentSnapshot => {
  const parsed = JSON.parse(text) as AgentSnapshot & { code?: string };
  // Native reports a refused action as a resolved { ok: false, code } payload
  // rather than a rejected promise. Without this the caller would render it as
  // a valid snapshot and, for startCloud, discard the draft that was sent.
  if (parsed.ok === false) throw new Error(parsed.code ?? 'AGENT_ACTION_REFUSED');
  return parsed;
};
const parseSettings = (text: string): AgentModelSettings =>
  JSON.parse(text) as AgentModelSettings;

/** P6 client: native owns the run; this object only reads snapshots and answers approvals. */
export const agentClient = {
  snapshot: async () => parse(await native().snapshot()),
  startDemo: async () => parse(await native().startDemo()),
  startCloud: async (goal: string) => parse(await native().startCloud(goal)),
  decide: async (callId: string, digest: string, allow: boolean) =>
    parse(await native().decide(callId, digest, allow)),
  pause: async () => parse(await native().pause()),
  resume: async () => parse(await native().resume()),
  stop: async () => parse(await native().stop()),
  resumeHandoff: async () => parse(await native().resumeHandoff()),
  dismissRecovery: async () => parse(await native().dismissRecovery()),
  history: async () => JSON.parse(await native().history()) as AgentHistoryItem[],
  thread: async () => JSON.parse(await native().thread()) as AgentThreadMessage[],
  clearThread: async () => parse(await native().clearThread()),
  getMemory: async () => JSON.parse(await native().getMemory()) as AgentMemoryEntry[],
  saveMemory: async (id: string | null, key: string, value: string) =>
    JSON.parse(await native().saveMemory(id, key, value)) as AgentMemoryEntry,
  deleteMemory: async (id: string) => native().deleteMemory(id),
  getPhoneCapabilities: async () =>
    JSON.parse(await native().getPhoneCapabilities()) as PhoneCapabilities,
  openAccessibilitySettings: async () => native().openAccessibilitySettings(),
  openOverlaySettings: async () => native().openOverlaySettings(),
  getModelSettings: async () => parseSettings(await native().getModelSettings()),
  saveModelSettings: async (
    protocol: AgentProtocol,
    baseUrl: string,
    model: string,
    apiKey: string | null,
  ) => parseSettings(await native().saveModelSettings(protocol, baseUrl, model, apiKey)),
  clearModelSettings: async () => parseSettings(await native().clearModelSettings()),
  backgroundStatus: async () =>
    JSON.parse(await native().backgroundStatus()) as BackgroundDisplayStatus,
  backgroundStart: async () =>
    JSON.parse(await native().backgroundStart()) as BackgroundDisplayStatus,
  backgroundLaunch: async (packageName: string) =>
    JSON.parse(await native().backgroundLaunch(packageName)) as BackgroundDisplayStatus,
  backgroundStop: async () =>
    JSON.parse(await native().backgroundStop()) as BackgroundDisplayStatus,
  backgroundRetry: async () =>
    JSON.parse(await native().backgroundRetry()) as BackgroundDisplayStatus,
  backgroundArm: async () =>
    JSON.parse(await native().backgroundArm()) as BackgroundDisplayStatus,
  backgroundOpenShizuku: async () =>
    JSON.parse(await native().backgroundOpenShizuku()) as BackgroundShizukuOpenResult,
  backgroundFrame: async () => native().backgroundFrame(),
  getBackgroundAutoStart: async () =>
    JSON.parse(await native().getBackgroundAutoStart()) as BackgroundAutoStart,
  setBackgroundAutoStart: async (enabled: boolean) =>
    JSON.parse(await native().setBackgroundAutoStart(enabled)) as BackgroundAutoStart,
};

export const PROTOCOL_LABELS: Record<AgentProtocol, string> = {
  OPENAI_COMPAT: 'OpenAI 兼容',
  OPENAI_RESPONSES: 'OpenAI Responses',
  ANTHROPIC: 'Anthropic Messages',
  GEMINI: 'Google Gemini',
};

export const PROTOCOL_DEFAULT_BASE: Record<AgentProtocol, string> = {
  OPENAI_COMPAT: 'https://api.deepseek.com/v1',
  OPENAI_RESPONSES: 'https://api.openai.com/v1',
  ANTHROPIC: 'https://api.anthropic.com',
  GEMINI: 'https://generativelanguage.googleapis.com',
};
