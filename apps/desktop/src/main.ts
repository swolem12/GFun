import { app, BrowserWindow } from "electron";
import path from "node:path";
import fs from "node:fs";

const createWindow = (): void => {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, "preload.js")
    }
  });

  const candidatePaths = [
    path.join(process.cwd(), "src", "renderer", "index.html"),
    path.join(__dirname, "..", "src", "renderer", "index.html")
  ];

  const htmlPath = candidatePaths.find((filePath) => fs.existsSync(filePath));

  if (!htmlPath) {
    throw new Error("Renderer HTML not found.");
  }

  void win.loadFile(htmlPath);
};

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
