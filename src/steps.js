// Pure helpers for preparing steps before they run. No Electron dependencies.
const { parseLocator, mapText, formatLocator, locatorQuality } = require('./locator-parse');

function substitute(value, variables) {
  return String(value == null ? '' : value).replace(/\{(\w+)\}/g, (m, key) => {
    const v = (variables || []).find((x) => x.key === key);
    return v ? String(v.value == null ? '' : v.value) : m;
  });
}

// Names in {curly brackets} that have no matching variable.
function unresolved(value, variables) {
  const missing = [];
  String(value == null ? '' : value).replace(/\{(\w+)\}/g, (m, key) => {
    if (!(variables || []).some((x) => x.key === key)) missing.push(key);
    return m;
  });
  return missing;
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

// Returns how the runner finds a step's element: a parsed Playwright-style locator when the step has one
// (with {name} test data substituted), else the older recorded hints.
function locatorsFor(step, variables, settings) {
  if (step.locator && String(step.locator).trim()) {
    const parsed = parseLocator(step.locator);
    if (!parsed.ok) throw new Error('The locator for this step is not valid: ' + parsed.error);
    const ast = mapText(parsed.ast, (text) => substitute(text, variables || []));
    return { ast, source: formatLocator(ast), quality: locatorQuality(ast), testIdAttribute: (settings && settings.testIdAttribute) || 'data-testid' };
  }
  const target = (step.target || '').trim();
  if (step.locators && target === (step.recordedTarget || '').trim()) return step.locators;
  // The user renamed the target in the editor: find it by what they typed.
  return { label: target, text: target, placeholder: target };
}

module.exports = { substitute, unresolved, expandSteps, locatorsFor };
