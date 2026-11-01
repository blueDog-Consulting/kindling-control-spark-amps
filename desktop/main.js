// Electron shell for Windows, macOS and Linux. It loads the same web app from
// src/ over a private secure scheme (Web Bluetooth needs a secure context) and
// supplies the Bluetooth device chooser Chromium shows in a normal browser.

import { app, BrowserWindow, ipcMain, net, protocol, shell } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, normalize, sep } from 'node:path';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const SCHEME = 'kindling';

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Web Bluetooth is still behind a flag in Chromium on Linux.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-experimental-web-platform-features');

let pendingBluetoothCallback = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 880,
    minWidth: 380,
    minHeight: 500,
    title: 'KindlingControl',
    icon: fileURLToPath(new URL('../src/icons/icon-512.png', import.meta.url)), // Windows/Linux window + taskbar
    backgroundColor: '#121417',
    autoHideMenuBar: true,
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Called repeatedly while scanning, each time with the full list so far.
  win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    pendingBluetoothCallback = callback;
    win.webContents.send(
      'bt:devices',
      devices.map((d) => ({ id: d.deviceId, name: d.deviceName })),
    );
  });

  // Links to GitHub etc. open in the real browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${SCHEME}:`)) {
      e.preventDefault();
      if (url.startsWith('https:')) shell.openExternal(url);
    }
  });

  const query = process.argv.includes('--mock') ? '?mock=Spark%20GO' : '';
  win.loadURL(`${SCHEME}://app/index.html${query}`);
  return win;
}

ipcMain.on('bt:select', (_e, id) => {
  if (!pendingBluetoothCallback) return;
  pendingBluetoothCallback(id || ''); // '' cancels requestDevice()
  pendingBluetoothCallback = null;
});

app.whenReady().then(() => {
  protocol.handle(SCHEME, (req) => {
    const { pathname } = new URL(req.url);
    const file = normalize(join(root, decodeURIComponent(pathname)));
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
