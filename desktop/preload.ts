import { contextBridge, ipcRenderer, webUtils } from "electron";
import { exposeRpcBridge } from "electron-effect-rpc/preload";

exposeRpcBridge({ endpoints: ["default"] });

contextBridge.exposeInMainWorld("mokeFiles", {
  stageDrop: (file: File) => ipcRenderer.invoke("moke:stage-pdf", webUtils.getPathForFile(file)),
});
