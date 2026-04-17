import "dotenv/config";
import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getApiMetrics, loadLane } from "./apis.js";
import { findMidpoints, getMidpointRunMeta } from "./midpointService.js";
import { MidpointRequest } from "./types.js";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, "..");
const nodeEnv = process.env.NODE_ENV ?? "development";
const configuredOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const allowedOriginSet = new Set(configuredOrigins);
if (nodeEnv !== "production") {
  allowedOriginSet.add("http://localhost:4000");
  allowedOriginSet.add("http://127.0.0.1:4000");
  allowedOriginSet.add("http://localhost:5173");
  allowedOriginSet.add("http://127.0.0.1:5173");
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOriginSet.has(origin)) return callback(null, true);
      return callback(new Error("CORS origin not allowed"));
    },
    credentials: true
  })
);
app.options("*", cors());
app.use(express.json());
app.use(express.static(webRoot));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/public-config", (_req, res) => {
  res.json({
    kakaoJsKey: (process.env.KAKAO_JS_KEY ?? "").trim().replace(/^["']|["']$/g, "")
  });
});

app.post("/api/midpoint", async (req, res) => {
  try {
    const body = req.body as MidpointRequest;
    if (!body?.friends?.length || body.friends.length < 2) {
      return res.status(400).json({ error: "At least 2 friends are required." });
    }
    const results = await findMidpoints(body);
    const runMeta = getMidpointRunMeta();
    return res.json({ results, degradedMode: runMeta.degradedMode, degradedReason: runMeta.degradedReason });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.get("/api/ops/metrics", (_req, res) => {
  const api = getApiMetrics();
  const midpoint = getMidpointRunMeta();
  res.json({
    env: nodeEnv,
    allowedOrigins: [...allowedOriginSet],
    api,
    midpoint
  });
});

app.get("/api/odsay/loadLane", async (req, res) => {
  try {
    const mapObj = String(req.query.mapObj ?? "");
    if (!mapObj) return res.status(400).json({ error: "mapObj is required" });
    const data = await loadLane(mapObj);
    return res.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(webRoot, "index.html"));
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
