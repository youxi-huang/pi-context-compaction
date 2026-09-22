import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

if (process.env.PI_OFFLINE !== "1" || process.env.EVAL_MODEL_CALL_BUDGET !== "0" || process.env.EVAL_PROVIDER_MODE !== "scripted") throw new Error("EVAL_OFFLINE_CONFIGURATION_REQUIRED");
const denied = () => { throw new Error("EVAL_NETWORK_FORBIDDEN"); };
globalThis.fetch = denied;
http.request = denied;
http.get = denied;
https.request = denied;
https.get = denied;
net.connect = denied;
net.createConnection = denied;
net.Socket.prototype.connect = denied;
tls.connect = denied;
syncBuiltinESMExports();
