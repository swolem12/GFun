import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("gfun", {
  cadApiBaseUrl: process.env.GFUN_CAD_API_URL ?? "http://127.0.0.1:8000"
});
