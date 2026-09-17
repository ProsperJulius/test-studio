const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Notification } = require('electron');

const store = require('./src/store');
const recorder = require('./src/recorder');
const runner = require('./src/runner');
const report = require('./src/report');
const reporters = require('./src/reporters');
const suite = require('./src/suite');
const cli = require('./src/cli');
const { selectTests } = require('./src/select');
const { resolveEnvironment } = require('./src/environments');
const { validateSuite } = require('./src/validate');

const CLI_INDEX = process.argv.indexOf('--ts-cli');

let studio = null;
let runsDir = null;

function send(channel, payload) {
  if (studio && !studio.isDestroyed()) studio.webContents.send(channel, payload);
}

function createWindow() {
  studio = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: 'Test Studio',
    backgroundColor: '#F4F2EC',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  studio.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  studio.on('closed', () => { studio = null; });
}

// ---------- Runs ----------
function loadRun(id) {
  const file = path.join(runsDir, id, 'run.json');
  if (!fs.existsSync(file)) throw new Error('This run could not be found on disk.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function safeRunId(id) {
  if (!/^[\w-]+$/.test(String(id))) throw new Error('Invalid run id.');
  return id;
}

// Saves a finished run to history and updates each test's last result.
function recordRun(final) {
  store.update((d) => {
    d.runs.push({
      id: final.id,
      startedAt: final.startedAt,
      finishedAt: final.finishedAt,
      status: final.status,
      trigger: final.trigger,
      environment: (final.settings || {}).environment || '',
      tests: final.tests.map((t) => ({ id: t.id, title: t.title, status: t.status, flaky: !!t.flaky, change: t.change || null }))
    });
    for (const t of final.tests) {
      const test = d.tests.find((x) => x.id === t.id);
      if (test && t.status !== 'Cancelled') {
        test.lastStatus = t.status;
        test.lastRun = final.finishedAt;
        test.flaky = !!t.flaky;
      }
    }
  });
}

async function startRun(testIds, trigger, environmentName) {
  if (runner.isRunning()) throw new Error('A run is already in progress. Wait for it to finish or cancel it.');
  if (recorder.isRecording()) throw new Error('Stop recording before running tests.');

  const data = store.get();
  const tests = testIds.map((id) => data.tests.find((t) => t.id === id)).filter(Boolean);
  if (!tests.length) throw new Error('There are no tests to run.');
  const resolved = resolveEnvironment(data, environmentName || undefined);

  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(runsDir, id);
  fs.mkdirSync(dir, { recursive: true });

  const run = {
    id,
    trigger: trigger || 'Manual',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'Running',
    executedBy: os.userInfo().username,
    settings: { ...resolved.settings },
    tests: []
  };
  const previous = Object.fromEntries(data.tests.map((t) => [t.id, t.lastStatus]));

  runner
    .run({
      run,
      tests,
      blocks: data.blocks,
      variables: resolved.variables,
      settings: resolved.settings,
      dir,
      onUpdate: (snapshot, thumb) => send('run:update', { run: snapshot, thumb })
    })
    .then((final) => {
      reporters.compareWithPrevious(final, previous);
      fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(final, null, 2));
      fs.writeFileSync(path.join(dir, 'junit.xml'), reporters.toJUnit(final));
      fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(reporters.toJson(final), null, 2));
      fs.writeFileSync(path.join(dir, 'report.html'), reporters.toHtml(final));
      recordRun(final);
      send('run:finished', final);
      if (Notification.isSupported() && (!studio || !studio.isFocused())) {
        new Notification({ title: 'Test run ' + final.status.toLowerCase(), body: final.tests.length + ' test(s) finished in Test Studio.' }).show();
      }
    })
    .catch((e) => {
      send('run:error', { message: e.message });
    });

  return id;
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('data:get', () => store.get());

  ipcMain.handle('test:save', (e, test) => {
    store.update((d) => {
      test.updatedAt = new Date().toISOString();
      const i = d.tests.findIndex((t) => t.id === test.id);
      if (i >= 0) d.tests[i] = test;
      else d.tests.push(test);
    });
    return store.get();
  });

  ipcMain.handle('test:delete', (e, id) => {
    store.update((d) => { d.tests = d.tests.filter((t) => t.id !== id); });
    return store.get();
  });

  ipcMain.handle('block:save', (e, block) => {
    store.update((d) => {
      const i = d.blocks.findIndex((b) => b.id === block.id);
      if (i >= 0) d.blocks[i] = block;
      else d.blocks.push(block);
    });
    return store.get();
  });

  ipcMain.handle('block:delete', (e, id) => {
    store.update((d) => { d.blocks = d.blocks.filter((b) => b.id !== id); });
    return store.get();
  });

  ipcMain.handle('variables:save', (e, list) => {
    store.update((d) => { d.variables = list.filter((v) => v.key); });
    return store.get();
  });

  ipcMain.handle('environments:save', (e, list) => {
    const names = new Set();
    for (const env of list) {
      env.name = String(env.name || '').trim();
      if (!env.name) throw new Error('Every environment needs a name.');
      if (names.has(env.name.toLowerCase())) throw new Error('There are two environments called “' + env.name + '”.');
      names.add(env.name.toLowerCase());
      env.variables = (env.variables || []).filter((v) => v.key);
    }
    if (!list.length) throw new Error('Keep at least one environment.');
    store.update((d) => {
      d.environments = list;
      if (!list.some((x) => x.name === d.settings.activeEnvironment)) d.settings.activeEnvironment = list[0].name;
    });
    return store.get();
  });

  ipcMain.handle('suite:validate', () => {
    const d = store.get();
    return validateSuite(d, resolveEnvironment(d).variables);
  });

  ipcMain.handle('suite:export', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(studio, {
      title: 'Choose a folder for the test suite',
      buttonLabel: 'Export here',
      properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || !filePaths[0]) return null;
    const warnings = suite.exportSuite(store.get(), filePaths[0]);
    return { dir: filePaths[0], warnings };
  });

  ipcMain.handle('suite:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(studio, {
      title: 'Choose a Test Studio suite folder',
      buttonLabel: 'Import',
      properties: ['openDirectory']
    });
    if (canceled || !filePaths[0]) return null;
    let counts;
    store.update((d) => { counts = suite.importSuite(d, filePaths[0]); });
    return { data: store.get(), counts };
  });

  ipcMain.handle('settings:save', (e, settings) => {
    store.update((d) => { d.settings = { ...d.settings, ...settings }; });
    return store.get();
  });

  ipcMain.handle('schedule:save', (e, schedule) => {
    store.update((d) => { d.schedule = { ...d.schedule, ...schedule }; });
    return store.get();
  });

  // Recorder
  ipcMain.handle('recorder:start', (e, { url }) => {
    if (runner.isRunning()) throw new Error('Wait for the current run to finish before recording.');
    let parsed;
    try { parsed = new URL(url); } catch (err) { throw new Error('Enter a full address, for example https://myapp.company.com/login'); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('The start page must begin with http:// or https://');
    recorder.start(parsed.toString(), {
      onChange: (steps) => send('recorder:steps', steps),
      onClose: (steps) => send('recorder:closed', steps),
      onNotice: (notices) => send('recorder:notices', notices)
    }, { testIdAttribute: store.get().settings.testIdAttribute });
    return true;
  });
  ipcMain.handle('recorder:check', () => recorder.checkMode());
  ipcMain.handle('recorder:capture', () => recorder.captureMode());
  ipcMain.handle('recorder:highlight', (e, locator) => recorder.highlight(String(locator || '')));
  ipcMain.handle('recorder:save-notice', (e, id) => recorder.addCapture(String(id)));
  ipcMain.handle('recorder:undo', () => recorder.undo());
  ipcMain.handle('recorder:stop', () => recorder.stop());

  // Runs
  ipcMain.handle('run:start', (e, { testIds, environment }) => startRun(testIds, 'Manual', environment));
  ipcMain.handle('run:cancel', () => runner.cancel());

  ipcMain.handle('runs:get', (e, id) => {
    const run = loadRun(safeRunId(id));
    const thumbs = {};
    run.tests.forEach((t, ti) =>
      t.steps.forEach((s, si) => {
        if (!s.screenshot) return;
        const img = nativeImage.createFromPath(path.join(runsDir, id, s.screenshot));
        if (!img.isEmpty()) thumbs[ti + '-' + si] = img.resize({ width: 320 }).toDataURL();
      })
    );
    return { run, thumbs };
  });

  ipcMain.handle('runs:image', (e, { runId, file }) => {
    const img = nativeImage.createFromPath(path.join(runsDir, safeRunId(runId), path.basename(file)));
    return img.isEmpty() ? null : img.toDataURL();
  });

  ipcMain.handle('runs:folder', (e, id) => shell.openPath(path.join(runsDir, safeRunId(id))));

  ipcMain.handle('runs:html', async (e, id) => {
    const dir = path.join(runsDir, safeRunId(id));
    const file = path.join(dir, 'report.html');
    if (!fs.existsSync(file)) fs.writeFileSync(file, reporters.toHtml(loadRun(id)));
    const problem = await shell.openPath(file);
    if (problem) throw new Error(problem);
    return true;
  });

  ipcMain.handle('runs:delete', (e, id) => {
    safeRunId(id);
    fs.rmSync(path.join(runsDir, id), { recursive: true, force: true });
    store.update((d) => { d.runs = d.runs.filter((r) => r.id !== id); });
    return store.get();
  });

  ipcMain.handle('report:export', async (e, id) => {
    const run = loadRun(safeRunId(id));
    const name = (run.tests.length === 1 ? run.tests[0].id + '-' : 'regression-') + 'evidence-' + id.slice(0, 16) + '.docx';
    const { canceled, filePath } = await dialog.showSaveDialog(studio, {
      title: 'Save evidence document',
      defaultPath: path.join(app.getPath('documents'), name),
      filters: [{ name: 'Word document', extensions: ['docx'] }]
    });
    if (canceled || !filePath) return null;
    await report.build(run, path.join(runsDir, id), filePath);
    shell.showItemInFolder(filePath);
    return filePath;
  });
}

