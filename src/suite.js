// A suite folder holds tests as individual JSON files so they can be kept in version control
// and run from the command line in CI.
//
//   suite.json                  application name, timeouts, retries, default environment
//   tests/<test id>.json
//   blocks/<block id>.json
//   environments/<name>.json    base address and test data overrides
//   data/variables.json         default test data
//
// Secret values are never written. Supply them in CI as TS_VAR_<name> environment variables.
const fs = require('fs');
const path = require('path');
const { migrate, defaults } = require('./store');

const FORMAT = 'test-studio-suite';
const RUNTIME_TEST_FIELDS = ['lastStatus', 'lastRun'];

const slug = (s) => String(s).trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error('Could not read ' + file + ': ' + e.message);
  }
}

function readDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => readJson(path.join(dir, f)));
}

// Replaces the JSON files in a managed sub-folder so deleted items disappear from the suite.
function replaceDir(dir, items, nameOf) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) fs.rmSync(path.join(dir, f));
  const used = new Set();
  for (const item of items) {
    let name = slug(nameOf(item));
    while (used.has(name.toLowerCase())) name += '_';
    used.add(name.toLowerCase());
    writeJson(path.join(dir, name + '.json'), item.value);
  }
}

// Returns a list of warnings (for example, hidden step values that were left out).
function exportSuite(data, dir) {
  const manifestFile = path.join(dir, 'suite.json');
  const hasOtherFiles = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => !f.startsWith('.'));
  if (hasOtherFiles && !(fs.existsSync(manifestFile) && readJson(manifestFile).format === FORMAT)) {
    throw new Error('Choose an empty folder or an existing Test Studio suite folder. ' + dir + ' already contains other files.');
  }
  const warnings = [];
  const blankVars = (list) => (list || []).map((v) => (v.secret ? { ...v, value: '' } : v));
  const cleanSteps = (owner, steps) => (steps || []).map((s, i) => {
    if (s.secret && s.value && !/^\{\w+\}$/.test(String(s.value).trim())) {
      warnings.push(owner + ' step ' + (i + 1) + ' has a hidden value that was not exported. Use a {variable} from Test data instead.');
      return { ...s, value: '' };
    }
    return s;
  });

  const s = data.settings || {};
  writeJson(path.join(dir, 'suite.json'), {
    format: FORMAT,
    version: 1,
    settings: { appName: s.appName || '', stepTimeout: s.stepTimeout, retries: s.retries || 0, activeEnvironment: s.activeEnvironment, testIdAttribute: s.testIdAttribute || 'data-testid' }
  });
  replaceDir(path.join(dir, 'tests'), (data.tests || []).map((t) => {
    const copy = { ...t, steps: cleanSteps(t.id, t.steps) };
    RUNTIME_TEST_FIELDS.forEach((k) => delete copy[k]);
    return { value: copy, id: t.id };
  }), (x) => x.id);
  replaceDir(path.join(dir, 'blocks'), (data.blocks || []).map((b) => ({ value: { ...b, steps: cleanSteps('Block “' + b.name + '”', b.steps) }, id: b.id })), (x) => x.id);
  replaceDir(path.join(dir, 'environments'), (data.environments || []).map((e) => ({ value: { ...e, variables: blankVars(e.variables) }, id: e.name })), (x) => x.id);
  writeJson(path.join(dir, 'data', 'variables.json'), blankVars(data.variables));
  return warnings;
}

function loadSuite(dir) {
  const manifestFile = path.join(dir, 'suite.json');
  if (!fs.existsSync(manifestFile)) throw new Error('No suite.json found in ' + dir + '. Export a suite from Test Studio Settings first.');
  const manifest = readJson(manifestFile);
  if (manifest.format !== FORMAT) throw new Error(manifestFile + ' is not a Test Studio suite.');

  const base = defaults();
  const variablesFile = path.join(dir, 'data', 'variables.json');
  const data = {
    ...base,
    tests: readDir(path.join(dir, 'tests')),
    blocks: readDir(path.join(dir, 'blocks')),
    environments: readDir(path.join(dir, 'environments')),
    variables: fs.existsSync(variablesFile) ? readJson(variablesFile) : [],
    settings: { ...base.settings, ...(manifest.settings || {}) },
    runs: []
  };
  return migrate(data);
}

// Merges a suite into the studio data. Tests and blocks with the same ID are replaced.
// Secret values already on this computer are kept when the suite has them blank.
function importSuite(target, dir) {
  const suite = loadSuite(dir);
  const upsert = (list, items, key) => {
    for (const item of items) {
      const i = list.findIndex((x) => x[key] === item[key]);
      if (i >= 0) {
        const keepRuntime = {};
        RUNTIME_TEST_FIELDS.forEach((k) => { if (list[i][k] !== undefined) keepRuntime[k] = list[i][k]; });
        list[i] = { ...item, ...keepRuntime };
      } else list.push(item);
    }
  };
  const mergeVars = (existing, incoming) => incoming.map((v) => {
    const old = (existing || []).find((x) => x.key === v.key);
    return v.secret && !v.value && old ? { ...v, value: old.value } : v;
  }).concat((existing || []).filter((x) => !incoming.some((v) => v.key === x.key)));

  upsert(target.tests, suite.tests, 'id');
  upsert(target.blocks, suite.blocks, 'id');
  for (const env of suite.environments) {
    const old = target.environments.find((e) => e.name === env.name);
    if (old) Object.assign(old, env, { variables: mergeVars(old.variables, env.variables || []) });
    else target.environments.push(env);
  }
  target.variables = mergeVars(target.variables, suite.variables);
  if (suite.settings.appName && !target.settings.appName) target.settings.appName = suite.settings.appName;
  return { tests: suite.tests.length, blocks: suite.blocks.length, environments: suite.environments.length };
}

module.exports = { exportSuite, loadSuite, importSuite };
