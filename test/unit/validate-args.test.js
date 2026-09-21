const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSuite } = require('../../src/validate');
const { parseArgs } = require('../../src/cli-args');
const { ACTIONS, describeStep, expectedResult, usesGrid } = require('../../src/describe');

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
  const p = validateSuite(data, [{ key: 'pw', value: '', secret: true }]).filter((x) => x.level !== 'info');
  assert.equal(p.length, 1);
  assert.match(p[0].message, /TS_VAR_pw/);
  assert.equal(validateSuite(data, [{ key: 'pw', value: 'x', secret: true }]).filter((x) => x.level !== 'info').length, 0);
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

test('validateSuite ignores disabled steps and flags tests with every step disabled', () => {
  const data = {
    blocks: [],
    tests: [
      { id: 'T1', steps: [{ action: 'Click', target: '', disabled: true }, { action: 'Verify text appears', value: 'ok' }] },
      { id: 'T2', steps: [{ action: 'Verify text appears', value: 'ok', disabled: true }] },
      { id: 'T3', steps: [{ action: 'Save value from text', value: 'Order {order}', disabled: true }, { action: 'Type', target: 'A', value: '{order}' }, { action: 'Verify text appears', value: 'ok' }] }
    ]
  };
  const p = validateSuite(data, []);
  assert.ok(!p.some((x) => x.where.startsWith('T1') && x.level === 'error'));
  assert.ok(p.some((x) => x.where === 'T2' && /All steps are disabled/.test(x.message)));
  // The step that saves {order} is turned off, which is different from there being no such test data.
  assert.ok(p.some((x) => x.where === 'T3 step 2' && /\{order\} is saved by a “Save value from text” step that is turned off/.test(x.message)));
  assert.ok(!p.some((x) => x.where === 'T3 step 2' && /not found/.test(x.message)));
});

test('grid rows can be matched by part of a value and checked as not in the grid', () => {
  const g = (action, part) => ({ action, grid: { grid: { label: 'Orders' }, part: part || 'cell', column: { header: '' }, row: { mode: 'match', match: 'contains', column: { header: 'Customer' }, value: 'Jane' } } });
  assert.equal(describeStep({ ...g('Click'), grid: { ...g('Click').grid, column: { header: 'Status' } } }), 'Click “Status” in the Orders grid, row where Customer contains “Jane”');
  assert.equal(describeStep(g('Verify element is hidden')), 'Check that the row where Customer contains “Jane” is not in the Orders grid');

  const p = validateSuite({ blocks: [], tests: [{ id: 'T', steps: [g('Verify element is hidden'), g('Verify element is hidden', 'header'), g('Click')] }] }, []);
  const at = (n) => p.filter((x) => x.where === 'T step ' + n && x.level === 'error').map((x) => x.message);
  assert.deepEqual(at(1), []);
  assert.ok(at(2).some((m) => /Only a row/.test(m)));
  assert.ok(at(3).some((m) => /column is not set/.test(m)));
});

test('tree rows are found by path and can be expanded or collapsed', () => {
  const { splitPath } = require('../../src/describe');
  assert.deepEqual(splitPath('Documents › Work >  Project Alpha / Proposal.docx'), ['Documents', 'Work', 'Project Alpha', 'Proposal.docx']);
  assert.deepEqual(splitPath('Q1/Q2 report.pdf'), ['Q1/Q2 report.pdf'], 'a slash without spaces is part of the name');

  const tree = (value, extra) => ({ grid: { part: 'cell', column: { header: '' }, row: { mode: 'path', column: { header: 'File Explorer' }, value }, ...extra } });
  assert.equal(describeStep({ action: 'Click', ...tree('Documents > Work', { inner: 'expand' }) }), 'Expand the row “Documents › Work” in the grid');
  assert.equal(describeStep({ action: 'Click', ...tree('Documents', { inner: 'collapse' }) }), 'Collapse the row “Documents” in the grid');
  const created = tree('Documents › Report.pdf');
  created.grid.column = { header: 'Created' };
  assert.equal(describeStep({ action: 'Click', ...created }), 'Click “Created” in the grid, row “Documents › Report.pdf”');

  const p = validateSuite({ blocks: [], tests: [{ id: 'T', steps: [
    { action: 'Click', ...tree('Documents', { inner: 'expand' }) },
    { action: 'Click', ...tree('', { inner: 'expand' }) },
    { action: 'Verify element text', value: 'x', ...created }
  ] }] }, []);
  const at = (i) => p.filter((x) => x.where === 'T step ' + i && x.level === 'error').map((x) => x.message);
  assert.deepEqual(at(1), [], 'expanding needs no column');
  assert.ok(at(2).some((m) => /which tree row/.test(m)));
  assert.deepEqual(at(3), []);
});

test('tree rows can be selected and deselected with their checkbox', () => {
  const tree = (inner) => ({ action: 'Click', grid: { part: 'cell', column: { header: '' }, row: { mode: 'path', column: { header: 'File Explorer' }, value: 'Pictures › Family' }, inner } });
  assert.equal(describeStep(tree('select')), 'Select the row “Pictures › Family” in the grid');
  assert.equal(describeStep(tree('deselect')), 'Deselect the row “Pictures › Family” in the grid');
  const p = validateSuite({ blocks: [], tests: [{ id: 'T', steps: [tree('select'), tree('deselect'), { action: 'Verify text appears', value: 'x' }] }] }, []);
  assert.deepEqual(p.filter((x) => x.level === 'error'), [], 'selecting needs no column');
});

test('a step with a locator is a locator step, even if a grid target is left over', () => {
  const grid = { grid: { label: 'Orders' }, part: 'cell', column: { colId: 'status', header: 'Status' },
    row: { mode: 'match', match: 'equals', column: { colId: 'orderId', header: 'Order ID' }, value: '1005' } };

  assert.equal(usesGrid({ action: 'Click', grid }), true);
  assert.equal(usesGrid({ action: 'Verify element is hidden', grid }), true);
  // Cloning a step or changing its action can leave a grid target on a step that has a locator.
  // Actions gain grid support over time, so without this the step would change what it checks.
  assert.equal(usesGrid({ action: 'Verify element is hidden', grid, locator: "getByTestId('admin')" }), false);
  assert.equal(usesGrid({ action: 'Click', grid, locator: "getByRole('button')" }), false);
  assert.equal(usesGrid({ action: 'Verify element is hidden', grid, locator: '   ' }), true, 'a blank locator is not a locator');
  // Actions that never act on a grid, and steps with no grid target at all.
  assert.equal(usesGrid({ action: 'Verify field value', grid }), false);
  assert.equal(usesGrid({ action: 'Click', target: 'Save' }), false);
  assert.equal(usesGrid(null), false);

  const step = { action: 'Verify element is hidden', target: 'Admin panel', grid, locator: "getByTestId('admin')" };
  assert.equal(describeStep(step), 'Check that “Admin panel” is not visible');
  assert.equal(describeStep({ ...step, locator: undefined }), 'Check that the row where Order ID is “1005” is not in the Orders grid');

  // The leftover grid target is not validated as if it were the step's target.
  const p = validateSuite({ blocks: [], tests: [{ id: 'T', steps: [step] }] }, []);
  assert.deepEqual(p.filter((x) => x.where === 'T step 1' && x.level === 'error'), []);
});
