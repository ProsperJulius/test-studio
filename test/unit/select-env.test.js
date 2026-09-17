const test = require('node:test');
const assert = require('node:assert/strict');
const { selectTests, parseTags } = require('../../src/select');
const { resolveEnvironment } = require('../../src/environments');

const tests = [
  { id: 'TC001', tags: ['smoke', 'login'], approval: 'Approved' },
  { id: 'TC002', tags: ['Checkout'], approval: 'Not submitted' },
  { id: 'TC003', tags: [], approval: 'Approved' }
];

test('selectTests filters by tag (any, case-insensitive), exclusion, ids and approval', () => {
  const ids = (list) => list.map((t) => t.id);
  assert.deepEqual(ids(selectTests(tests, { tags: ['checkout,smoke'] })), ['TC001', 'TC002']);
  assert.deepEqual(ids(selectTests(tests, { excludeTags: 'login' })), ['TC002', 'TC003']);
  assert.deepEqual(ids(selectTests(tests, { ids: ['TC003', 'TC002'] })), ['TC002', 'TC003']);
  assert.deepEqual(ids(selectTests(tests, { approvedOnly: true })), ['TC001', 'TC003']);
  assert.equal(selectTests(tests, {}).length, 3);
});

test('parseTags normalises and removes duplicates', () => {
  assert.deepEqual(parseTags(' Smoke, smoke checkout,,'), ['smoke', 'checkout']);
});

const data = {
  settings: { activeEnvironment: 'QA', stepTimeout: 10 },
  variables: [{ key: 'user', value: 'default' }, { key: 'password', value: 'x', secret: true }],
  environments: [
    { name: 'QA', baseUrl: 'https://qa', variables: [{ key: 'user', value: 'qa-user' }] },
    { name: 'UAT', baseUrl: 'https://uat', variables: [{ key: 'user', value: '' }] }
  ]
};

test('resolveEnvironment applies environment overrides, blanks fall back, CLI and TS_VAR_ win', () => {
  const qa = resolveEnvironment(data);
  assert.equal(qa.settings.environment, 'QA');
  assert.equal(qa.settings.baseUrl, 'https://qa');
  assert.equal(qa.variables.find((v) => v.key === 'user').value, 'qa-user');

  const uat = resolveEnvironment(data, 'uat', { baseUrl: 'http://localhost:1', retries: '2' }, { TS_VAR_password: 'from-ci', PATH: '/bin' });
  assert.equal(uat.settings.environment, 'UAT');
  assert.equal(uat.settings.baseUrl, 'http://localhost:1');
  assert.equal(uat.settings.retries, '2');
  assert.equal(uat.variables.find((v) => v.key === 'user').value, 'default');
  assert.equal(uat.variables.find((v) => v.key === 'password').value, 'from-ci');
});

test('resolveEnvironment rejects unknown environment names', () => {
  assert.throws(() => resolveEnvironment(data, 'prod'), /Unknown environment “prod”.*QA, UAT/);
});
