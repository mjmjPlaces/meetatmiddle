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
import { initSessionStore, isSessionStoreEnabled, markSessionSelected, markSessionShared, saveShareSession } from "./sessionStore.js";
import { MidpointRequest } from "./types.js";

// Load .env first, then let .env.local override for local development.
dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const app = express();
const sharePayloadCache = new TTLCache<unknown>(1000 * 60 * 60 * 24);
const MIDPOINT_METRIC_WINDOW = 300;
const MIDPOINT_P95_WARN_MS = Number(process.env.MIDPOINT_P95_WARN_MS ?? 8000);
const MIDPOINT_ALERT_WEBHOOK_URL = (process.env.MIDPOINT_ALERT_WEBHOOK_URL ?? "").trim();
const MIDPOINT_ALERT_COOLDOWN_MS = Number(process.env.MIDPOINT_ALERT_COOLDOWN_MS ?? 10 * 60 * 1000);
const midpointDurationWindow: number[] = [];
const midpointOdsayDeltaWindow: number[] = [];
let midpointTotalRequests = 0;
let midpointTotalFailures = 0;
let lastMidpointAlertAt = 0;
let midpointLastRun: {
  durationMs: number;
  odsayCalls: number;
  ok: boolean;
  degradedMode: boolean;
  degradedReason: string;
  timestamp: string;
} | null = null;

function pushWindow(arr: number[], value: number) {
  arr.push(value);
  if (arr.length > MIDPOINT_METRIC_WINDOW) arr.shift();
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const idx = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[idx];
}

async function maybeEmitMidpointPerfAlert() {
  if (midpointDurationWindow.length < 20) return;
  const p95Ms = percentile(midpointDurationWindow, 95);
  if (p95Ms < MIDPOINT_P95_WARN_MS) return;
  const now = Date.now();
  if (now - lastMidpointAlertAt < MIDPOINT_ALERT_COOLDOWN_MS) return;
  lastMidpointAlertAt = now;

  const payload = {
    text:
      `[MidpointPerf] p95 warning: ${Math.round(p95Ms)}ms (threshold ${MIDPOINT_P95_WARN_MS}ms)\n` +
      `window=${midpointDurationWindow.length}, avg=${average(midpointDurationWindow).toFixed(1)}ms, ` +
      `avgOdsayCalls=${average(midpointOdsayDeltaWindow).toFixed(2)}`
  };
  console.warn("[MidpointPerf] p95_threshold_exceeded", {
    p95Ms: Math.round(p95Ms),
    thresholdMs: MIDPOINT_P95_WARN_MS,
    windowSize: midpointDurationWindow.length,
    avgMs: Number(average(midpointDurationWindow).toFixed(1)),
    avgOdsayCallsPerRequest: Number(average(midpointOdsayDeltaWindow).toFixed(2))
  });

  if (!MIDPOINT_ALERT_WEBHOOK_URL) return;
  try {
    await fetch(MIDPOINT_ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.warn("[MidpointPerf] alert_webhook_failed", { error: String(error) });
  }
}

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

/** 공유 딥링크 `/s/:sid` — 정적 파일이 없을 때 SPA로 넘김 */
app.get("/s/:sid", (_req, res) => {
  res.sendFile(path.join(webRoot, "index.html"));
});

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
  void saveShareSession(sid, payload);
  return res.json({ sid });
});

app.get("/api/share/:sid", (req, res) => {
  const sid = String(req.params.sid ?? "").trim();
  if (!sid) return res.status(400).json({ error: "sid is required" });
  const payload = sharePayloadCache.get(sid);
  if (!payload) return res.status(404).json({ error: "share payload not found or expired" });
  return res.json({ payload });
});

app.post("/api/v1/sessions/:sid/select", async (req, res) => {
  const sid = String(req.params.sid ?? "").trim();
  if (!sid) return res.status(400).json({ error: "sid is required" });
  const selectedPlaceId = String(req.body?.selectedPlaceId ?? "").trim();
  if (!selectedPlaceId) return res.status(400).json({ error: "selectedPlaceId is required" });
  if (!isSessionStoreEnabled()) {
    return res.status(503).json({ error: "session store is disabled (DATABASE_URL missing or unavailable)" });
  }
  const ok = await markSessionSelected(sid, {
    selectedPlaceId,
    selectedPlaceName: req.body?.selectedPlaceName,
    lat: req.body?.lat,
    lng: req.body?.lng
  });
  if (!ok) return res.status(404).json({ error: "session not found" });
  return res.json({ ok: true, sid, selectedPlaceId });
});

