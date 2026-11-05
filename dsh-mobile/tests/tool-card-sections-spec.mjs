import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness } from './support/component-harness.mjs';
const base = { kind: 'tool', id: 'tool-1', name: 'bash', input: { command: 'pwd' }, output: 'local workspace', pending: false, isError: false };
const harness = patch => componentHarness('components/ToolCard.tsx', 'ToolCard', { block: { ...base, ...patch } });
function openCard(h) { h.find(n => n.props.accessibilityHint === '展开或收起工具详情').props.onPress(); h.render(); }
function toggle(h, label) { h.button(label).props.onPress(); h.render(); }
const viewer = h => h.find(n => n.type === 'ToolOutputViewer').props;

test('parameter and output sections toggle independently and survive outer collapse', () => {
  const h = harness();openCard(h);
  assert.equal(h.button('工具参数').props.accessibilityState.expanded, false);
  assert.equal(h.button('工具输出').props.accessibilityState.expanded, true);
  assert.doesNotMatch(h.text(), /"command"/);
  toggle(h, '工具参数');assert.match(h.text(), /"command": "pwd"/);
  toggle(h, '工具输出');assert.doesNotMatch(h.text(), /local workspace/);
  assert.match(h.text(), /"command"/);
  openCard(h);openCard(h);
  assert.equal(h.button('工具参数').props.accessibilityState.expanded, true);
  assert.equal(h.button('工具输出').props.accessibilityState.expanded, false);
});

test('long input and output previews open their complete original text', () => {
  const input = { command: 'echo local', description: '长参数'.repeat(800) + 'INPUT_END' };
  const output = Array.from({ length: 50 }, (_, i) => `result ${i}`).join('\n') + '\nOUTPUT_END';
  const h = harness({ input, output });openCard(h);toggle(h, '工具参数');
  assert.doesNotMatch(h.text(), /INPUT_END|OUTPUT_END/);
  assert.match(h.text(), /已省略，查看完整参数/);
  h.button('查看完整参数').props.onPress();h.render();
  assert.equal(viewer(h).visible, true);assert.equal(viewer(h).content, JSON.stringify(input, null, 2));
  assert.match(viewer(h).title, /参数/);
  viewer(h).onClose();h.render();
  h.button('查看完整输出').props.onPress();h.render();assert.equal(viewer(h).content, output);
});

test('edit keeps diff preview, full diff and original optional parameters', () => {
  const input = { file_path: 'src/a.ts', old_string: 'before', new_string: Array.from({ length: 20 }, (_, i) => `after ${i}`).join('\n'), replace_all: true };
  const h = harness({ name: 'edit', input, output: 'updated' });openCard(h);toggle(h, '工具参数与变更');
  assert.match(h.text(), /src\/a.ts|after 0/);
  h.button('查看完整差异').props.onPress();h.render();assert.equal(viewer(h).diff.path, input.file_path);
  assert.ok(viewer(h).diff.lines.some(line => line.text === 'after 19'));
  h.button('查看完整参数').props.onPress();h.render();assert.equal(viewer(h).content, JSON.stringify(input, null, 2));
  assert.equal(viewer(h).diff, undefined);
  const malformed = harness({ name: 'edit', input: { path: 'a.ts', new_string: 'missing old string' } });
  openCard(malformed);toggle(malformed, '工具参数');assert.match(malformed.text(), /missing old string/);
});

test('streaming and failure updates do not reopen sections closed by the reader', () => {
  const h = harness({ pending: true, output: undefined });openCard(h);assert.match(h.text(), /等待工具返回输出/);
  toggle(h, '工具输出');
  h.render({ block: { ...base, pending: false, output: 'ERROR_DETAIL', isError: true } });
  assert.equal(h.button('工具输出').props.accessibilityState.expanded, false);assert.doesNotMatch(h.text(), /ERROR_DETAIL/);
  assert.match(h.text(), /失败/);toggle(h, '工具输出');assert.match(h.text(), /ERROR_DETAIL/);
  const errorText = h.find(n => n.type === 'Text' && n.children.includes('ERROR_DETAIL'));
  assert.equal(errorText.props.style[1].color, h.theme.colors.danger);
  h.render({ block: { ...base, output: '' } });assert.match(h.text(), /\(无输出\)/);
});
