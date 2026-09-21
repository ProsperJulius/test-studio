const test = require('node:test');
const assert = require('node:assert/strict');
const { substitute, unresolved, stepRefs, missingFor, expandSteps, resolveGrid, locatorsFor, resolveStep } = require('../../src/steps');
const { describeStep } = require('../../src/describe');

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
  assert.deepEqual(locatorsFor({ target: 'Save', recordedTarget: 'Save', locators: loc }), loc);
  assert.deepEqual(locatorsFor({ target: 'Submit', recordedTarget: 'Save', locators: loc }), { label: 'Submit', text: 'Submit', placeholder: 'Submit' });
});

test('locatorsFor substitutes test data into a target and into recorded locators', () => {
  const vars = [{ key: 'orderId', value: '1250' }];
  // Renaming is judged on the raw target, so a step that still matches keeps its recorded hints.
  assert.deepEqual(
    locatorsFor({ target: 'Order {orderId}', recordedTarget: 'Order {orderId}', locators: { testId: 'row-{orderId}', text: 'Order {orderId}' } }, vars),
    { testId: 'row-1250', text: 'Order 1250' }
  );
  assert.deepEqual(
    locatorsFor({ target: 'Order {orderId}', recordedTarget: 'Save', locators: { testId: 'save' } }, vars),
    { label: 'Order 1250', text: 'Order 1250', placeholder: 'Order 1250' }
  );
  assert.deepEqual(locatorsFor({ target: '{nope}' }, vars), { label: '{nope}', text: '{nope}', placeholder: '{nope}' });
});

test('expandSteps leaves out disabled steps, inside blocks too', () => {
  const blocks = [{ id: 'b1', name: 'Log in', steps: [{ action: 'Click', target: 'A' }, { action: 'Click', target: 'B', disabled: true }] }];
  const out = expandSteps([
    { action: 'Click', target: 'Off', disabled: true },
    { action: 'Use block', value: 'b1' },
    { action: 'Use block', value: 'b1', disabled: true }
  ], blocks);
  assert.deepEqual(out.map((s) => s.target), ['A']);
});

test('stepRefs lists every name a step reads, and missingFor the ones with no value', () => {
  const step = {
    action: 'Type',
    value: 'Order {orderId}',
    target: 'Row {orderId}',
    locator: "getByRole('row', { name: 'Order {orderId}' })",
    grid: { grid: { label: '{gridName} orders' }, column: { header: '{col}' }, row: { mode: 'match', column: { header: '{keyCol}' }, value: '{orderId}' } }
  };
  assert.deepEqual(stepRefs(step).sort(), ['col', 'gridName', 'keyCol', 'orderId']);
  assert.deepEqual(missingFor(step, [{ key: 'orderId', value: '1' }, { key: 'col', value: 'Status' }]).sort(), ['gridName', 'keyCol']);
  // A capture template writes its names, so they are not read.
  assert.deepEqual(stepRefs({ action: 'Save value from text', value: 'Order {orderId} created', target: 'the {where}' }), ['where']);
  assert.deepEqual(stepRefs({ action: 'Click', target: 'Save' }), []);
});

test('resolveGrid fills in the row, the column and the grid name', () => {
  const g = { grid: { label: '{gridName}' }, column: { header: '{col}' }, row: { mode: 'match', column: { header: 'Order ID' }, value: '{orderId}' } };
  const vars = [{ key: 'gridName', value: 'Orders' }, { key: 'col', value: 'Status' }, { key: 'orderId', value: '1250' }];
  const r = resolveGrid(g, vars);
  assert.deepEqual([r.grid.label, r.column.header, r.row.value], ['Orders', 'Status', '1250']);
  assert.equal(g.row.value, '{orderId}', 'the step itself is not changed');
  assert.equal(resolveGrid({ row: { mode: 'index', index: 2 } }, vars).row.index, 2);
});

test('resolveStep fills in a step for the run view and reports', () => {
  const vars = [{ key: 'orderId', value: '1250' }];
  // The name in the run view comes from the locator when no target is set, so it must be resolved too.
  const locatorOnly = { action: 'Click', target: '', locator: "getByRole('link', { name: 'Order {orderId}' })" };
  const r = resolveStep(locatorOnly, vars, {});
  assert.equal(r.locator, "getByRole('link', { name: 'Order 1250' })");
  assert.equal(describeStep(r, []), 'Click “Order 1250”');

  assert.equal(resolveStep({ action: 'Open page', value: '/orders/{orderId}' }, vars, {}).value, '/orders/1250');
  // A hidden value and a capture template are left exactly as they were typed.
  assert.equal(resolveStep({ action: 'Type', value: '{orderId}', secret: true }, vars, {}).value, '{orderId}');
  assert.equal(resolveStep({ action: 'Save value from text', value: 'Order {orderId} created' }, vars, {}).value, 'Order {orderId} created');
  // An invalid locator is left alone here and reported when the step runs.
  assert.equal(resolveStep({ action: 'Click', locator: 'getByRole(' }, vars, {}).locator, 'getByRole(');
});
