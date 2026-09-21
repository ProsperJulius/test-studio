// Pure helpers for preparing steps before they run. No Electron dependencies.
const { parseLocator, mapText, formatLocator, locatorQuality } = require('./locator-parse');

const PLACEHOLDER = /\{(\w+)\}/g;

function substitute(value, variables) {
  return String(value == null ? '' : value).replace(PLACEHOLDER, (m, key) => {
    const v = (variables || []).find((x) => x.key === key);
    return v ? String(v.value == null ? '' : v.value) : m;
  });
}

// Names in {curly brackets} that have no matching variable.
function unresolved(value, variables) {
  const missing = [];
  String(value == null ? '' : value).replace(PLACEHOLDER, (m, key) => {
    if (!(variables || []).some((x) => x.key === key)) missing.push(key);
    return m;
  });
  return missing;
}

const names = (value) => Array.from(String(value == null ? '' : value).matchAll(PLACEHOLDER), (m) => m[1]);

// Every {name} a step reads. The template of a "Save value from text" step is left out, because its
// names are what the step writes. Shared by the runner and by suite validation so they cannot drift.
function stepRefs(step) {
  const out = step.action === 'Save value from text' ? [] : names(step.value);
  out.push(...names(step.target));
  if (step.locator) out.push(...names(step.locator));
  const g = step.grid;
  if (g) {
    if (g.row && g.row.mode !== 'index') out.push(...names(g.row.value));
    if (g.row && g.row.column) out.push(...names(g.row.column.header));
    if (g.column) out.push(...names(g.column.header));
    if (g.grid) out.push(...names(g.grid.label));
  }
  return Array.from(new Set(out));
}

// The {name}s a step reads that have no value yet. Empty means the step is ready to run.
function missingFor(step, variables) {
  return stepRefs(step).filter((key) => !(variables || []).some((x) => x.key === key));
}

function expandSteps(steps, blocks, depth = 0, prefix = '') {
  const out = [];
  for (const step of steps || []) {
    if (step.disabled) continue;
    if (step.action === 'Use block') {
      const block = (blocks || []).find((b) => b.id === step.value);
      if (!block || depth > 5) {
        out.push({ ...step, _missingBlock: true, _prefix: prefix });
      } else {
        out.push(...expandSteps(block.steps, blocks, depth + 1, prefix + block.name + ' › '));
      }
    } else {
      out.push({ ...step, _prefix: prefix });
    }
  }
  return out;
}

// A grid target with {name} test data filled in: the row value or tree path, and the column and
// grid names, so a grid step can be pointed at a column or a grid chosen by test data.
function resolveGrid(grid, variables) {
  if (!grid) return grid;
  const sub = (t) => substitute(t, variables || []);
  const g = { ...grid };
  if (g.column) g.column = { ...g.column, header: sub(g.column.header) };
  if (g.grid) g.grid = { ...g.grid, label: sub(g.grid.label) };
  if (g.row) {
    g.row = { ...g.row };
    if (g.row.mode !== 'index') g.row.value = sub(g.row.value);
    if (g.row.column) g.row.column = { ...g.row.column, header: sub(g.row.column.header) };
  }
  return g;
}

// Returns how the runner finds a step's element: a parsed Playwright-style locator when the step has one
// (with {name} test data substituted), else the older recorded hints (substituted as well).
function locatorsFor(step, variables, settings) {
  const vars = variables || [];
  if (step.locator && String(step.locator).trim()) {
    const parsed = parseLocator(step.locator);
    if (!parsed.ok) throw new Error('The locator for this step is not valid: ' + parsed.error);
    const ast = mapText(parsed.ast, (text) => substitute(text, vars));
    return { ast, source: formatLocator(ast), quality: locatorQuality(ast), testIdAttribute: (settings && settings.testIdAttribute) || 'data-testid' };
  }
  // The target is compared before substitution, so renaming it in the editor is still detected.
  const raw = (step.target || '').trim();
  if (step.locators && raw === (step.recordedTarget || '').trim()) {
    return Object.fromEntries(Object.entries(step.locators).map(([k, v]) => [k, typeof v === 'string' ? substitute(v, vars) : v]));
  }
  // The user renamed the target in the editor: find it by what they typed.
  const target = substitute(raw, vars);
  return { label: target, text: target, placeholder: target };
}

// A copy of the step with every {name} filled in, used for the run view, the reports and the
// evidence document. A hidden value stays hidden and a capture template stays as it was typed.
function resolveStep(step, variables, settings) {
  const vars = variables || [];
  const out = { ...step };
  if (!step.secret && step.action !== 'Save value from text') out.value = substitute(step.value, vars);
  if (step.target) out.target = substitute(step.target, vars);
  if (step.grid) out.grid = resolveGrid(step.grid, vars);
  if (step.locator) {
    try {
      out.locator = locatorsFor(step, vars, settings).source;
    } catch (e) { /* an invalid locator is reported when the step runs */ }
  }
  return out;
}

module.exports = { substitute, unresolved, stepRefs, missingFor, expandSteps, resolveGrid, locatorsFor, resolveStep };