// ---------- Schedule ----------
// Starts the scheduled run once per day, any time within an hour after the set time,
// so a run in progress at that minute does not cause the day to be skipped.
const SCHEDULE_WINDOW_MINUTES = 60;

function startScheduler() {
  setInterval(() => {
    const d = store.get();
    const s = d.schedule;
    if (!s.enabled || runner.isRunning() || recorder.isRecording()) return;
    const now = new Date();
    const today = now.toLocaleDateString('en-CA');
    const [h, m] = String(s.time || '07:00').split(':').map(Number);
    const minutesLate = now.getHours() * 60 + now.getMinutes() - (h * 60 + m);
    if (minutesLate < 0 || minutesLate >= SCHEDULE_WINDOW_MINUTES || !s.days.includes(now.getDay()) || s.lastRunDate === today) return;
    const ids = selectTests(d.tests, {
      approvedOnly: s.scope !== 'all',
      tags: s.scope === 'tag' ? s.tag : undefined
    }).map((t) => t.id);
    store.update((x) => { x.schedule.lastRunDate = today; });
    if (!ids.length) return;
    startRun(ids, 'Schedule', s.environment || undefined)
      .then(() => send('run:scheduled', {}))
      .catch((e) => send('run:error', { message: e.message }));
  }, 20000);
}

function initData() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  runsDir = path.join(dataDir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  store.init(dataDir);
}

if (CLI_INDEX >= 0) {
  // Headless mode: `test-studio run ...`. Windows open and close between tests, so do not quit when none are open.
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    if (app.dock) app.dock.hide();
    let code = 2;
    try {
      const argv = process.argv.slice(CLI_INDEX + 1);
      const needsStore = !argv.some((a) => a === '--suite' || a.startsWith('--suite='));
      if (needsStore) initData();
      code = await cli.main(argv, { store, runner, report, runsDir, recordRun });
    } catch (e) {
      process.stderr.write((e && e.stack) || String(e));
      process.stderr.write('\n');
    }
    app.exit(code);
  });
} else {
  app.whenReady().then(() => {
    initData();
    registerIpc();
    createWindow();
    startScheduler();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