app.post("/api/v1/sessions/:sid/share", async (req, res) => {
  const sid = String(req.params.sid ?? "").trim();
  if (!sid) return res.status(400).json({ error: "sid is required" });
  if (!isSessionStoreEnabled()) {
    return res.status(503).json({ error: "session store is disabled (DATABASE_URL missing or unavailable)" });
  }
  const ok = await markSessionShared(sid);
  if (!ok) return res.status(404).json({ error: "session not found" });
  return res.json({ ok: true, sid, isShared: true });
});

app.post("/api/midpoint", async (req, res) => {
  const startedAt = Date.now();
  const before = getApiMetrics();
  midpointTotalRequests += 1;
  try {
    const body = req.body as MidpointRequest;
    if (!body?.friends?.length || body.friends.length < 2) {
      return res.status(400).json({ error: "At least 2 friends are required." });
    }
    const results = await findMidpoints(body);
    const runMeta = getMidpointRunMeta();
    const after = getApiMetrics();
    const durationMs = Date.now() - startedAt;
    const odsayCalls = Math.max(0, after.odsayCallsToday - before.odsayCallsToday);
    pushWindow(midpointDurationWindow, durationMs);
    pushWindow(midpointOdsayDeltaWindow, odsayCalls);
    midpointLastRun = {
      durationMs,
      odsayCalls,
      ok: true,
      degradedMode: runMeta.degradedMode,
      degradedReason: runMeta.degradedReason,
      timestamp: new Date().toISOString()
    };
    console.log("[MidpointPerf] request", {
      durationMs,
      odsayCalls,
      routeCacheHitRate: Number(after.cache.route.hitRate.toFixed(4)),
      degradedMode: runMeta.degradedMode,
      degradedReason: runMeta.degradedReason
    });
    void maybeEmitMidpointPerfAlert();
    return res.json({ results, degradedMode: runMeta.degradedMode, degradedReason: runMeta.degradedReason });
  } catch (error) {
    midpointTotalFailures += 1;
    const after = getApiMetrics();
    const durationMs = Date.now() - startedAt;
    const odsayCalls = Math.max(0, after.odsayCallsToday - before.odsayCallsToday);
    pushWindow(midpointDurationWindow, durationMs);
    pushWindow(midpointOdsayDeltaWindow, odsayCalls);
    midpointLastRun = {
      durationMs,
      odsayCalls,
      ok: false,
      degradedMode: false,
      degradedReason: "failed",
      timestamp: new Date().toISOString()
    };
    console.warn("[MidpointPerf] request_failed", {
      durationMs,
      odsayCalls,
      routeCacheHitRate: Number(after.cache.route.hitRate.toFixed(4))
    });
    void maybeEmitMidpointPerfAlert();
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
    midpoint,
    midpointPerf: {
      windowSize: MIDPOINT_METRIC_WINDOW,
      requestCountWindow: midpointDurationWindow.length,
      requestCountTotal: midpointTotalRequests,
      failureCountTotal: midpointTotalFailures,
      avgMs: Number(average(midpointDurationWindow).toFixed(1)),
      p50Ms: Math.round(percentile(midpointDurationWindow, 50)),
      p95Ms: Math.round(percentile(midpointDurationWindow, 95)),
      avgOdsayCallsPerRequest: Number(average(midpointOdsayDeltaWindow).toFixed(2)),
      p95WarnThresholdMs: MIDPOINT_P95_WARN_MS,
      alertWebhookEnabled: Boolean(MIDPOINT_ALERT_WEBHOOK_URL),
      lastRun: midpointLastRun
    }
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
void (async () => {
  await initSessionStore();
  app.listen(port, "0.0.0.0", () => {
    console.log(`Server listening on port ${port}`);
  });
})();
