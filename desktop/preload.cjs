// Minimal bridge for the Bluetooth device picker. Nothing else from Node or
// Electron is exposed to the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sparkDesktop', {
  platform: process.platform,
  onBluetoothDevices: (cb) => ipcRenderer.on('bt:devices', (_e, devices) => cb(devices)),
  selectBluetoothDevice: (id) => ipcRenderer.send('bt:select', id),
});
