const fs = require('fs');
const path = require('path');
const secrets = require('./secrets');

const SCHEMA = 2;

let file = null;
let data = null;

function defaults() {
  return {
    schema: SCHEMA,
    tests: [],
    blocks: [],
    variables: [{ key: 'username', value: '', secret: false }],
    environments: [{ name: 'QA', baseUrl: '', variables: [] }],
    settings: {
      appName: '',
      activeEnvironment: 'QA',
      buildVersion: '',
      showRunWindow: true,
      stepTimeout: 10,
      retries: 0,
      testIdAttribute: 'data-testid'
    },
    schedule: {
      enabled: false,
      time: '07:00',
      days: [1, 2, 3, 4, 5],
      scope: 'approved',
      tag: '',
      environment: '',
      lastRunDate: null
    },
    runs: []
  };
}

// Fills in test fields added after the first version.
function migrateTest(t) {
  if (!Array.isArray(t.tags)) t.tags = [];
  if (!t.priority) t.priority = 'P2';
  if (t.requirement == null) t.requirement = '';
  return t;
}

// Brings data saved by older versions up to the current shape.
function migrate(d) {
  const settings = d.settings || {};
  if (!Array.isArray(d.environments) || !d.environments.length) {
    const name = settings.environment || 'QA';
    d.environments = [{ name, baseUrl: settings.baseUrl || '', variables: [] }];
    settings.activeEnvironment = name;
  }
  delete settings.environment;
  delete settings.baseUrl;
  if (!d.environments.some((e) => e.name === settings.activeEnvironment)) settings.activeEnvironment = d.environments[0].name;
  (d.tests || []).forEach(migrateTest);
  d.schema = SCHEMA;
  return d;
}

function init(dir) {
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'studio.json');
  const base = defaults();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    data = base;
    save();
    return;
  }

  let loaded;
  try {
    loaded = JSON.parse(raw);
  } catch (e) {
    // Keep the unreadable file rather than silently replacing the user's tests.
    fs.copyFileSync(file, file + '.corrupt-' + Date.now());
    data = base;
    save();
    return;
  }

  if ((loaded.schema || 1) < SCHEMA) {
    fs.copyFileSync(file, path.join(dir, 'studio.backup-schema' + (loaded.schema || 1) + '.json'));
  }
  data = Object.assign(base, loaded);
  data.settings = Object.assign(defaults().settings, loaded.settings || {});
  data.schedule = Object.assign(defaults().schedule, loaded.schedule || {});
  data = secrets.mapSecrets(migrate(data), secrets.decrypt);
  save();
}

function get() {
  return data;
}

function save() {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(secrets.mapSecrets(data, secrets.encrypt), null, 2));
  fs.renameSync(tmp, file);
}

function update(fn) {
  fn(data);
  save();
  return data;
}

module.exports = { init, get, update, migrate, migrateTest, defaults };
