// TalkEx desktop (Electron) — a thin native window around the live web app.
// It loads https://web.talkex.in so the desktop app is always in sync
// with the deployed frontend (no per-release rebuild of the .exe needed).

const { app, BrowserWindow, shell, Menu } = require("electron");
const path = require("path");

const APP_URL = process.env.TALKEX_URL || "https://web.talkex.in";

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 600,
    backgroundColor: "#0a0e1a",
    title: "TalkEx",
    icon: path.join(__dirname, "build", "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Calls need camera/mic — grant media (and notifications) for our own origin.
  const session = mainWindow.webContents.session;
  session.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ["media", "notifications", "clipboard-read", "clipboard-sanitized-write"];
    callback(allowed.includes(permission));
  });

  mainWindow.loadURL(APP_URL);

  // Open external links (e.g. social links) in the real browser, not inside
  // the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

// A minimal menu (Edit shortcuts for copy/paste still work; hide the rest).
Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
