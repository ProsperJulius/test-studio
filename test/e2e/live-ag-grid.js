// Opt-in check of tree data steps against AG Grid's public File Explorer example (AG Grid 36, Enterprise).
// Tree data needs AG Grid Enterprise, which this project does not ship, so this runs against ag-grid.com
// and needs internet access: npm run test:live-aggrid
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BIN = path.join(__dirname, '..', '..', 'bin', 'test-studio.js');
const URL = 'https://www.ag-grid.com/examples/tree-data/kitchen-sink/typescript/example-runner/';

let n = 0;
const tree = (value, column, inner) => ({
  grid: { index: 0, label: '' },
  part: 'cell',
  column: column ? { colId: column.toLowerCase(), header: column } : { colId: '', header: '' },
  row: { mode: 'path', column: { colId: '', header: 'File Explorer' }, value },
  inner: inner || null
});
const step = (action, grid, value) => ({
  id: 'live' + n++, action, target: grid ? (grid.column.header || 'File Explorer') : 'AG Grid example',
  recordedTarget: '', value: value || '', secret: false, shot: false, locators: null, ...(grid ? { grid } : {})
});

const WORK_PROPOSAL = 'Documents › Work › ProjectAlpha › Proposal.docx';
const test = {
  id: 'LIVE-TREE',
  title: 'AG Grid tree data: paths, expand and collapse',
  tags: ['grid', 'tree'],
  priority: 'P2',
  requirement: '',
  approval: 'Approved',
  startUrl: URL,
  steps: [
    step('Open page', null, URL),
    // Documents is collapsed, so its Proposal.docx is not shown, even though Desktop's Proposal.docx is.
    step('Click', tree('Documents', null, 'collapse')),
    step('Verify element is hidden', tree(WORK_PROPOSAL)),
    step('Verify element is visible', tree('Desktop › ProjectAlpha › Proposal.docx', 'Created')),
    // Finding the row by its path opens Documents › Work › ProjectAlpha again.
    step('Click', tree(WORK_PROPOSAL, 'Created')),
    step('Verify element text', tree(WORK_PROPOSAL, 'Modified'), '2023-08-01'),
    // Collapsing a folder deeper down hides only that branch.
    step('Click', tree('Documents › Work › ProjectAlpha', null, 'collapse')),
    step('Verify element is hidden', tree(WORK_PROPOSAL)),
    // Expand is safe to repeat: the second one does nothing.
    step('Click', tree('Documents › Work › ProjectAlpha', null, 'expand')),
    step('Click', tree('Documents › Work › ProjectAlpha', null, 'expand')),
    step('Verify element text', tree(WORK_PROPOSAL, 'Created'), '2023-07-10'),
    // Rows near the bottom need AG Grid 36 scrolling; the same folder names appear under Pictures and Videos.
    step('Verify element text', tree('Videos › Family › Christmas2021.mov', 'Created'), '2021-12-25'),
    step('Verify element text', tree('Downloads › Ebook.pdf', 'Created'), '2023-08-08'),
    step('Verify element is hidden', tree('Videos › Family › Beach.mov'))
  ]
};

function cli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args]);
    let output = '';
    child.stdout.on('data', (d) => { output += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { output += d; process.stderr.write(d); });
    child.on('exit', (code) => resolve({ code, output }));
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-live-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'suite.json'), JSON.stringify({ format: 'test-studio-suite', version: 1, settings: { stepTimeout: 20 } }));
  fs.writeFileSync(path.join(dir, 'tests', test.id + '.json'), JSON.stringify(test, null, 2));
  const out = path.join(dir, 'out');
  const run = await cli(['run', '--suite', dir, '--out', out]);
  const latest = JSON.parse(fs.readFileSync(path.join(out, 'latest.json'), 'utf8'));
  const result = JSON.parse(fs.readFileSync(path.join(latest.dir, 'results.json'), 'utf8')).tests[0];
  assert.equal(result.status, 'Passed', 'LIVE-TREE: ' + JSON.stringify(result.failure) + '\nIf ag-grid.com changed its example, this may not be a Test Studio problem.');
  assert.equal(run.code, 0);
  console.log('\nLive AG Grid tree data check passed.');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
