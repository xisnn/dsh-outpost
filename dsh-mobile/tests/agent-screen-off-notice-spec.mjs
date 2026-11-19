// P4-0.3 #22：息屏语义必须在 Agent 屏幕 UI 明示。
//
// 修前：native AgentService 在 ACTION_SCREEN_OFF 时 stop() 并只改通知文案
// （"屏幕已锁定，手机任务停止"），RN 屏幕内无任何说明 → 用户预期「亮屏会恢复」
// 落空（P4-0 审计 #22：要么补恢复路径，要么 UI 明示，当前两者都不做）。
//
// 本轮产品语义（推荐默认项；审批表单超时未答，按推荐项执行、可再改）：
// 息屏即终止当前任务，亮屏后需重新发起；仅切后台不影响执行（FGS 继续）。
// 与 native 实际行为逐字一致，不改变任何安全姿态。
//
// 断言：小组件逐字渲染语义文本；AgentButlerScreen 源码级接线该组件。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { componentHarness } from './support/component-harness.mjs';

const SEMANTICS = '息屏即终止：屏幕关闭时当前任务会停止，亮屏后需重新发起；仅把应用切到后台不影响执行。';

test('AgentScreenOffNotice renders the screen-off semantics verbatim', () => {
  const h = componentHarness('components/AgentScreenOffNotice.tsx', 'AgentScreenOffNotice', {});
  const texts = h.nodes().filter((n) => n.type === 'Text').map((n) => (n.children ?? []).flat(Infinity).join(''));
  assert.ok(texts.includes(SEMANTICS), `missing semantics text; got: ${JSON.stringify(texts)}`);
});

test('AgentButlerScreen wires AgentScreenOffNotice', () => {
  const src = fs.readFileSync(new URL('../src/screens/AgentButlerScreen.tsx', import.meta.url), 'utf8');
  assert.match(src, /import \{ AgentScreenOffNotice \} from '\.\.\/components\/AgentScreenOffNotice';/);
  assert.match(src, /<AgentScreenOffNotice\s*\/>/);
});
