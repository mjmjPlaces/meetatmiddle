import dotenv from "dotenv";
import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getApiMetrics, loadLane } from "./apis.js";
import { TTLCache } from "./cache.js";
import { findMidpoints, getMidpointRunMeta } from "./midpointService.js";
import { MidpointRequest } from "./types.js";

// Load .env first, then let .env.local override for local development.
dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const app = express();
const sharePayloadCache = new TTLCache<unknown>(1000 * 60 * 60 * 24);

/** Repo root (where index.html lives). Railway cwd is not always the repo root; resolve from this file. */
function resolveWebRoot(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const normalized = dir.replace(/\\/g, "/");
  const candidates: string[] = [];
  if (normalized.includes("/dist/server")) {
    candidates.push(path.resolve(dir, "..", ".."));
  }
  candidates.push(path.resolve(dir, ".."));
  candidates.push(process.cwd());
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "index.html"))) {
        return c;
      }
    } catch {
      // ignore
    }
  }
  return candidates[0];
}

const webRoot = resolveWebRoot();
if (process.env.NODE_ENV === "production") {
  console.log("[static] webRoot =", webRoot);
}
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

if (nodeEnv === "production") {
  console.log("[cors] allowed origins:", [...allowedOriginSet].join(", ") || "(none — browser cross-origin API will fail)");
}

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOriginSet.has(origin)) return callback(null, true);
    console.warn("[cors] denied origin:", origin);
    return callback(null, false);
  },
  credentials: true
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
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

app.post("/api/share", (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ error: "payload is required" });
  }
  const sid = randomUUID().replace(/-/g, "").slice(0, 16);
  sharePayloadCache.set(sid, payload);
  return res.json({ sid });
});

app.get("/api/share/:sid", (req, res) => {
  const sid = String(req.params.sid ?? "").trim();
  if (!sid) return res.status(400).json({ error: "sid is required" });
  const payload = sharePayloadCache.get(sid);
  if (!payload) return res.status(404).json({ error: "share payload not found or expired" });
  return res.json({ payload });
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
app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});
