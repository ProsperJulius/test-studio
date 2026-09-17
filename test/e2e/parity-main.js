// Electron entry used by locators-parity.js: opens the page and waits for Playwright to connect.
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900, show: false });
  await win.loadURL(process.argv[process.argv.length - 1]);
  process.stdout.write('READY\n');
});
