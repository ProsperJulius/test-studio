// Checks that Test Studio's locator engine matches the same elements as Playwright.
// Starts Electron with remote debugging, loads the fixture page, and connects Playwright to it.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { start } = require('../fixture/server');
const { parseLocator } = require('../../src/locator-parse');

const ENGINE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'locator-engine.js'), 'utf8');

const LOCATORS = require('./locator-corpus');

(async () => {
  const server = await start(0);
  const url = 'http://127.0.0.1:' + server.address().port + '/locators.html';
  const port = 9300 + Math.floor(Math.random() * 500);
  const main = path.join(__dirname, 'parity-main.js');
  const electron = spawn(require('electron'), ['--remote-debugging-port=' + port, main, url], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    electron.stdout.on('data', (d) => { if (String(d).includes('READY')) resolve(); });
    electron.on('exit', (code) => reject(new Error('Electron exited with ' + code)));
  });

  let failures = 0;
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  try {
    const page = browser.contexts()[0].pages().find((p) => p.url() === url);
    await page.evaluate(ENGINE_LOADER(ENGINE));
    for (const text of LOCATORS) {
      const parsed = parseLocator(text);
      if (!parsed.ok) { console.log('PARSE ERROR', text, parsed.error); failures++; continue; }
      await page.evaluate(() => document.querySelectorAll('[data-pw],[data-ts]').forEach((e) => { e.removeAttribute('data-pw'); e.removeAttribute('data-ts'); }));
      // Playwright's own locator, built from the same source text.
      const pw = new Function('page', 'return page.' + text)(page);
      await pw.evaluateAll((els) => els.forEach((e, i) => e.setAttribute('data-pw', String(i))));
      await page.evaluate((ast) => window.__tsEngine.resolve(ast).forEach((e, i) => e.setAttribute('data-ts', String(i))), parsed.ast);
      const diff = await page.evaluate(() => {
        const describe = (e) => e.outerHTML.replace(/ data-(pw|ts)="\d+"/g, '').slice(0, 90);
        const pw = Array.from(document.querySelectorAll('[data-pw]')).sort((a, b) => a.dataset.pw - b.dataset.pw);
        const ts = Array.from(document.querySelectorAll('[data-ts]')).sort((a, b) => a.dataset.ts - b.dataset.ts);
        const same = pw.length === ts.length && pw.every((e, i) => ts[i] === e);
        return same ? null : { pw: pw.map(describe), ts: ts.map(describe) };
      });
      if (diff) {
        failures++;
        console.log('\nMISMATCH ' + text);
        console.log('  Playwright (' + diff.pw.length + '):\n    ' + diff.pw.join('\n    '));
        console.log('  Test Studio (' + diff.ts.length + '):\n    ' + diff.ts.join('\n    '));
      }
    }
  } finally {
    await browser.close().catch(() => {});
    electron.kill();
    server.close();
  }
  console.log('\n' + (LOCATORS.length - failures) + ' of ' + LOCATORS.length + ' locators match Playwright.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// Evaluates the engine source in the page and exposes it for this test only.
function ENGINE_LOADER(source) {
  return 'window.__tsEngine = (function () { const module = {}; ' + source + '\n; return module.exports; })();';
}
