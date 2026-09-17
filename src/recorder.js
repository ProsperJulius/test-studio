const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');

let win = null;
let steps = [];
let handlers = { onChange: () => {}, onClose: () => {} };

const uid = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function makeStep(ev) {
  return {
    id: uid(),
    action: ev.action,
    target: ev.name || '',
    recordedTarget: ev.name || '',
    value: ev.value || '',
    secret: !!ev.secret,
    shot: true,
    locators: ev.locators || null
  };
}

ipcMain.on('rec:event', (event, ev) => {
  if (!win || event.sender !== win.webContents) return;
  const last = steps[steps.length - 1];
  const sameField =
    last && last.action === 'Type' && ev.action === 'Type' &&
    JSON.stringify(last.locators) === JSON.stringify(ev.locators);
  if (sameField) {
    last.value = ev.value;
  } else {
    steps.push(makeStep(ev));
  }
  handlers.onChange(steps);
});

function start(url, h) {
  if (win) stop();
  handlers = h;
  steps = [
    {
      id: uid(),
      action: 'Open page',
      target: 'start page',
      recordedTarget: 'start page',
      value: url,
      secret: false,
      shot: true,
      locators: null
    }
  ];

  win = new BrowserWindow({
    width: 1320,
    height: 880,
    title: 'Recording – Test Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'recorder-preload.js'),
      contextIsolation: true,
      partition: 'recorder-' + Date.now()
    }
  });

  win.on('closed', () => {
    win = null;
    handlers.onClose(steps);
  });

  win.loadURL(url).catch(() => { /* navigation errors are shown in the window */ });
  handlers.onChange(steps);
}

function checkMode() {
  if (!win) return;
  win.focus();
  win.webContents.send('rec:check-mode');
}

function undo() {
  if (steps.length) steps.pop();
  handlers.onChange(steps);
  return steps;
}

function stop() {
  const recorded = steps;
  if (win) {
    const w = win;
    win = null;
    w.removeAllListeners('closed');
    w.close();
  }
  return recorded;
}

function isRecording() {
  return !!win;
}

module.exports = { start, stop, undo, checkMode, isRecording };
