// Records actions on the fixture pages and checks the generated locators: they match what we expect,
// and real Playwright finds exactly the one element each time.
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { start } = require('../fixture/server');

const EXPECTED = [
  "getByTestId('save-draft')",
  "getByRole('row', { name: 'Order 1002 Pending Edit' }).getByRole('button', { name: 'Edit' })",
  "getByRole('dialog', { name: 'Edit order' }).getByRole('button', { name: 'Cancel' })",
  "getByRole('textbox', { name: 'First name *' })",
  "getByRole('checkbox', { name: 'Subscribe to offers' })",
  "getByRole('listitem').filter({ hasText: 'Pears' }).getByRole('button', { name: 'Remove' })",
  "getByRole('button', { name: 'Div button' })",
  "getByRole('img', { name: 'Company logo' })",
  "getByText('Welcome back, Jane!')",
  "getByText('?')",
  "getByText('No href')",
  "getByRole('textbox', { name: 'Username' })",
  "getByTestId('sign-in')",
  // Typing in the password box and pressing Enter. The browser submits the form the same way as
  // pressing the button, so it reports a click on it too, and the recorder keeps that.
  "getByRole('textbox', { name: 'Password' })",
  "getByTestId('sign-in')"
];

(async () => {
  const server = await start(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  const port = 9800 + Math.floor(Math.random() * 150);
  const child = spawn(require('electron'), ['--remote-debugging-port=' + port, path.join(__dirname, 'recorder-locators-main.js'), base], { stdio: ['ignore', 'pipe', 'inherit'] });
  let steps = null;
  await new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', (d) => {
      buffer += d;
      const m = /STEPS (.*)\n/.exec(buffer);
      if (m && !steps) steps = JSON.parse(m[1]);
      if (buffer.includes('READY')) resolve();
    });
    child.on('exit', (code) => reject(new Error('Electron exited with ' + code)));
  });

  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  let failed = false;
  try {
    const pages = browser.contexts()[0].pages();
    const pageFor = (i) => pages.find((p) => p.url().endsWith(i < 11 ? '/locators.html' : '/login.html'));
    const recorded = steps.map((s) => s.locator);
    console.log('Recorded locators:\n  ' + steps.map((s) => s.action + '  ' + s.locator + '  (' + s.target + ')').join('\n  '));
    for (let i = 0; i < EXPECTED.length; i++) {
      const count = await new Function('page', 'return page.' + recorded[i])(pageFor(i)).count();
      if (count !== 1) { failed = true; console.log('NOT UNIQUE in Playwright (' + count + '): ' + recorded[i]); }
    }
    assert.deepEqual(recorded, EXPECTED);
    assert.equal(steps[3].action, 'Type');
    assert.equal(steps[3].value, 'Ada');
    assert.equal(steps[5].target, 'Remove');
    // Typing then Enter in the same field is one step, not Type followed by Press Enter.
    assert.equal(steps[13].action, 'Type and press Enter');
    assert.equal(steps[13].value, 'correct-horse');
    assert.ok(!steps.some((s) => s.action === 'Press Enter'), 'the Enter was folded into the Type step');
  } catch (e) {
    failed = true;
    console.error(e.message);
  } finally {
    await browser.close().catch(() => {});
    child.kill();
    server.close();
  }
  console.log(failed ? '\nRecorder locator checks FAILED.' : '\nRecorder locator checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
