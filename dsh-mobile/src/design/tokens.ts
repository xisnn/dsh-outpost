/**
 * 设计令牌 —— 支持明暗两套色板，可运行时切换。
 *
 * 视觉元素与动效借鉴 open-claude-ui 的 CDS 规范，配色用中性灰阶 + 深蓝强调色。
 *
 * 用法：
 *   const t = useTheme();           // 在组件里
 *   t.colors.bg / t.space.md / t.type.base
 *
 * 注意：非颜色类令牌（圆角/间距/字号/动效）与主题无关，直接导出常量。
 */

// ── 圆角（与主题无关） ───────────────────────────────────────────────
export const radius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  bubble: 18,
  pill: 999,
} as const;

// ── 间距 ────────────────────────────────────────────────────────────
export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  xxxl: 40,
  turnGap: 24,
  itemGap: 10,
} as const;

// ── 字号 ────────────────────────────────────────────────────────────
export const type = {
  micro: 10,
  xs: 11,
  sm: 13,
  base: 15,
  lg: 17,
  xl: 20,
  title: 26,
  display: 32,
  lineHeight: 1.55,
  lineTight: 1.25,
} as const;

// ── 字重 ────────────────────────────────────────────────────────────
export const weight = {
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
};

// ── 布局 ────────────────────────────────────────────────────────────
export const layout = {
  bubbleMaxWidthRatio: 0.84,
  assistantInset: 2,
  screenPadding: 18,
  headerHeight: 52,
  composerMinHeight: 46,
  composerMaxHeight: 132,
  avatarSm: 32,
  avatarMd: 44,
  avatarLg: 52,
} as const;

// ── 动效 ────────────────────────────────────────────────────────────
export const motion = {
  thinkingCycleMs: 1600,
  thinkingDotStaggerMs: 180,
  collapseThresholdPx: 220,
  collapseFadePx: 56,
  enterMs: 220,
  pressOpacity: 0.7,
  dragDeadZonePx: 8,
} as const;

// ── 色板类型 ────────────────────────────────────────────────────────
export interface Palette {
  bg: string;
  bgRaised: string;
  bgCard: string;
  bgOverlay: string;
  bgHover: string;

  text: string;
  textSecondary: string;
  textTertiary: string;
  textFaint: string;

  accent: string;
  accentBright: string;
  accentDim: string;
  accentWash: string;
  onAccent: string;

  blue: string;
  blueWash: string;

  bubbleUser: string;
  bubbleUserBorder: string;

  border: string;
  borderStrong: string;

  success: string;
  successWash: string;
  warning: string;
  warningWash: string;
  danger: string;
  dangerWash: string;

  toolBg: string;
  toolBorder: string;

  scrim: string;

  /** 图标渐变的两个止点 */
  iconFrom: string;
  iconTo: string;
  /** 渐变图标上的字色 */
  iconText: string;
  /** 折叠遮罩基色（与 bubbleUser 同色） */
  fadeBase: string;
}

/** 纯白主题 */
export const lightPalette: Palette = {
  bg: '#ffffff',
  bgRaised: '#fafafa',
  bgCard: '#f4f4f5',
  bgOverlay: '#ededee',
  bgHover: '#e6e6e8',

  text: '#17181a',
  textSecondary: '#5f6368',
  textTertiary: '#8b8f96',
  textFaint: '#b4b8be',

  accent: '#2f6bb0',
  accentBright: '#24568f',
  accentDim: '#8fb4dc',
  accentWash: 'rgba(47,107,176,0.09)',
  onAccent: '#ffffff',

  blue: '#2f6bb0',
  blueWash: 'rgba(47,107,176,0.09)',

  bubbleUser: '#f1f1f2',
  bubbleUserBorder: 'rgba(0,0,0,0.055)',

  border: 'rgba(0,0,0,0.075)',
  borderStrong: 'rgba(0,0,0,0.13)',

  success: '#2e7d52',
  successWash: 'rgba(46,125,82,0.10)',
  warning: '#966a08',
  warningWash: 'rgba(150,106,8,0.10)',
  danger: '#b23a2e',
  dangerWash: 'rgba(178,58,46,0.09)',

  toolBg: 'rgba(0,0,0,0.022)',
  toolBorder: 'rgba(0,0,0,0.065)',

  scrim: 'rgba(0,0,0,0.26)',

  iconFrom: 'rgba(47,107,176,0.16)',
  iconTo: 'rgba(47,107,176,0.04)',
  iconText: '#24568f',
  fadeBase: '#f1f1f2',
};

