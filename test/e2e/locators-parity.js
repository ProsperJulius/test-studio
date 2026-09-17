// Checks that Test Studio's locator engine matches the same elements as Playwright.
// Starts Electron with remote debugging, loads the fixture page, and connects Playwright to it.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { start } = require('../fixture/server');
const { parseLocator } = require('../../src/locator-parse');

const ENGINE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'locator-engine.js'), 'utf8');

const LOCATORS = [
  // roles and names
  "getByRole('link')", "getByRole('link', { name: 'Orders' })", "getByRole('link', { name: 'orders', exact: true })",
  "getByRole('button')", "getByRole('button', { name: 'Save' })", "getByRole('button', { name: 'Save profile' })",
  "getByRole('button', { name: 'Submit' })", "getByRole('button', { name: 'Reset' })",
  "getByRole('button', { name: 'Close' })", "getByRole('button', { name: 'Preferences' })", "getByRole('button', { name: 'Settings icon Preferences' })",
  "getByRole('button', { name: 'Before text' })", "getByRole('button', { name: 'More options' })", "getByRole('button', { name: /edit/i })",
  "getByRole('button', { name: 'Div button' })", "getByRole('button', { disabled: true })", "getByRole('button', { pressed: true })",
  "getByRole('button', { expanded: false })", "getByRole('button', { includeHidden: true })",
  "getByRole('textbox')", "getByRole('textbox', { name: 'First name' })", "getByRole('textbox', { name: 'Last name' })",
  "getByRole('textbox', { name: 'Middle name' })", "getByRole('textbox', { name: 'Email address' })", "getByRole('textbox', { name: 'Password' })",
  "getByRole('textbox', { name: 'Tell us about yourself' })", "getByRole('searchbox')", "getByRole('spinbutton')", "getByRole('slider')",
  "getByRole('combobox', { name: 'Country' })", "getByRole('checkbox')", "getByRole('checkbox', { checked: true })",
  "getByRole('checkbox', { name: 'Subscribe to updates' })", "getByRole('radio', { name: 'Pro plan', checked: true })",
  "getByRole('heading')", "getByRole('heading', { level: 2 })", "getByRole('heading', { name: 'Custom heading', level: 4 })",
  "getByRole('dialog')", "getByRole('dialog', { name: 'Edit order' })", "getByRole('dialog', { name: 'Confirm delete' })",
  "getByRole('dialog', { name: 'Edit order' }).getByRole('button', { name: 'Cancel' })",
  "getByRole('row')", "getByRole('row', { name: 'Order 1001' })", "getByRole('row', { name: 'Order 1002', exact: false }).getByRole('button')",
  "getByRole('cell')", "getByRole('columnheader')", "getByRole('rowheader')", "getByRole('table', { name: 'Order history' })",
  "getByRole('listitem').filter({ hasText: 'Pears' }).getByRole('button', { name: 'Remove' })",
  "getByRole('navigation', { name: 'Main' })", "getByRole('main')", "getByRole('banner')", "getByRole('contentinfo')",
  "getByRole('region')", "getByRole('region', { name: 'Orders' })", "getByRole('form')", "getByRole('form', { name: 'Profile' })",
  "getByRole('tab', { selected: true })", "getByRole('tablist').getByRole('tab')", "getByRole('switch', { checked: true })",
  "getByRole('checkbox', { checked: 'mixed' })", "getByRole('img')", "getByRole('img', { name: 'Company logo' })", "getByRole('presentation')",
  "getByRole('group')", "getByRole('group', { name: 'Billing' })", "getByRole('list')", "getByRole('paragraph')", "getByRole('status')",
  "getByRole('progressbar', { name: 'Upload progress' })", "getByRole('link', { name: 'Go to top' })", "getByRole('strong')",
  // text
  "getByText('Order 1001')", "getByText('Order 1002')", "getByText('Order 1002', { exact: true })", "getByText('order')",
  "getByText('Welcome back')", "getByText('Welcome back, Jane!')", "getByText('Contact support team')", "getByText(/support\\s+team/)",
  "getByText('Nested text')", "getByText('Hidden button')", "getByText('Save profile')", "getByText('Edit')", "getByText('Remove')",
  "getByText('Apples')", "getByText('More info')", "getByText(/^Pro/)",
  // labels, placeholders, alt, title, test ids
  "getByLabel('First name')", "getByLabel('First name *', { exact: true })", "getByLabel('Last name')", "getByLabel('Middle name')",
  "getByLabel('Email')", "getByLabel('Country')", "getByLabel('Subscribe')", "getByLabel('Pro plan')", "getByLabel('Card number')",
  "getByLabel('Quantity')", "getByLabel(/plan/)", "getByLabel('Profile')",
  "getByPlaceholder('Jane')", "getByPlaceholder('jane', { exact: true })", "getByPlaceholder('e')", "getByPlaceholder(/^Search/)",
  "getByAltText('logo')", "getByAltText('Company logo', { exact: true })", "getByTitle('Help')", "getByTitle('Password')",
  "getByTestId('save-draft')", "getByTestId('save')", "locator('[data-qa=\"discard\"]')",
  // css, xpath, chains, positions, filters
  "locator('button')", "locator('form input')", "locator('#first')", "locator('xpath=//li')",
  "getByRole('button').first()", "getByRole('button').last()", "getByRole('button').nth(3)", "getByRole('button').nth(-2)",
  "getByRole('row').filter({ hasText: 'Pending' })", "getByRole('row').filter({ hasNotText: 'Order' })", "getByRole('button').filter({ visible: true })",
  "getByRole('listitem').filter({ hasText: /apples/i })", "locator('section').getByText('strong')", "getByRole('dialog').getByRole('button').nth(1)"
];

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
