const test = require('node:test');
const assert = require('node:assert/strict');
const { substitute, unresolved, expandSteps, locatorsFor } = require('../../src/steps');

test('substitute replaces known variables and leaves unknown ones', () => {
  const vars = [{ key: 'user', value: 'alice' }, { key: 'n', value: 0 }];
  assert.equal(substitute('{user} has {n} {missing}', vars), 'alice has 0 {missing}');
  assert.equal(substitute(null, vars), '');
});

test('unresolved lists variables that do not exist', () => {
  assert.deepEqual(unresolved('{a} {b}', [{ key: 'a', value: '' }]), ['b']);
});

test('expandSteps inlines blocks with a prefix and flags missing blocks', () => {
  const blocks = [{ id: 'b1', name: 'Log in', steps: [{ action: 'Click', target: 'Sign in' }] }];
  const out = expandSteps([{ action: 'Use block', value: 'b1' }, { action: 'Use block', value: 'nope' }], blocks);
  assert.equal(out.length, 2);
  assert.equal(out[0].target, 'Sign in');
  assert.equal(out[0]._prefix, 'Log in › ');
  assert.equal(out[1]._missingBlock, true);
});

test('expandSteps stops recursive blocks', () => {
  const blocks = [{ id: 'b1', name: 'Loop', steps: [{ action: 'Use block', value: 'b1' }] }];
  const out = expandSteps([{ action: 'Use block', value: 'b1' }], blocks);
  assert.equal(out.length, 1);
  assert.equal(out[0]._missingBlock, true);
});

test('locatorsFor uses recorded locators unless the target was renamed', () => {
  const loc = { testId: 'save' };
  assert.equal(locatorsFor({ target: 'Save', recordedTarget: 'Save', locators: loc }), loc);
  assert.deepEqual(locatorsFor({ target: 'Submit', recordedTarget: 'Save', locators: loc }), { label: 'Submit', text: 'Submit', placeholder: 'Submit' });
});
