const test = require('node:test');
const assert = require('node:assert/strict');
const { exportTests, parseTests, importTests } = require('../../src/tests-yaml');

const data = () => ({
  blocks: [
    { id: 'b1', name: 'Log in', steps: [{ action: 'Use block', value: 'b2' }] },
    { id: 'b2', name: 'Open', steps: [{ action: 'Open page', value: '/' }] },
    { id: 'b3', name: 'Unused', steps: [] }
  ],
  tests: [
    {
      id: 'TC001', title: 'Checkout', tags: ['smoke'], priority: 'P1', requirement: '', approval: 'Approved', lastStatus: 'Passed', lastRun: '2026-01-01', flaky: true,
      steps: [
        { id: 's1', action: 'Use block', value: 'b1' },
        { id: 's2', action: 'Click', target: 'Save', locator: "getByRole('button', { name: 'Save' })", disabled: true },
        { id: 's3', action: 'Click', target: 'Cell', grid: { column: { colId: 'x', header: 'X' }, part: 'cell', row: { mode: 'index', index: 0 } } },
        { id: 's4', action: 'Type', target: 'Password', value: 'hunter2', secret: true }
      ]
    },
    { id: 'TC002', title: 'Other', steps: [{ action: 'Click', target: 'A' }] }
  ]
});

test('exportTests round-trips through parseTests', () => {
  const { text, warnings } = exportTests(data(), ['TC001']);
  const { tests, blocks } = parseTests(text);
  assert.equal(tests.length, 1);
  const t = tests[0];
  assert.equal(t.id, 'TC001');
  assert.equal(t.steps[1].locator, "getByRole('button', { name: 'Save' })");
  assert.equal(t.steps[1].disabled, true);
  assert.deepEqual(t.steps[2].grid.column, { colId: 'x', header: 'X' });
  assert.equal(t.lastStatus, undefined);
  assert.equal(t.flaky, undefined);
  assert.equal(t.steps[3].value, '');
  assert.equal(warnings.length, 1);
  assert.deepEqual(blocks.map((b) => b.id).sort(), ['b1', 'b2']);
});

test('parseTests accepts a single test and fills in defaults', () => {
  const { tests, blocks } = parseTests('id: TC009\ntitle: Quick\nsteps:\n  - action: Click\n    target: Go\n');
  assert.equal(tests[0].priority, 'P2');
  assert.deepEqual(tests[0].tags, []);
  assert.equal(tests[0].approval, 'Not submitted');
  assert.deepEqual(blocks, []);
});

test('parseTests reports broken files clearly', () => {
  assert.throws(() => parseTests('tests: [unclosed'), /not valid YAML/);
  assert.throws(() => parseTests('format: test-studio-tests\ntests:\n  - id: T1\n    title: x\n'), /T1 has no list of steps/);
  assert.throws(() => parseTests('format: test-studio-tests\ntests:\n  - id: T1\n    title: x\n    steps:\n      - target: A\n'), /T1 step 1 has no action/);
  assert.throws(() => parseTests('hello: world'), /not a Test Studio tests file/);
});

test('importTests replaces tests with the same ID but keeps their last result', () => {
  const target = data();
  const parsed = parseTests('id: TC001\ntitle: Renamed\nsteps: []\n');
  const counts = importTests(target, parsed);
  assert.deepEqual(counts, { tests: 1, blocks: 0 });
  const t = target.tests.find((x) => x.id === 'TC001');
  assert.equal(t.title, 'Renamed');
  assert.equal(t.lastStatus, 'Passed');
  assert.equal(target.tests.length, 2);
});

test('parseTests rejects a {name} that YAML read as a mapping instead of text', () => {
  const head = 'format: test-studio-tests\nversion: 1\ntests:\n  - id: TC001\n    title: Checkout\n    steps:\n      - action: Type\n        target: Order\n';
  // Unquoted, YAML reads {orderId} as a flow mapping, which would silently lose the test data.
  assert.throws(() => parseTests(head + '        value: {orderId}\n'), /value must be text.*'\{orderId\}'/s);
  assert.throws(() => parseTests(head + "        locator: {x: 1}\n"), /locator must be text/);
  assert.equal(parseTests(head + "        value: '{orderId}'\n").tests[0].steps[0].value, '{orderId}');
  // Numbers still pass through, for example a Wait in seconds.
  assert.equal(parseTests(head + '        value: 5\n').tests[0].steps[0].value, 5);
});

test('parseTests rejects a mapping in a grid row value', () => {
  const text = 'format: test-studio-tests\nversion: 1\ntests:\n  - id: TC001\n    title: Grid\n    steps:\n      - action: Click\n        grid:\n          row:\n            mode: match\n            value: {orderId}\n';
  assert.throws(() => parseTests(text), /grid\.row\.value must be text/);
});
