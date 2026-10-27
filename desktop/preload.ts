import { exposeRpcBridge } from "electron-effect-rpc/preload";

exposeRpcBridge({ endpoints: ["default"] });
