// Checks a suite for problems before it runs.
const { ACTIONS, metaFor } = require('./describe');
const { templateToRegex, namesIn, capturedNames } = require('./capture');
const { parseLocator, locatorQuality } = require('./locator-parse');

const refs = (value) => Array.from(String(value == null ? '' : value).matchAll(/\{(\w+)\}/g), (m) => m[1]);

// Every {name} a step reads: its value (except a capture template) and a grid row value.
function stepRefs(s) {
  const out = s.action === 'Save value from text' ? [] : refs(s.value);
  if (s.locator) out.push(...refs(s.locator));
  if (s.grid && s.grid.row && s.grid.row.mode !== 'index') out.push(...refs(s.grid.row.value));
  return out;
}

// options.allTests: the whole suite when data.tests is only the tests selected to run, so values
// saved by tests that were left out are reported as such rather than as unknown test data.
function validateSuite(data, variables, options = {}) {
  const problems = [];
  const add = (level, where, message) => problems.push({ level, where, message });
  const blocks = data.blocks || [];
  const vars = variables || data.variables || [];
  const tests = data.tests || [];

  const allCaptured = new Set([...(options.allTests || tests).flatMap((t) => capturedNames(t.steps, blocks)), ...blocks.flatMap((b) => capturedNames(b.steps, blocks))]);

  const emptySecrets = new Set();
  const seen = new Set();
  for (const t of tests) {
    if (seen.has(t.id)) add('error', t.id, 'Duplicate test ID.');
    seen.add(t.id);
  }

  // Checks the shape of each step. Test data references are checked per test, in run order.
  const checkSteps = (where, steps, isTest) => {
    let verifies = 0;
    (steps || []).forEach((s, i) => {
      if (s.disabled) return;
      const at = where + ' step ' + (i + 1);
      const meta = metaFor(s.action);
      if (!ACTIONS.includes(s.action)) { add('error', at, 'Unknown action “' + s.action + '”.'); return; }
      if (s.action === 'Use block') {
        const block = blocks.find((b) => b.id === s.value);
        if (!block) add('error', at, 'Uses a reusable block that does not exist.');
        else if (block.steps.some((x) => metaFor(x.action).verify || metaFor(x.action).capture)) verifies++;
        return;
      }
      if (meta.verify || meta.capture) verifies++;

      if (s.grid && meta.grid) {
        const g = s.grid;
        // Checking that a row is not in the grid needs only the row, not a column.
        if (s.action === 'Verify element is hidden' && (g.part || 'cell') !== 'cell') add('error', at, 'Only a row can be checked as not in the grid. Set the grid part to Cell.');
        // Expanding and selecting act on the row, so they need no column.
        const expands = ['expand', 'collapse', 'select', 'deselect'].includes(g.inner);
        if (s.action !== 'Verify element is hidden' && !expands && (!g.column || !(g.column.colId || g.column.header))) add('error', at, 'The grid column is not set.');
        if ((g.part || 'cell') === 'cell') {
          const r = g.row || {};
          if (r.mode === 'index') {
            if (!(Number(r.index) >= 0)) add('error', at, 'The grid row number is not set.');
          } else if (r.mode === 'path') {
            if (!String(r.value || '').trim()) add('error', at, 'Say which tree row to use, for example Documents › Work › Report.pdf.');
          } else if (!r.column || !(r.column.colId || r.column.header) || !String(r.value || '').trim()) {
            add('error', at, 'Say which grid row to use: a column and the value to look for.');
          }
        }
      } else if (s.locator && String(s.locator).trim() && meta.target && s.action !== 'Open page') {
        const parsed = parseLocator(s.locator);
        if (!parsed.ok) add('error', at, 'The locator is not valid: ' + parsed.error);
        else {
          const quality = locatorQuality(parsed.ast);
          if (quality === 'nth') add('warning', at, s.locator + ' depends on the element’s position (.nth, .first or .last). Prefer a role, label or test ID.');
          else if (quality === 'css-path') add('warning', at, s.locator + ' depends on the page structure. Prefer a role, label or test ID.');
          if (s.locatorNote) add('warning', at, s.locatorNote);
        }
      } else if (meta.target && !meta.optionalTarget && s.action !== 'Open page' && s.action !== 'Take screenshot' && !String(s.target || '').trim()) {
        add('error', at, 'No field, button or element is named.');
      } else if (meta.target && s.action !== 'Open page' && s.action !== 'Take screenshot' && !s.grid && String(s.target || '').trim()) {
        add('info', at, 'Uses an older recorded target. Open the step and click “Convert to locator” to use a Playwright-style locator.');
      }

      if (meta.capture) {
        try { templateToRegex(s.value); } catch (e) { add('error', at, e.message); }
      } else if (meta.value && s.action !== 'Wait' && s.action !== 'Open page' && !String(s.value || '').trim()) {
        add(meta.verify ? 'error' : 'warning', at, 'No value is set.');
      }
      if (s.action === 'Open page' && !String(s.value || '').trim()) add('error', at, 'No page address is set.');

      for (const key of stepRefs(s)) {
        const v = vars.find((x) => x.key === key);
        if (v && v.secret && !v.value && !emptySecrets.has(key)) {
          emptySecrets.add(key);
          add('warning', at, 'Secret {' + key + '} has no value. On a CI server, set the TS_VAR_' + key + ' environment variable.');
        }
      }
      if (!s.grid && !s.locator && s.locators && !s.locators.testId && !s.locators.id && !s.locators.label && !s.locators.placeholder && !s.locators.name && String(s.target || '') === String(s.recordedTarget || '')) {
        add('warning', at, '“' + (s.target || 'element') + '” can only be found by its position or text. Ask developers for a test ID.');
      }
    });
    if (isTest && !verifies) add('warning', where, 'Has no checks, so it can only fail if a step cannot be completed.');
  };

  // Walks a test's steps in run order (blocks expanded) and reports test data used before it exists.
  const defined = new Set(vars.map((v) => v.key));
  const shared = new Set();
  const checkReferences = (where, steps, available, sharedOut, depth = 0) => {
    (steps || []).forEach((s, i) => {
      if (s.disabled) return;
      const at = where + ' step ' + (i + 1);
      if (s.action === 'Use block') {
        const block = blocks.find((b) => b.id === s.value);
        if (block && depth < 5) checkReferences(at + ' (block “' + block.name + '”)', block.steps, available, sharedOut, depth + 1);
        return;
      }
      const missing = Array.from(new Set(stepRefs(s).filter((k) => !available.has(k))));
      const early = missing.filter((k) => allCaptured.has(k));
      const unknown = missing.filter((k) => !allCaptured.has(k));
      if (early.length) add('error', at, early.map((k) => '{' + k + '}').join(', ') + ' is used before a “Save value from text” step saves it. If another test saves it, run that test first and tick “Share with later tests”.');
      if (unknown.length) add('error', at, 'Test data not found: ' + unknown.map((k) => '{' + k + '}').join(', ') + '.');
      if (s.action === 'Save value from text') {
        for (const name of safeNames(s.value)) {
          available.add(name);
          if (s.shareWithRun) sharedOut.add(name);
        }
      }
    });
  };

  for (const b of blocks) checkSteps('Block “' + b.name + '”', b.steps, false);
  for (const t of tests) {
    if (!(t.steps || []).length) { add('error', t.id, 'Has no steps.'); continue; }
    if (t.steps.every((s) => s.disabled)) { add('error', t.id, 'All steps are disabled.'); continue; }
    checkSteps(t.id, t.steps, true);
    checkReferences(t.id, t.steps, new Set([...defined, ...shared]), shared);
  }
  return problems;
}

function safeNames(template) {
  try { return namesIn(template); } catch (e) { return []; }
}

module.exports = { validateSuite };
