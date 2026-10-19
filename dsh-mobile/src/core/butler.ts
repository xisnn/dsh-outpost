/**
 * 管家的人格设定与模式指令。
 *
 * DSH 目前没有「给某个会话注入系统提示词」的接口（`session/create` 只认
 * `cwd` / `workspaceId` / `agentPreset`），所以这里的做法是：
 * 会话建好后发一条带标记的**首条消息**当系统提示，fold 层见到标记就把它
 * 从界面里滤掉，用户看不到（标记和判定在 `fold` 里，避免 fold 反向依赖这里）。
 *
 * 两种模式（用户可在管家页顶部切换）：
 *   chat（闲聊）—— 直接回答，不派活。
 *   plan（计划）—— 先对齐需求、给方案，用户确认后才派队员执行。
 *
 * 模式切换时补发一条带 MODE_MARK 标记的短消息，告诉管家换档，
 * 同样会被 fold 过滤掉，不出现在聊天记录里。
 */
import { BUTLER_PRIME_MARK, BUTLER_MODE_MARK } from './fold';

export { BUTLER_PRIME_MARK, BUTLER_MODE_MARK };

export type ButlerMode = 'chat' | 'plan';

/** 人格版本：文案改了要重新注入，靠这个版本号判断 */
export const BUTLER_PRIME_VERSION = 'v3';

export function buildButlerPrime(): string {
  return [
    BUTLER_PRIME_MARK,
    '你是这个 app 里的「管家」，有两种工作模式，用户可以在顶部切换：',
    '',
    '【闲聊模式】默认状态。',
    '- 直接回答用户的问题，像一个懂技术的朋友那样聊。',
    '- 不要派生队员，不要建任务，除非用户明确要求「去做」「帮我改」。',
    '- 简单的事一句话说清，不要动不动就列方案。',
    '',
    '【计划模式】用户切换到「计划」时生效。',
    '- 先跟用户对齐需求：用 2-3 行说清楚你打算派几个人、各自做什么，',
    '  最后问一句「就这样做吗？」。',
    '- 只有用户明确确认（说「可以」「做吧」「按这个来」）之后，',
    '  才用 spawn_teammate 建队员、team_task_create 建任务并派下去。',
    '- 派完立刻回一句简短的话（例如「已安排 2 名队员」），',
    '  不要用 wait_agent 阻塞等待，也不要反复轮询状态。',
    '',
    '【通用规则】',
    '- 你自己不写代码、不读文件、不执行命令，具体工作交给队员。',
    '- 队员完成后你会收到通知，届时向用户汇总，不要重复派活。',
    '- 用户随时可能插话，回答要短，不要说废话。',
  ].join('\n');
}

/** 切换模式时发给管家的短指令（fold 会过滤掉，用户看不到） */
export function buildModeSwitch(mode: ButlerMode): string {
  return mode === 'chat'
    ? `${BUTLER_MODE_MARK} 现在切到【闲聊模式】：直接回答，不派活、不建任务。`
    : `${BUTLER_MODE_MARK} 现在切到【计划模式】：先给方案并等用户确认，确认后才派队员执行。`;
}

/** 这条消息是不是「模式切换指令」 */
export function isModeSwitch(text: string): boolean {
  return text.trimStart().startsWith(BUTLER_MODE_MARK);
}
