const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Notification } = require('electron');

const store = require('./src/store');
const recorder = require('./src/recorder');
const runner = require('./src/runner');
const report = require('./src/report');

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

async function startRun(testIds, trigger) {
  if (runner.isRunning()) throw new Error('A run is already in progress. Wait for it to finish or cancel it.');
  if (recorder.isRecording()) throw new Error('Stop recording before running tests.');

  const data = store.get();
  const tests = testIds.map((id) => data.tests.find((t) => t.id === id)).filter(Boolean);
  if (!tests.length) throw new Error('There are no tests to run.');

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
    settings: { ...data.settings },
    tests: []
  };

  runner
    .run({
      run,
      tests,
      blocks: data.blocks,
      variables: data.variables,
      settings: data.settings,
      dir,
      onUpdate: (snapshot, thumb) => send('run:update', { run: snapshot, thumb })
    })
    .then((final) => {
      fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(final, null, 2));
      store.update((d) => {
        d.runs.push({
          id: final.id,
          startedAt: final.startedAt,
          finishedAt: final.finishedAt,
          status: final.status,
          trigger: final.trigger,
          tests: final.tests.map((t) => ({ id: t.id, title: t.title, status: t.status }))
        });
        for (const t of final.tests) {
          const test = d.tests.find((x) => x.id === t.id);
          if (test && t.status !== 'Cancelled') {
            test.lastStatus = t.status;
            test.lastRun = final.finishedAt;
          }
        }
      });
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
      onClose: (steps) => send('recorder:closed', steps)
    });
    return true;
  });
  ipcMain.handle('recorder:check', () => recorder.checkMode());
  ipcMain.handle('recorder:undo', () => recorder.undo());
  ipcMain.handle('recorder:stop', () => recorder.stop());

  // Runs
  ipcMain.handle('run:start', (e, { testIds }) => startRun(testIds, 'Manual'));
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
function startScheduler() {
  setInterval(() => {
    const d = store.get();
    const s = d.schedule;
    if (!s.enabled || runner.isRunning() || recorder.isRecording()) return;
    const now = new Date();
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    const today = now.toLocaleDateString('en-CA');
    if (hhmm !== s.time || !s.days.includes(now.getDay()) || s.lastRunDate === today) return;
    const ids = d.tests.filter((t) => s.scope === 'all' || t.approval === 'Approved').map((t) => t.id);
    store.update((x) => { x.schedule.lastRunDate = today; });
    if (!ids.length) return;
    startRun(ids, 'Schedule')
      .then(() => send('run:scheduled', {}))
      .catch(() => {});
  }, 20000);
}

app.whenReady().then(() => {
  const dataDir = path.join(app.getPath('userData'), 'data');
  runsDir = path.join(dataDir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  store.init(dataDir);
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