/** 暖白主题（纸张感，长时间阅读更柔和） */
export const warmPalette: Palette = {
  bg: '#fbfaf7',
  bgRaised: '#f6f4ef',
  bgCard: '#f0ede6',
  bgOverlay: '#e8e4db',
  bgHover: '#e0dbd0',

  text: '#1c1a16',
  textSecondary: '#635e54',
  textTertiary: '#8e887c',
  textFaint: '#b6afa1',

  accent: '#2f6bb0',
  accentBright: '#24568f',
  accentDim: '#8fb4dc',
  accentWash: 'rgba(47,107,176,0.09)',
  onAccent: '#ffffff',

  blue: '#2f6bb0',
  blueWash: 'rgba(47,107,176,0.09)',

  bubbleUser: '#efebe2',
  bubbleUserBorder: 'rgba(0,0,0,0.055)',

  border: 'rgba(0,0,0,0.08)',
  borderStrong: 'rgba(0,0,0,0.14)',

  success: '#2e7d52',
  successWash: 'rgba(46,125,82,0.10)',
  warning: '#8a6106',
  warningWash: 'rgba(138,97,6,0.10)',
  danger: '#ad3628',
  dangerWash: 'rgba(173,54,40,0.09)',

  toolBg: 'rgba(0,0,0,0.024)',
  toolBorder: 'rgba(0,0,0,0.07)',

  scrim: 'rgba(0,0,0,0.26)',

  iconFrom: 'rgba(47,107,176,0.16)',
  iconTo: 'rgba(47,107,176,0.04)',
  iconText: '#24568f',
  fadeBase: '#efebe2',
};

/** 深色主题 */
export const darkPalette: Palette = {
  bg: '#0f1115',
  bgRaised: '#161a21',
  bgCard: '#1c2129',
  bgOverlay: '#232a34',
  bgHover: '#2a323d',

  text: '#e9ecf2',
  textSecondary: '#9aa3b5',
  textTertiary: '#6b7488',
  textFaint: '#4a5262',

  accent: '#6fa3e0',
  accentBright: '#8fbdf0',
  accentDim: '#3f6fa8',
  accentWash: 'rgba(111,163,224,0.14)',
  onAccent: '#0b1220',

  blue: '#5b9cf5',
  blueWash: 'rgba(91,156,245,0.14)',

  bubbleUser: '#232936',
  bubbleUserBorder: 'rgba(255,255,255,0.06)',

  border: 'rgba(255,255,255,0.075)',
  borderStrong: 'rgba(255,255,255,0.14)',

  success: '#4ec98a',
  successWash: 'rgba(78,201,138,0.12)',
  warning: '#e0b054',
  warningWash: 'rgba(224,176,84,0.12)',
  danger: '#e0695f',
  dangerWash: 'rgba(224,105,95,0.12)',

  toolBg: 'rgba(255,255,255,0.028)',
  toolBorder: 'rgba(255,255,255,0.06)',

  scrim: 'rgba(0,0,0,0.55)',

  iconFrom: 'rgba(111,163,224,0.24)',
  iconTo: 'rgba(111,163,224,0.06)',
  iconText: '#8fbdf0',
  fadeBase: '#232936',
};

export type ThemeMode = 'light' | 'warm' | 'dark';

export const palettes: Record<ThemeMode, Palette> = {
  light: lightPalette,
  warm: warmPalette,
  dark: darkPalette,
};

export const themeLabels: Record<ThemeMode, string> = {
  light: '纯白',
  warm: '暖白',
  dark: '深色',
};

/** 按模式取色板（非 React 环境用） */
export function paletteOf(mode: ThemeMode): Palette {
  return palettes[mode] ?? lightPalette;
}

// ── 工具标签 ────────────────────────────────────────────────────────
export const toolLabels: Record<string, { label: string; icon: string }> = {
  read: { label: '读取文件', icon: '◷' },
  write: { label: '写入文件', icon: '✎' },
  edit: { label: '编辑文件', icon: '✎' },
  glob: { label: '查找文件', icon: '⌕' },
  grep: { label: '搜索内容', icon: '⌕' },
  pwsh: { label: '执行命令', icon: '❯' },
  bash: { label: '执行命令', icon: '❯' },
  web_search: { label: '网络搜索', icon: '◎' },
  web_fetch: { label: '抓取网页', icon: '◎' },
  todo_write: { label: '更新待办', icon: '☑' },
  spawn_teammate: { label: '创建队友', icon: '⊕' },
  send_message: { label: '发送消息', icon: '→' },
  team_task_create: { label: '创建任务', icon: '⊕' },
  team_task_update: { label: '更新任务', icon: '☑' },
  team_task_list: { label: '查看任务', icon: '☰' },
  list_agents: { label: '查看成员', icon: '☰' },
  ask_user_question: { label: '提问', icon: '?' },
  present: { label: '展示产物', icon: '◫' },
  working_directory: { label: '切换目录', icon: '▸' },
  read_image: { label: '读取图片', icon: '◷' },
  skill: { label: '加载技能', icon: '◇' },
  wait_agent: { label: '等待成员', icon: '◌' },
  interrupt_agent: { label: '中断成员', icon: '⊘' },
};

export function toolMeta(name: string): { label: string; icon: string } {
  return toolLabels[name] ?? { label: name, icon: '•' };
}

/** 按名字生成稳定的色调（同一个人始终同色） */
export function avatarTone(seed: string): 'accent' | 'blue' {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 997;
  return h % 2 === 0 ? 'accent' : 'blue';
}
