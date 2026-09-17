const fs = require('fs');
const path = require('path');

let file = null;
let data = null;

function defaults() {
  return {
    tests: [],
    blocks: [],
    variables: [{ key: 'username', value: '' }],
    settings: {
      appName: '',
      environment: 'QA',
      buildVersion: '',
      baseUrl: '',
      showRunWindow: true,
      stepTimeout: 10
    },
    schedule: {
      enabled: false,
      time: '07:00',
      days: [1, 2, 3, 4, 5],
      scope: 'approved',
      lastRunDate: null
    },
    runs: []
  };
}

function init(dir) {
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'studio.json');
  const base = defaults();
  try {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = Object.assign(base, loaded);
    data.settings = Object.assign(defaults().settings, loaded.settings || {});
    data.schedule = Object.assign(defaults().schedule, loaded.schedule || {});
  } catch (e) {
    data = base;
    save();
  }
}

function get() {
  return data;
}

function save() {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function update(fn) {
  fn(data);
  save();
  return data;
}

module.exports = { init, get, update };
