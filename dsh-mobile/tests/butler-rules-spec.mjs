/**
 * 管家模式规则测试。
 *
 * 这个文件守的是三件事：
 *
 * 1. **Prompt 里不能有自相矛盾的指令**
 *    真实踩过的坑：一边写「轻活自己干：读个文件、看目录」，
 *    一边在「通用规则」里写「你自己不写代码、不读文件、不执行命令」。
 *    模型看到这两条只能随机选一个，行为飘忽 —— 有时为了读一个文件
 *    开一个队员，有时又自己去读。
 *
 * 2. **两种模式的差别只有「要不要先问方案」**
 *    不是「谁来做」的差别。轻活谁做，两模式一致。
 *
 * 3. **队员复用的兜底能识别变体名字**
 *    coder / coder-1 / Coder_2 / coder2 都算同一岗位。
 */

import { readFileSync } from 'node:fs';
import {
  buildButlerPrime,
  modeSwitchMessage,
  isModeSwitch,
  BUTLER_PRIME_MARK,
  BUTLER_MODE_MARK,
  BUTLER_PRIME_VERSION,
} from '../src/core/butler.ts';
import { roleOf, findDuplicateRoles, duplicateRoleHint } from '../src/core/team.ts';

let pass = 0;
let fail = 0;
function ok(n) {
  pass += 1;
  console.log('  OK    ' + n);
}
function bad(n, d) {
  fail += 1;
  console.log('  FAIL  ' + n + (d ? ' — ' + d : ''));
}
function check(n, fn) {
  try {
    const r = fn();
    if (r === true) ok(n);
    else bad(n, String(r));
  } catch (e) {
    bad(n, e && e.message ? e.message : String(e));
  }
}

const prime = buildButlerPrime();

// ── 1. 不能有自相矛盾的指令 ─────────────────────────────────────
check('没有「你自己不读文件/不执行命令」这类禁令', () => {
  // 这是最严重的那条矛盾：它直接否掉了「轻活自己干」
  const banned = ['不读文件', '不执行命令', '不写代码'];
  const hit = banned.filter((b) => prime.includes(b));
  return hit.length === 0 ? true : `还留着禁令：${hit.join('、')}`;
});

check('明确允许管家自己动手做轻活', () => {
  const hasAllow =
    prime.includes('你自己直接做') || prime.includes('自己动手') || prime.includes('直接做');
  return hasAllow ? true : '没写「轻活自己做」，模型会以为一律派队员';
});

check('「谁来做」有唯一权威声明', () =>
  prime.includes('唯一权威') || prime.includes('以此为准')
    ? true
    : '没有声明哪条是权威，出现矛盾时模型无所适从',
);

check('明确说明两模式差别只在「要不要问方案」', () => {
  const hasKey = prime.includes('要不要先问方案') || prime.includes('先问方案');
  const hasExclusive =
    prime.includes('除此之外没有任何区别') || prime.includes('没有区别');
  return hasKey && hasExclusive ? true : '没把「唯一区别」讲清楚';
});

check('判据是「多步操作 + 独立上下文」，不是「半分钟」', () => {
  // 旧版判据是「超过半分钟就派队员」，那和「不读文件」的禁令冲突
  const oldRule = /超过半分钟/;
  const newRule = prime.includes('多步操作') && prime.includes('独立上下文');
  if (oldRule.test(prime)) return '还留着旧的「超过半分钟」判据';
  return newRule ? true : '没给清晰的判据';
});

check('不鼓励把轻活硬派队员（会烧 token）', () =>
  prime.includes('硬派') || prime.includes('不要为了')
    ? true
    : '没提醒轻活别派队员',
);

check('不鼓励自己硬扛重活（会占住会话）', () =>
  prime.includes('占住') || prime.includes('没法及时回')
    ? true
    : '没提醒重活别自己扛',
);

// ── 2. 模式规则 ─────────────────────────────────────────────────
check('闲聊模式：不问方案、直接干', () => {
  const i = prime.indexOf('【闲聊模式】');
  if (i < 0) return '找不到闲聊模式段落';
  const body = prime.slice(i, i + 600);
  return body.includes('直接开始做') || body.includes('直接干')
    ? true
    : '闲聊模式没写「直接干」';
});

check('闲聊模式：仍按同一套分工规则', () => {
  const i = prime.indexOf('【闲聊模式】');
  const body = prime.slice(i, i + 700);
  return body.includes('谁来做') || body.includes('轻活自己') || body.includes('判断分工')
    ? true
    : '闲聊模式没提分工，会退化成「一律自己干」';
});

check('计划模式：确认后仍按同一套分工规则', () => {
  const i = prime.indexOf('【计划模式】');
  if (i < 0) return '找不到计划模式段落';
  const body = prime.slice(i, i + 700);
  return body.includes('谁来做') || body.includes('该自己做的还是自己做')
    ? true
    : '计划模式没说清楚「确认后谁做」，容易退化成「一律派队员」';
});

check('计划模式：要求用户明确确认', () => {
  const i = prime.indexOf('【计划模式】');
  const body = prime.slice(i, i + 700);
  return body.includes('明确确认') ? true : '没说清什么算「用户确认了」';
});

// ── 3. 队员复用 ─────────────────────────────────────────────────
check('要求派活前先 list_agents', () =>
  prime.includes('list_agents') ? true : '没要求先查现有队员',
);

check('优先复用而不是新建', () =>
  prime.includes('优先这条路') || prime.includes('send_message 让他继续')
    ? true
    : '没说复用优先',
);

