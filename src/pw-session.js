// Connects Playwright to Test Studio's own Electron windows over CDP, so steps are matched
// by Playwright itself rather than by a re-implementation of its rules.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { chromium, selectors } = require('playwright-core');
const { buildLocator } = require('./pw-locator');

// Set on the single element a step is about to act on, so the in-page action code can find it.
const MARK = 'data-ts-target';

let browser = null;
let testIdAttribute = null;

// Chromium writes the port it actually bound to here, because main.js asks for port 0.
async function endpoint(timeoutMs = 15000) {
  const file = path.join(app.getPath('userData'), 'DevToolsActivePort');
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const port = fs.readFileSync(file, 'utf8').split('\n')[0].trim();
      if (port) return 'http://127.0.0.1:' + port;
    } catch (e) { /* not written yet */ }
    if (Date.now() > end) throw new Error('Test Studio could not find its browser debugging port.');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function connect() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.connectOverCDP(await endpoint());
  return browser;
}

function setTestIdAttribute(attr) {
  const a = attr || 'data-testid';
  if (a === testIdAttribute) return;
  selectors.setTestIdAttribute(a);
  testIdAttribute = a;
}

// Electron windows all appear as pages on the default context, so a window is identified by
// stamping it through Electron and looking for that stamp through Playwright. Nothing navigates,
// because the window may already be showing the page under test.
async function pageForWebContents(wc, timeoutMs = 15000) {
  const token = 'ts-' + Math.random().toString(36).slice(2);
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      await wc.executeJavaScript('window.__tsAttach = ' + JSON.stringify(token) + '; true', true);
      for (const ctx of browser.contexts()) {
        for (const p of ctx.pages()) {
          if (p.isClosed()) continue;
          const found = await p.evaluate(() => window.__tsAttach).catch(() => null);
          if (found === token) {
            await p.evaluate(() => { delete window.__tsAttach; }).catch(() => {});
            return p;
          }
        }
      }
    } catch (e) { /* the window is still loading; try again */ }
    if (Date.now() > end) throw new Error('Test Studio could not attach to the browser window.');
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Resolves a step's locator and marks the match for the in-page action code.
// Returns { ok, fatal, reason, done } — done means the step is already decided.
async function markTarget(page, loc, action) {
  let locator;
  try {
    locator = buildLocator(page, loc.ast);
  } catch (e) {
    return { ok: false, fatal: true, reason: loc.source + ' is not supported: ' + e.message };
  }

  let count;
  try {
    count = await locator.count();
  } catch (e) {
    // Navigating or detached: let the caller poll again.
    return { ok: false, reason: 'The page was still loading.' };
  }

  if (action === 'Verify element is hidden') {
    if (!count) return { ok: true, done: true, used: 'locator' };
    const visible = await locator.first().isVisible().catch(() => false);
    return visible
      ? { ok: false, used: 'locator', reason: loc.source + ' is still visible.' }
      : { ok: true, done: true, used: 'locator' };
  }

  if (count > 1) {
    return { ok: false, fatal: true, reason: loc.source + ' matched ' + count + ' elements. Add .first() or .nth(), or make the locator more specific.' };
  }
  if (!count) return { ok: false, reason: 'Could not find ' + loc.source + ' on the page.' };

  const first = locator.first();
  const visible = await first.isVisible().catch(() => false);
  if (!visible) return { ok: false, reason: loc.source + ' was found but is not visible.' };

  try {
    await first.evaluate((el, mark) => {
      document.querySelectorAll('[' + mark + ']').forEach((e) => e.removeAttribute(mark));
      el.setAttribute(mark, '1');
    }, MARK);
  } catch (e) {
    return { ok: false, reason: 'The page changed while finding ' + loc.source + '.' };
  }
  return { ok: true };
}

async function close() {
  if (browser && browser.isConnected()) await browser.close().catch(() => {});
  browser = null;
}

module.exports = { connect, setTestIdAttribute, pageForWebContents, markTarget, close, MARK };
