const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'data:get', 'test:save', 'test:delete', 'block:save', 'block:delete',
  'variables:save', 'settings:save', 'schedule:save',
  'recorder:start', 'recorder:check', 'recorder:undo', 'recorder:stop',
  'run:start', 'run:cancel', 'runs:get', 'runs:image', 'runs:folder', 'runs:delete', 'report:export'
]);

const EVENTS = new Set([
  'recorder:steps', 'recorder:closed', 'run:update', 'run:finished', 'run:error', 'run:scheduled'
]);

contextBridge.exposeInMainWorld('studio', {
  invoke: (channel, ...args) => {
    if (!INVOKE.has(channel)) return Promise.reject(new Error('Blocked channel ' + channel));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, fn) => {
    if (!EVENTS.has(channel)) return () => {};
    const handler = (event, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