check('四个固定岗位都在', () => {
  const roles = ['coder', 'scout', 'designer', 'writer'];
  const missing = roles.filter((r) => !prime.includes(r));
  return missing.length === 0 ? true : `缺岗位：${missing.join('、')}`;
});

check('明确禁止 coder-1 / coder-2', () =>
  prime.includes('coder-1') && prime.includes('只保留一个')
    ? true
    : '没明确禁止重复岗位',
);

check('要求队员干完不要杀', () =>
  prime.includes('不要杀掉') || prime.includes('留着下次')
    ? true
    : '没说要留着队员复用',
);

// ── 4. 减少消息依赖 ─────────────────────────────────────────────
check('模式标记版本已升级（触发重新注入）', () => {
  // v8 之前是有矛盾那版，必须升到 v9+
  const m = /BUTLER_PRIME_VERSION = 'v(\d+)'/.exec(
    readFileSync('src/core/butler.ts', 'utf8'),
  );
  if (!m) return '找不到版本号';
  return Number(m[1]) >= 9 ? true : `版本还是 v${m[1]}，老会话不会重新注入`;
});

check('提供 modeSwitchMessage（切换时发一次）', () => {
  const chat = modeSwitchMessage('chat');
  const plan = modeSwitchMessage('plan');
  return chat.startsWith(BUTLER_MODE_MARK) && plan.startsWith(BUTLER_MODE_MARK)
    ? true
    : '切换指令没带标记，fold 过滤不掉会显示给用户';
});

check('切换指令内容区分两个模式', () => {
  const chat = modeSwitchMessage('chat');
  const plan = modeSwitchMessage('plan');
  return chat !== plan && plan.includes('计划') && chat.includes('闲聊')
    ? true
    : '两个模式的切换指令内容没区别';
});

check('切换指令能被 isModeSwitch 认出来', () =>
  isModeSwitch(modeSwitchMessage('plan')) && isModeSwitch(modeSwitchMessage('chat'))
    ? true
    : 'isModeSwitch 认不出，会漏过滤',
);

check('首条消息带初始化标记', () => prime.startsWith(BUTLER_PRIME_MARK));

const chatScreen = readFileSync('src/screens/ChatScreen.tsx', 'utf8');
check('日常消息不再拼模式标记', () => {
  // 允许注释里提到 withModeTag，但不能真的调用
  const code = chatScreen
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
  return /withModeTag\(/.test(code) ? '还在给每条消息拼模式标记' : true;
});

check('切换模式时才发指令', () => {
  const i = chatScreen.indexOf('switchButlerMode');
  if (i < 0) return '找不到 switchButlerMode';
  const body = chatScreen.slice(i, i + 900);
  return body.includes('modeSwitchMessage') ? true : '切换模式没发指令';
});

check('切换前判断真的变了（避免重复发）', () => {
  const i = chatScreen.indexOf('switchButlerMode');
  const body = chatScreen.slice(i, i + 900);
  return body.includes('prev === mode') ? true : '重复点同一模式会重复发指令';
});

// ── 5. 队员复用兜底 ─────────────────────────────────────────────
check('roleOf 归一化各种写法', () => {
  const cases = ['coder', 'coder-1', 'Coder_2', 'coder2', 'CODER', 'coder (2)'];
  for (const c of cases) {
    if (roleOf(c) !== 'coder') return `${c} 没归一成 coder（得到 ${roleOf(c)}）`;
  }
  return true;
});

check('roleOf 对非固定岗位返回 null', () => {
  for (const n of ['张三', 'helper', 'my-agent']) {
    if (roleOf(n) !== null) return `${n} 被误判成固定岗位`;
  }
  return true;
});

check('findDuplicateRoles 能发现 coder + coder-1', () => {
  const team = {
    members: [
      { id: '1', name: 'coder', role: 'teammate', phase: 'idle' },
      { id: '2', name: 'coder-1', role: 'teammate', phase: 'idle' },
      { id: '3', name: 'scout', role: 'teammate', phase: 'idle' },
    ],
    tasks: [],
  };
  const dups = findDuplicateRoles(team);
  return dups.length === 1 && dups[0].role === 'coder' && dups[0].names.length === 2
    ? true
    : JSON.stringify(dups);
});

check('findDuplicateRoles 对健康团队返回空', () => {
  const team = {
    members: [
      { id: '1', name: 'coder', role: 'teammate', phase: 'idle' },
      { id: '2', name: 'scout', role: 'teammate', phase: 'idle' },
    ],
    tasks: [],
  };
  return findDuplicateRoles(team).length === 0 ? true : '健康团队被误报';
});

check('findDuplicateRoles 忽略 lead', () => {
  const team = {
    members: [
      { id: '1', name: 'lead', role: 'lead', phase: 'idle' },
      { id: '2', name: 'lead-1', role: 'teammate', phase: 'idle' },
    ],
    tasks: [],
  };
  // 「lead」不是固定岗位，不该报重复
  return findDuplicateRoles(team).length === 0 ? true : '把 lead 当成重复岗位了';
});

check('duplicateRoleHint 给出可读提示', () => {
  const hint = duplicateRoleHint([{ role: 'coder', names: ['coder', 'coder-1'] }]);
  return hint && hint.includes('coder') && hint.includes('重复')
    ? true
    : '提示信息不完整';
});

check('duplicateRoleHint 没重复时返回 null', () =>
  duplicateRoleHint([]) === null ? true : '空输入应该返回 null',
);

const teamStrip = readFileSync('src/components/TeamStrip.tsx', 'utf8');
check('UI 里接入了重复提示', () =>
  teamStrip.includes('findDuplicateRoles') && teamStrip.includes('duplicateRoleHint')
    ? true
    : '检测逻辑没接到界面，用户看不到',
);

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
