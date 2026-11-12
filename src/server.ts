import "dotenv/config";
import { createApp } from "./app.js";
const mode = process.env.MODE ?? "demo";
if (mode !== "demo" && mode !== "live")
  throw new Error("MODE deve ser demo ou live");
const host = process.env.HOST ?? "127.0.0.1";
if (!["127.0.0.1", "localhost", "::1"].includes(host) && !process.env.API_KEY)
  throw new Error("API_KEY obrigatória para acesso fora do loopback");
const { app } = await createApp({
  mode,
  dataDir: process.env.DATA_DIR ?? "./data",
  apiKey: process.env.API_KEY,
  openaiKey: process.env.OPENAI_API_KEY,
  openaiURL: process.env.OPENAI_BASE_URL,
  model: process.env.OPENAI_MODEL,
  bridgeURL: process.env.BRIDGE_URL,
  bridgeToken: process.env.BRIDGE_TOKEN,
  maxCalls: Number(process.env.MAX_LLM_CALLS ?? 200),
});
await app.listen({ host, port: Number(process.env.PORT ?? 3100) });
console.log(
  `Social Simulation Lab em http://${host}:${process.env.PORT ?? 3100} — modo ${mode}`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
