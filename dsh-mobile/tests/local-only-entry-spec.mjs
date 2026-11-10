import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness } from './support/component-harness.mjs';

function entry({ supported = true, onEnter = () => undefined } = {}) {
  return componentHarness('components/LocalOnlyEntry.tsx', 'LocalOnlyEntry', {}, {
    '../App': { useApp: () => ({ enterLocalOnly: onEnter }) },
    '../core/localRuntimeSupport': { localRuntimeAvailable: () => supported },
  });
}

test('the pairing screen offers a local entry only when the device supports it', () => {
  const h = entry();
  assert.match(h.text(), /没有电脑？也可以先在本机使用管家/);
  assert.match(h.text(), /任务在手机上执行/);
  const button = h.button('先在本机使用管家');
  assert.ok(button);
  let entered = 0;
  const h2 = entry({ onEnter: () => { entered += 1; } });
  h2.button('先在本机使用管家').props.onPress();
  assert.equal(entered, 1);
  assert.equal(entry({ supported: false }).text(), '');
});

test('the local entry does not pretend the runtime is ready', () => {
  const h = entry();
  assert.match(h.text(), /需要先在管家页配置云端模型/);
  assert.doesNotMatch(h.text(), /已就绪|已安装/);
});
