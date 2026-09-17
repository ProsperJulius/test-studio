const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exportSuite, loadSuite, importSuite } = require('../../src/suite');
const { migrate } = require('../../src/store');
const reporters = require('../../src/reporters');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ts-suite-'));

function sample() {
  return migrate({
    settings: { appName: 'Shop', activeEnvironment: 'QA', stepTimeout: 10, retries: 1 },
    variables: [{ key: 'user', value: 'alice' }, { key: 'password', value: 's3cret', secret: true }],
    environments: [{ name: 'QA', baseUrl: 'https://qa', variables: [{ key: 'password', value: 'qa-pass', secret: true }] }],
    blocks: [{ id: 'b1', name: 'Log in', steps: [{ action: 'Type', target: 'Password', value: '{password}', secret: true }] }],
    tests: [{ id: 'TC001', title: 'Buy', tags: ['smoke'], lastStatus: 'Passed', lastRun: 'x', steps: [{ action: 'Type', target: 'PIN', value: '1234', secret: true }] }],
    runs: []
  });
}

test('migrate moves old environment settings into an environment profile', () => {
  const d = migrate({ settings: { environment: 'UAT', baseUrl: 'https://uat' }, tests: [{ id: 'T', steps: [] }] });
  assert.deepEqual(d.environments, [{ name: 'UAT', baseUrl: 'https://uat', variables: [] }]);
  assert.equal(d.settings.activeEnvironment, 'UAT');
  assert.equal(d.settings.baseUrl, undefined);
  assert.deepEqual(d.tests[0].tags, []);
});

test('exportSuite writes files without secrets or runtime fields, and loadSuite reads them back', () => {
  const dir = tmp();
  const warnings = exportSuite(sample(), dir);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /TC001 step 1 has a hidden value/);

  const all = fs.readdirSync(dir, { recursive: true }).map(String).sort();
  assert.ok(all.includes(path.join('tests', 'TC001.json')));
  const text = all.filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  assert.ok(!text.includes('s3cret') && !text.includes('qa-pass') && !text.includes('1234'));
  assert.ok(!text.includes('lastStatus'));

  const loaded = loadSuite(dir);
  assert.equal(loaded.tests[0].id, 'TC001');
  assert.equal(loaded.blocks[0].steps[0].value, '{password}');
  assert.equal(loaded.settings.retries, 1);
});

test('exportSuite removes deleted tests and refuses folders with other files', () => {
  const dir = tmp();
  const data = sample();
  exportSuite(data, dir);
  data.tests = [];
  exportSuite(data, dir);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'tests')), []);

  const other = tmp();
  fs.writeFileSync(path.join(other, 'notes.txt'), 'hi');
  assert.throws(() => exportSuite(data, other), /already contains other files/);
});

test('importSuite upserts tests and keeps local secret values', () => {
  const dir = tmp();
  exportSuite(sample(), dir);
  const target = sample();
  target.tests[0].title = 'Old title';
  const counts = importSuite(target, dir);
  assert.deepEqual(counts, { tests: 1, blocks: 1, environments: 1 });
  assert.equal(target.tests[0].title, 'Buy');
  assert.equal(target.tests[0].lastStatus, 'Passed');
  assert.equal(target.variables.find((v) => v.key === 'password').value, 's3cret');
  assert.equal(target.environments[0].variables[0].value, 'qa-pass');
});

function run() {
  return {
    id: 'r1', trigger: 'Command line', status: 'Failed', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:10.000Z',
    settings: { appName: 'Shop <&>', environment: 'QA' },
    tests: [
      { id: 'TC1', title: 'Login', status: 'Passed', tags: ['smoke'], attempts: 2, flaky: true, steps: [{ num: 1, text: 'Click “Go”', status: 'passed', ms: 1000 }], previousAttempts: [{ attempt: 1, failedStep: 1, error: 'boom', ms: 500 }] },
      { id: 'TC2', title: 'Pay "now"', status: 'Failed', tags: [], steps: [{ num: 1, text: 'Check', status: 'failed', error: 'Expected <b>', ms: 2000, screenshot: 't2-step01.png' }], consoleErrors: ['oops'] },
      { id: 'TC3', title: 'Old', status: 'Passed', tags: [], steps: [] }
    ]
  };
}

test('compareWithPrevious labels new failures, still failing and fixed tests', () => {
  const r = reporters.compareWithPrevious(run(), { TC2: 'Passed', TC3: 'Failed' });
  assert.deepEqual(r.tests.map((t) => t.change), ['New test', 'New failure', 'Fixed']);
  assert.equal(reporters.compareWithPrevious(run(), { TC2: 'Failed' }).tests[1].change, 'Still failing');
  const sum = reporters.summarize(r);
  assert.equal(sum.flaky, 1);
  assert.equal(sum.newFailures, 1);
  assert.equal(sum.fixed, 1);
});

test('toJUnit produces escaped XML with failures and properties', () => {
  const x = reporters.toJUnit(run());
  assert.match(x, /<testsuites name="Test Studio" tests="3" failures="1" skipped="0" time="10.000">/);
  assert.match(x, /name="Shop &lt;&amp;&gt; \(QA\)"/);
  assert.match(x, /name="TC2 Pay &quot;now&quot;"/);
  assert.match(x, /<failure message="Step 1: Expected &lt;b&gt;" type="StepFailed">/);
  assert.match(x, /<property name="flaky" value="true"\/>/);
  assert.match(x, /time="1.500"/);
  assert.ok(!/<b>/.test(x));
});

test('toJson and toHtml summarise the run', () => {
  const j = reporters.toJson(run());
  assert.equal(j.summary.failed, 1);
  assert.deepEqual(j.tests[1].failure, { step: 1, text: 'Check', error: 'Expected <b>', screenshot: 't2-step01.png' });
  const h = reporters.toHtml(run());
  assert.ok(h.includes('Expected &lt;b&gt;'));
  assert.ok(h.includes('src="t2-step01.png"'));
});
