// Tests as a single YAML file, for sharing a few tests or editing them by hand.
// The folder suite in suite.js remains the format for version control and CI.
const yaml = require('js-yaml');
const { cleanSteps, upsert, RUNTIME_TEST_FIELDS } = require('./suite');
const { migrateTest } = require('./store');

const FORMAT = 'test-studio-tests';

// Every block the steps use, including blocks used inside those blocks.
function usedBlocks(steps, blocks, found = new Map()) {
  for (const s of steps || []) {
    if (s.action !== 'Use block' || found.has(s.value)) continue;
    const block = (blocks || []).find((b) => b.id === s.value);
    if (!block) continue;
    found.set(block.id, block);
    usedBlocks(block.steps, blocks, found);
  }
  return found;
}

function exportTests(data, ids) {
  const warnings = [];
  const tests = (data.tests || []).filter((t) => ids.includes(t.id)).map((t) => {
    const copy = { ...t, steps: cleanSteps(t.id, t.steps, warnings) };
    RUNTIME_TEST_FIELDS.forEach((k) => delete copy[k]);
    delete copy.flaky;
    return copy;
  });
  if (!tests.length) throw new Error('There are no tests to export.');
  const found = new Map();
  tests.forEach((t) => usedBlocks(t.steps, data.blocks, found));
  const blocks = Array.from(found.values()).map((b) => ({ ...b, steps: cleanSteps('Block “' + b.name + '”', b.steps, warnings) }));
  const doc = { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), tests, blocks };
  return { text: yaml.dump(doc, { noRefs: true, lineWidth: -1 }), warnings };
}

function checkSteps(where, steps) {
  if (!Array.isArray(steps)) throw new Error(where + ' has no list of steps.');
  steps.forEach((s, i) => {
    if (!s || typeof s !== 'object' || !s.action) throw new Error(where + ' step ' + (i + 1) + ' has no action.');
  });
}

function parseTests(text) {
  let doc;
  try {
    doc = yaml.load(text);
  } catch (e) {
    throw new Error('The file is not valid YAML: ' + e.message.split('\n')[0]);
  }
  if (!doc || typeof doc !== 'object') throw new Error('The file does not contain any tests.');
  // A single test on its own is accepted too.
  const isSingle = !doc.format && doc.id != null && doc.steps;
  if (!isSingle && doc.format !== FORMAT) throw new Error('This is not a Test Studio tests file.');
  const tests = isSingle ? [doc] : doc.tests || [];
  const blocks = isSingle ? [] : doc.blocks || [];
  if (!Array.isArray(tests) || !tests.length) throw new Error('The file does not contain any tests.');
  if (!Array.isArray(blocks)) throw new Error('The blocks in the file are not a list.');

  tests.forEach((t, i) => {
    if (!t || typeof t !== 'object') throw new Error('Test ' + (i + 1) + ' is not a test.');
    if (t.id == null || !String(t.id).trim()) throw new Error('Test ' + (i + 1) + ' has no id.');
    t.id = String(t.id).trim();
    if (!String(t.title || '').trim()) throw new Error(t.id + ' has no title.');
    checkSteps(t.id, t.steps);
    RUNTIME_TEST_FIELDS.forEach((k) => delete t[k]);
    migrateTest(t);
    if (!t.approval) t.approval = 'Not submitted';
  });
  blocks.forEach((b, i) => {
    if (!b || !b.id || !b.name) throw new Error('Block ' + (i + 1) + ' needs an id and a name.');
    checkSteps('Block “' + b.name + '”', b.steps);
  });
  return { tests, blocks };
}

// Tests and blocks with the same ID are replaced. A replaced test keeps its last run and result.
function importTests(target, parsed) {
  upsert(target.tests, parsed.tests, 'id');
  upsert(target.blocks, parsed.blocks, 'id');
  return { tests: parsed.tests.length, blocks: parsed.blocks.length };
}

module.exports = { exportTests, parseTests, importTests };
