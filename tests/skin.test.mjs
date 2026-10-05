import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientScope, documentFixture } from './runtime.mjs';

test('DSH DOM contract: stylesheet is idempotent, owned and removable', async () => {
  const dom = documentFixture(), c = await clientScope(dom);
  const dispose = c.ensureStyleTag(); c.ensureStyleTag();
  assert.equal(dom.tags.size, 1); assert.match([...dom.tags.values()][0].textContent, /prefers-reduced-motion/);
  dispose(); assert.equal(dom.tags.size, 0);
});
test('DSH settings DOM contract: zh/en labels, foreign section, mutation and teardown', async () => {
  const dom = documentFixture(), c = await clientScope(dom);
  const zh = dom.addLabel(c.zh.nav), en = dom.addLabel(c.en.nav), other = dom.addLabel('Models');
  const dispose = c.installSettingsNavIcon();
  assert.ok(zh.parentElement.marked); assert.ok(en.parentElement.marked); assert.equal(other.parentElement.marked, false);
  zh.textContent = 'Other'; dom.observers[0].fn(); assert.equal(zh.parentElement.marked, false);
  const added = dom.addLabel(c.zh.nav); dom.observers[0].fn(); assert.ok(added.parentElement.marked);
  dispose(); assert.ok(dom.observers[0].disconnected); assert.ok(dom.labels.every(l => !l.parentElement.marked));
});
test('skin is safe when DOM or MutationObserver is unavailable', async () => {
  const c = await clientScope(); assert.doesNotThrow(() => c.installSettingsNavIcon()());
  const dom = documentFixture(), d = await clientScope({ document: dom.document }); assert.doesNotThrow(() => d.installSettingsNavIcon()());
});
