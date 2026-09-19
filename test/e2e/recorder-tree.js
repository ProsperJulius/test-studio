// Records real clicks on the AG Grid tree data page (Enterprise) and checks that tree rows are recorded by
// path, including rows whose folders have scrolled out of view, and that arrows and checkboxes become
// Expand / Collapse / Select / Deselect steps.
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { start } = require('../fixture/server');

(async () => {
  const server = await start(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  const child = spawn(require('electron'), [path.join(__dirname, 'recorder-tree-main.js'), base], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buffer = '';
  child.stdout.on('data', (d) => { buffer += d; });
  await new Promise((resolve) => child.on('exit', resolve));
  server.close();

  const m = /STEPS (.*)\n/.exec(buffer);
  if (!m) { console.error('The recorder did not report any steps.'); process.exit(1); }
  const steps = JSON.parse(m[1]);
  console.log('Recorded:\n  ' + steps.map((s) => s.action + '  ' + (s.grid ? (s.grid.inner || s.grid.column) + '  ' + s.grid.row.mode + ' ' + (s.grid.row.value || s.grid.row.index) : '')).join('\n  '));

  const summary = steps.map((s) => [s.grid.inner || s.grid.column, s.grid.row.mode, s.grid.row.value]);
  try {
    assert.deepEqual(summary, [
      ['expand', 'path', 'Documents'],
      ['Created', 'path', 'Documents › Work › ProjectAlpha › Proposal.docx'],
      ['Created', 'path', 'Desktop › ProjectAlpha › Proposal.docx'],
      ['Modified', 'path', 'Archive › 2024 › Month 11 › report-2.pdf'],
      ['collapse', 'path', 'Pictures › Family'],
      ['select', 'path', 'Pictures › Vacation2019'],
      ['deselect', 'path', 'Pictures › Vacation2019']
    ]);
    assert.ok(steps.every((s) => s.action === 'Click' && s.grid.row.column.header === 'File Explorer'));
  } catch (e) {
    console.error(e.message);
    console.log('\nRecorder tree checks FAILED.');
    process.exit(1);
  }
  console.log('\nRecorder tree checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
