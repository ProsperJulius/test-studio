// Electron entry used by recorder-tree.js: records real clicks on the AG Grid tree data page and prints
// the grid targets the recorder produced.
const { app, BrowserWindow } = require('electron');
const recorder = require('../../src/recorder');

const base = process.argv[process.argv.length - 1];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('window-all-closed', () => {});

process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });
app.whenReady().then(async () => {
  let steps = [];
  recorder.start(base + '/tree.html', { onChange: (s) => { steps = s; }, onClose: () => {}, onNotice: () => {} }, { testIdAttribute: 'data-testid' });
  const win = BrowserWindow.getAllWindows().find((w) => /Recording/.test(w.getTitle()));
  const wc = win.webContents;
  await new Promise((r) => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
  await wait(1200);

  // Finds an element with a page expression (after scrolling the grid to it) and clicks its centre.
  const clickAt = async (expression) => {
    const p = await wc.executeJavaScript(`(() => {
      const e = ${expression};
      if (!e) throw new Error('No element for ' + ${JSON.stringify(expression)});
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
    wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await wait(700);
  };
  const scrollTo = async (rowId, position) => {
    await wc.executeJavaScript(`gridApi.ensureNodeVisible(gridApi.getRowNode(${JSON.stringify(rowId)}), ${JSON.stringify(position)})`);
    await wait(600);
  };
  // A folder row on screen, by its name and level.
  const folder = (name, level) => `Array.from(document.querySelectorAll('.ag-row.ag-row-level-${level}')).find((r) => (r.querySelector('.ag-group-value') || {}).textContent === ${JSON.stringify(name)})`;
  const cell = (rowId, colId) => `document.querySelector('.ag-row[row-id="${rowId}"] .ag-cell[col-id="${colId}"]')`;

  await clickAt(folder('Documents', 0) + `.querySelector('.ag-group-contracted')`);   // expand Documents
  await clickAt(cell('f3', 'created'));                                                // Documents › Work › ProjectAlpha › Proposal.docx
  await clickAt(cell('f0', 'created'));                                                // Desktop › ProjectAlpha › Proposal.docx
  // Far down the Archive branch, scrolled so its folders are off screen or stuck to the top.
  await wc.executeJavaScript(`document.querySelector('.ag-grid-viewport').scrollTop = 4000`);
  await wait(400);
  await wc.executeJavaScript(`document.querySelector('.ag-grid-viewport').scrollTop = 8000`);
  await wait(400);
  await scrollTo('f244', 'middle');
  await clickAt(cell('f244', 'modified'));                                             // Archive › 2024 › Month 11 › report-2.pdf
  await scrollTo('f7', 'middle');
  await clickAt(folder('Family', 1) + `.querySelector('.ag-group-expanded')`);         // collapse Pictures › Family
  await clickAt(folder('Vacation2019', 1) + `.querySelector('.ag-group-checkbox input, .ag-checkbox-input-wrapper')`); // select
  await clickAt(folder('Vacation2019', 1) + `.querySelector('.ag-group-checkbox input, .ag-checkbox-input-wrapper')`); // deselect

  recorder.stop();
  const out = steps.slice(1).map((s) => ({ action: s.action, grid: s.grid && { row: s.grid.row, column: s.grid.column && s.grid.column.header, inner: s.grid.inner } }));
  process.stdout.write('STEPS ' + JSON.stringify(out) + '\n');
  app.exit(0);
});
