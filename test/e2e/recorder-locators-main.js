// Electron entry used by recorder-locators.js: records clicks and typing with real input events,
// prints the recorded steps, then opens the pages again so Playwright can check each locator.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const recorder = require('../../src/recorder');

const base = process.argv[process.argv.length - 1];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('window-all-closed', () => {});

async function record(url, actions) {
  let steps = [];
  recorder.start(url, { onChange: (s) => { steps = s; }, onClose: () => {}, onNotice: () => {} }, { testIdAttribute: 'data-testid' });
  const win = BrowserWindow.getAllWindows().find((w) => /Recording/.test(w.getTitle()));
  const wc = win.webContents;
  await new Promise((r) => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
  await wait(500);
  const center = (selector) => wc.executeJavaScript(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('No element for ' + ${JSON.stringify(selector)}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const click = async (selector) => {
    const p = await center(selector);
    wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
    wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await wait(300);
  };
  const type = async (selector, text, commit) => {
    await click(selector);
    for (const ch of text) wc.sendInputEvent({ type: 'char', keyCode: ch });
    const key = commit ? 'Enter' : 'Tab';
    wc.sendInputEvent({ type: 'keyDown', keyCode: key });
    if (commit) wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: key });
    await wait(300);
  };
  for (const [kind, selector, text] of actions) {
    if (kind === 'click') await click(selector);
    else await type(selector, text, kind === 'enter');
  }
  recorder.stop();
  return steps.slice(1).map((s) => ({ action: s.action, target: s.target, locator: s.locator, value: s.value }));
}

process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });
app.whenReady().then(async () => {
  const steps = [];
  steps.push(...await record(base + '/locators.html', [
    ['click', '[data-testid=save-draft]'],
    ['click', 'tbody tr:nth-child(2) button'],
    ['click', '[role=dialog][aria-label="Edit order"] button:nth-of-type(2)'],
    ['type', '#first', 'Ada'],
    ['click', 'input[type=checkbox]:not([checked])'],
    ['click', 'ul li:nth-child(2) button'],
    ['click', '[role=button][tabindex]'],
    ['click', 'img[alt="Company logo"]'],
    ['click', 'p:has(> b)'],
    ['click', '[title="Help text"]'],
    ['click', 'nav a:not([href])']
  ]));
  steps.push(...await record(base + '/login.html', [
    ['type', '#user', 'alice'],
    ['click', '[data-testid=sign-in]'],
    ['enter', '#pass', 'correct-horse']
  ]));
  process.stdout.write('STEPS ' + JSON.stringify(steps) + '\n');

  for (const page of ['/locators.html', '/login.html']) {
    const w = new BrowserWindow({ width: 1280, height: 900, show: false });
    await w.loadURL(base + page);
  }
  process.stdout.write('READY\n');
});
