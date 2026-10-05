import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostScope, plain } from './runtime.mjs';
const s = await hostScope();
test('shared settings normalize invalid inputs and migrate legacy skill preferences', () => {
  for (const value of [null, undefined, 1, 'invalid', [], { provider: 1, model: null, systemPrompt: ' ' }]) {
    const state = s.normalizeState(value); assert.equal(state.provider, ''); assert.equal(state.model, ''); assert.ok(state.systemPrompt); assert.equal(state.referenceFiles, true);
  }
  for (const [value, expected] of [[true,'balanced'],[false,'off'],['off','off'],['strict','strict'],['eager','eager'],['bogus','balanced']]) assert.equal(s.normalizeSkillMode(value), expected);
  assert.equal(s.normalizeState({ referenceSkills: false }).skillMode, 'off'); assert.equal(s.normalizeState({ referenceSkills: true, skillMode: 'strict' }).skillMode, 'strict');
});
test('DSH mention grammar rejects unrepresentable paths and encodes whitespace/directories', () => {
  for (const path of ['', null, 'a"b', 'a\nb', 'a\u007fb']) assert.equal(s.formatFileMention(path, 'file'), undefined);
  assert.equal(s.formatFileMention('src/a.js', 'file'), '@src/a.js');
  assert.equal(s.formatFileMention('my dir/a.js', 'file'), '@"my dir/a.js"');
  assert.equal(s.formatFileMention('my dir', 'directory'), '@"my dir/');
  assert.equal(s.formatFileMention('src', 'directory'), '@src/');
  for (const name of ['UPPER','bad_name','a/b','中文','',null]) assert.equal(s.formatSkillGesture(name), undefined);
  assert.equal(s.formatSkillGesture('code-review'), '/code-review');
});
test('envelope parsing never treats fenced prose examples as the actual rewrite', () => {
  for (const text of ['[]','null','invalid','prefix {"prompt":"x"}']) assert.equal(s.parseWholeObject(text), null);
  assert.equal(s.parseWholeObject('```json\n{"prompt":"x"}\n```').prompt, 'x');
  const result = s.readRewriteAnswer('Explain {"prompt":"example"}', true, 'balanced'); assert.equal(result.prompt, 'Explain {"prompt":"example"}');
});

test('all skill candidate modes and disabled envelope contracts remain explicit', () => {
  for (const mode of ['off','strict','balanced','eager']) {
    assert.equal(typeof s.composeSystemPrompt('custom',false,mode),'string');
  }
});

test('candidate skill rules cover all modes with and without catalogs', () => {
  for (const mode of ['strict','eager','balanced']) {
    assert.doesNotMatch(s.skillCandidateRule(mode,false), /<available_skills>/);
    assert.match(s.skillCandidateRule(mode,true), /<available_skills>/);
  }
});
