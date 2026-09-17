const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSuite } = require('../../src/validate');
const { parseArgs } = require('../../src/cli-args');
const { ACTIONS, describeStep, expectedResult } = require('../../src/describe');

test('validateSuite reports errors and warnings', () => {
  const data = {
    blocks: [],
    variables: [{ key: 'user', value: 'a' }],
    tests: [
      { id: 'TC1', steps: [{ action: 'Open page', value: '/' }, { action: 'Type', target: 'User', value: '{nobody}' }] },
      { id: 'TC1', steps: [] },
      { id: 'TC2', steps: [{ action: 'Verify text appears', value: '' }, { action: 'Use block', value: 'gone' }, { action: 'Explode' }] }
    ]
  };
  const p = validateSuite(data);
  const has = (level, where, re) => p.some((x) => x.level === level && x.where === where && re.test(x.message));
  assert.ok(has('error', 'TC1', /Duplicate test ID/));
  assert.ok(has('error', 'TC1', /no steps/));
  assert.ok(has('error', 'TC1 step 2', /\{nobody\}/));
  assert.ok(has('warning', 'TC1', /no checks/));
  assert.ok(has('error', 'TC2 step 1', /No value/));
  assert.ok(has('error', 'TC2 step 2', /block that does not exist/));
  assert.ok(has('error', 'TC2 step 3', /Unknown action/));
});

test('validateSuite warns once about secrets with no value', () => {
  const data = { blocks: [], tests: [{ id: 'T', steps: [{ action: 'Type', target: 'A', value: '{pw}' }, { action: 'Type', target: 'B', value: '{pw}' }, { action: 'Verify text appears', value: 'ok' }] }] };
  const p = validateSuite(data, [{ key: 'pw', value: '', secret: true }]);
  assert.equal(p.length, 1);
  assert.match(p[0].message, /TS_VAR_pw/);
  assert.equal(validateSuite(data, [{ key: 'pw', value: 'x', secret: true }]).length, 0);
});

test('parseArgs handles commands, repeatable and inline options', () => {
  const a = parseArgs(['run', '--suite', 's', '--tag', 'smoke', '--tag=p1', '--retries', '2', '--docx']);
  assert.equal(a.command, 'run');
  assert.equal(a.suite, 's');
  assert.deepEqual(a.tag, ['smoke', 'p1']);
  assert.equal(a.retries, '2');
  assert.equal(a.docx, true);
  assert.equal(parseArgs([]).command, 'help');
  assert.throws(() => parseArgs(['run', '--bogus']), /Unknown option/);
  assert.throws(() => parseArgs(['run', '--suite']), /needs a value/);
  assert.throws(() => parseArgs(['run', '--retries', 'two']), /whole number/);
  assert.throws(() => parseArgs(['deploy']), /Unknown command/);
});

test('every action has a description and an expected result', () => {
  for (const action of ACTIONS) {
    const text = describeStep({ action, target: 'X', value: 'Y' }, []);
    assert.ok(text && text !== action || action === 'Wait', action);
    assert.match(expectedResult({ action, text }), /^Expected: /);
  }
  assert.equal(describeStep({ action: 'Verify field value', target: 'Password', value: 'hunter2', secret: true }), 'Check that Password is “••••••••”');
});

test('validateSuite tracks saved values in step order, across blocks and shared tests', () => {
  const save = (name, share) => ({ action: 'Save value from text', value: 'Order {' + name + '} created', shareWithRun: !!share });
  const open = (name) => ({ action: 'Open page', value: '/orders/{' + name + '}' });
  const data = {
    blocks: [{ id: 'b', name: 'Create order', steps: [save('blockId')] }],
    tests: [
      { id: 'A', steps: [open('orderId'), save('orderId'), open('orderId')] },
      { id: 'B', steps: [{ action: 'Use block', value: 'b' }, open('blockId'), save('sharedId', true)] },
      { id: 'C', steps: [open('sharedId'), open('orderId'), { action: 'Save value from text', value: 'no placeholder' }] }
    ]
  };
  const p = validateSuite(data, []);
  const at = (where) => p.filter((x) => x.where === where && x.level === 'error').map((x) => x.message);
  assert.match(at('A step 1').join(), /\{orderId\} is used before/);
  assert.deepEqual(at('A step 3'), []);
  assert.deepEqual(at('B step 2'), []);
  assert.deepEqual(at('C step 1'), [], 'shared value from an earlier test is available');
  assert.match(at('C step 2').join(), /\{orderId\} is used before/, 'values are not shared unless asked');
  assert.match(at('C step 3').join(), /curly brackets/);
});

test('validateSuite checks grid targets', () => {
  const data = { blocks: [], tests: [{ id: 'G', steps: [
    { action: 'Click', grid: { part: 'cell', column: { header: 'Status' }, row: { mode: 'match', column: { header: 'Order ID' }, value: '' } } },
    { action: 'Verify element text', value: 'x', grid: { part: 'header', column: {} } },
    { action: 'Double-click', grid: { part: 'cell', column: { colId: 'notes' }, row: { mode: 'match', column: { colId: 'id' }, value: '{missing}' } } }
  ] }] };
  const p = validateSuite(data, []);
  const msg = (where) => p.filter((x) => x.where === where).map((x) => x.message).join(' | ');
  assert.match(msg('G step 1'), /which grid row/);
  assert.match(msg('G step 2'), /column is not set/);
  assert.match(msg('G step 3'), /Test data not found: \{missing\}/);
});
