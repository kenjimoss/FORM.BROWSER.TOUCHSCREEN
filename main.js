const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');

let mainWindow;

function createWindow() {
  const winOptions = {
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true
    }
  };

  if (process.platform === 'win32') {
    winOptions.frame = false;
    winOptions.transparent = true;
    winOptions.backgroundColor = '#00000000';
    winOptions.resizable = true;
  }

  mainWindow = new BrowserWindow(winOptions);

  mainWindow.on('moved',             () => mainWindow.webContents.send('window-moved'));
  mainWindow.on('enter-full-screen', () => mainWindow.webContents.send('window-fullscreen'));
  mainWindow.on('leave-full-screen', () => mainWindow.webContents.send('window-unfullscreen'));

  mainWindow.maximize();
  mainWindow.loadFile('index.html');

  // Open DevTools for debugging
  // mainWindow.webContents.openDevTools();
}

ipcMain.handle('capture-desktop', async () => {
  mainWindow.setOpacity(0);
  await new Promise(resolve => setTimeout(resolve, 50));

  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const { width, height } = display.size;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  });

  mainWindow.setOpacity(1);
  return {
    screenshot: sources[0].thumbnail.toDataURL(),
    displaySize: { width, height },
    bounds
  };
});

ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => mainWindow.setFullScreen(!mainWindow.isFullScreen()));
ipcMain.on('window-close', () => mainWindow.close());
ipcMain.handle('window-resize', (event, { x, y, width, height }) => mainWindow.setBounds({ x, y, width, height }));

app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('enable-touch-events'); // ensure pointer events fire on touch hardware
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
