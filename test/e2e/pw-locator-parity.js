// Checks that src/pw-locator.js builds the same Playwright locator that Playwright's own
// expression would. This is what the runner now relies on to find elements.
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { start } = require('../fixture/server');
const { parseLocator } = require('../../src/locator-parse');
const { buildLocator } = require('../../src/pw-locator');

const LOCATORS = require('./locator-corpus');

(async () => {
  const server = await start(0);
  const url = 'http://127.0.0.1:' + server.address().port + '/locators.html';
  const port = 9300 + Math.floor(Math.random() * 500);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // the binary would otherwise run as plain Node
  const electron = spawn(require('electron'), ['--remote-debugging-port=' + port, path.join(__dirname, 'parity-main.js'), url], { stdio: ['ignore', 'pipe', 'inherit'], env });
  await new Promise((resolve, reject) => {
    electron.stdout.on('data', (d) => { if (String(d).includes('READY')) resolve(); });
    electron.on('exit', (code) => reject(new Error('Electron exited with ' + code)));
  });

  let failures = 0;
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  try {
    const page = browser.contexts()[0].pages().find((p) => p.url() === url);
    for (const text of LOCATORS) {
      const parsed = parseLocator(text);
      if (!parsed.ok) { console.log('PARSE ERROR ' + text + ': ' + parsed.error); failures++; continue; }

      await page.evaluate(() => document.querySelectorAll('[data-pw],[data-built]').forEach((e) => { e.removeAttribute('data-pw'); e.removeAttribute('data-built'); }));
      const expected = new Function('page', 'return page.' + text)(page);
      let built;
      try {
        built = buildLocator(page, parsed.ast);
      } catch (e) {
        console.log('BUILD ERROR ' + text + ': ' + e.message);
        failures++;
        continue;
      }
      await expected.evaluateAll((els) => els.forEach((e, i) => e.setAttribute('data-pw', String(i))));
      await built.evaluateAll((els) => els.forEach((e, i) => e.setAttribute('data-built', String(i))));

      const diff = await page.evaluate(() => {
        const describe = (e) => e.outerHTML.replace(/ data-(pw|built)="\d+"/g, '').slice(0, 90);
        const a = Array.from(document.querySelectorAll('[data-pw]')).sort((x, y) => x.dataset.pw - y.dataset.pw);
        const b = Array.from(document.querySelectorAll('[data-built]')).sort((x, y) => x.dataset.built - y.dataset.built);
        const same = a.length === b.length && a.every((e, i) => b[i] === e);
        return same ? null : { expected: a.map(describe), built: b.map(describe) };
      });
      if (diff) {
        failures++;
        console.log('\nMISMATCH ' + text);
        console.log('  page.' + text + ' (' + diff.expected.length + '):\n    ' + diff.expected.join('\n    '));
        console.log('  buildLocator (' + diff.built.length + '):\n    ' + diff.built.join('\n    '));
      }
    }
  } finally {
    await browser.close().catch(() => {});
    electron.kill();
    server.close();
  }
  console.log('\n' + (LOCATORS.length - failures) + ' of ' + LOCATORS.length + ' locators build identically.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
