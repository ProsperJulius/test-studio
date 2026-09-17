const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const { suggestCapture, capturedNames } = require('./capture');

let win = null;
let steps = [];
let handlers = { onChange: () => {}, onClose: () => {}, onNotice: () => {} };
let notices = [];

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
    locators: ev.locators || null,
    grid: ev.grid || null
  };
}

const sameTarget = (a, b) => JSON.stringify([a.locators, a.grid || null]) === JSON.stringify([b.locators, b.grid || null]);

ipcMain.on('rec:event', (event, ev) => {
  if (!win || event.sender !== win.webContents) return;
  if (ev.action === 'Double-click') {
    for (let k = 0; k < 2; k++) {
      const prev = steps[steps.length - 1];
      if (prev && prev.action === 'Click' && sameTarget(prev, ev)) steps.pop();
    }
  }
  const last = steps[steps.length - 1];
  const sameField = last && last.action === 'Type' && ev.action === 'Type' && sameTarget(last, ev);
  if (sameField) {
    last.value = ev.value;
  } else {
    steps.push(makeStep(ev));
  }
  handlers.onChange(steps);
});

// A notification appeared, or the user clicked text in capture mode (save: true).
ipcMain.on('rec:notice', (event, ev) => {
  if (!win || event.sender !== win.webContents) return;
  const notice = { id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: String(ev.text || ''), afterStep: steps.length, at: new Date().toISOString() };
  notices = notices.concat(notice).slice(-8);
  if (ev.save) addCapture(notice.id);
  else handlers.onNotice(notices);
});

// Adds a "Save value from text" step for a notice, at the point in the recording where it appeared.
function addCapture(noticeId) {
  const notice = notices.find((n) => n.id === noticeId);
  if (!notice) throw new Error('That message is no longer available.');
  const { template, name } = suggestCapture(notice.text, capturedNames(steps));
  const step = makeStep({ action: 'Save value from text', name: '', value: template || notice.text });
  step.target = '';
  step.recordedTarget = '';
  step.shot = false;
  step.shareWithRun = false;
  steps.splice(Math.min(notice.afterStep, steps.length), 0, step);
  notices = notices.filter((n) => n.id !== noticeId);
  handlers.onNotice(notices);
  handlers.onChange(steps);
  return { steps, name };
}

function start(url, h) {
  if (win) stop();
  handlers = { onNotice: () => {}, ...h };
  notices = [];
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

function captureMode() {
  if (!win) return;
  win.focus();
  win.webContents.send('rec:capture-mode');
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

module.exports = { start, stop, undo, checkMode, captureMode, addCapture, isRecording };
