import { TTLCache } from "./cache.js";
import { LOCAL_DEV_FRONTEND_ORIGIN, PRODUCTION_FRONTEND_ORIGIN } from "./constants/public_origins.js";
import { TokenBucket } from "./rateLimiter.js";
import { CandidatePoint, Point, RouteResult } from "./types.js";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const geocodeTtlMin = envInt("GEOCODE_CACHE_TTL_MIN", 60 * 24 * 14);
const routeTtlMin = envInt("ROUTE_CACHE_TTL_MIN", 30);
const laneTtlMin = envInt("LANE_CACHE_TTL_MIN", 60 * 24);

const geocodeCache = new TTLCache<Point>(geocodeTtlMin * 60 * 1000);
const routeCache = new TTLCache<RouteResult>(routeTtlMin * 60 * 1000);
const laneCache = new TTLCache<unknown>(laneTtlMin * 60 * 1000);

// In-flight de-duplication to prevent duplicate external calls.
const geocodeInFlight = new Map<string, Promise<Point>>();
const routeInFlight = new Map<string, Promise<RouteResult>>();
const laneInFlight = new Map<string, Promise<unknown>>();
const odsayLimiter = new TokenBucket(8, 4);
let hasLoggedOdsayEnv = false;
const MAX_ODSAY_RETRY = 3;

const apiMetrics = {
  dateKey: new Date().toISOString().slice(0, 10),
  kakaoCallsToday: 0,
  odsayCallsToday: 0,
  geocodeCacheHits: 0,
  geocodeCacheMisses: 0,
  routeCacheHits: 0,
  routeCacheMisses: 0,
  laneCacheHits: 0,
  laneCacheMisses: 0
};

function rollMetricsDate(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (apiMetrics.dateKey === today) return;
  apiMetrics.dateKey = today;
  apiMetrics.kakaoCallsToday = 0;
  apiMetrics.odsayCallsToday = 0;
  apiMetrics.geocodeCacheHits = 0;
  apiMetrics.geocodeCacheMisses = 0;
  apiMetrics.routeCacheHits = 0;
  apiMetrics.routeCacheMisses = 0;
  apiMetrics.laneCacheHits = 0;
  apiMetrics.laneCacheMisses = 0;
}

export function getApiMetrics() {
  rollMetricsDate();
  const geocodeTotal = apiMetrics.geocodeCacheHits + apiMetrics.geocodeCacheMisses;
  const routeTotal = apiMetrics.routeCacheHits + apiMetrics.routeCacheMisses;
  const laneTotal = apiMetrics.laneCacheHits + apiMetrics.laneCacheMisses;
  return {
    date: apiMetrics.dateKey,
    kakaoCallsToday: apiMetrics.kakaoCallsToday,
    odsayCallsToday: apiMetrics.odsayCallsToday,
    cache: {
      geocode: {
        hits: apiMetrics.geocodeCacheHits,
        misses: apiMetrics.geocodeCacheMisses,
        hitRate: geocodeTotal ? apiMetrics.geocodeCacheHits / geocodeTotal : 0
      },
      route: {
        hits: apiMetrics.routeCacheHits,
        misses: apiMetrics.routeCacheMisses,
        hitRate: routeTotal ? apiMetrics.routeCacheHits / routeTotal : 0
      },
      lane: {
        hits: apiMetrics.laneCacheHits,
        misses: apiMetrics.laneCacheMisses,
        hitRate: laneTotal ? apiMetrics.laneCacheHits / laneTotal : 0
      }
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mustEnv(name: string): string {
  const raw = process.env[name];
  const value = raw?.trim().replace(/^["']|["']$/g, "");
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

/** Prevent leaking secrets when logs are shared externally. */
function maskApiKeyInUrl(url: string): string {
  return url.replace(/([?&]apiKey=)[^&]*/i, "$1***");
}

/** ODsay WEB 플랫폼 등록 도메인. 우선순위: ODSAY_WEB_ORIGIN → production일 때 기본 Vercel URL → 로컬 개발용 localhost */
function odsayWebOriginHeaders(): { Origin: string; Referer: string } {
  const raw = process.env.ODSAY_WEB_ORIGIN?.trim().replace(/^["']|["']$/g, "") ?? "";
  const fromEnv = raw.replace(/\/$/, "");
  if (fromEnv) {
    return { Origin: fromEnv, Referer: `${fromEnv}/` };
  }
  if (process.env.NODE_ENV === "production") {
    const o = PRODUCTION_FRONTEND_ORIGIN.replace(/\/$/, "");
    return { Origin: o, Referer: `${o}/` };
  }
  const l = LOCAL_DEV_FRONTEND_ORIGIN.replace(/\/$/, "");
  return { Origin: l, Referer: `${l}/` };
}

function roundCoord(value: number, decimals = 5): number {
  const p = 10 ** decimals;
  return Math.round(value * p) / p;
}

function pointKey(p: Point): string {
  return `${roundCoord(p.lat)},${roundCoord(p.lng)}`;
}

function timeBucketKey(bucketMinutes: number): string {
  const ms = Date.now();
  const bucketMs = bucketMinutes * 60 * 1000;
  return String(Math.floor(ms / bucketMs));
}

export async function geocodeAddress(address: string): Promise<Point> {
  rollMetricsDate();
  const key = `geo:${address}`;
  const cached = geocodeCache.get(key);
  if (cached) {
    apiMetrics.geocodeCacheHits += 1;
    return cached;
  }
  apiMetrics.geocodeCacheMisses += 1;

  const inFlight = geocodeInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const apiKey = mustEnv("KAKAO_REST_API_KEY");
    const headers = {
      headers: { Authorization: `KakaoAK ${apiKey}` }
    };

    const addressUrl = new URL("https://dapi.kakao.com/v2/local/search/address.json");
    addressUrl.searchParams.set("query", address);

    apiMetrics.kakaoCallsToday += 1;
    const addressRes = await fetch(addressUrl, headers);
    if (!addressRes.ok) throw new Error(`Kakao geocode failed: ${addressRes.status}`);
    const addressBody = (await addressRes.json()) as {
      documents: Array<{ x: string; y: string }>;
    };
    const addressDoc = addressBody.documents[0];
    if (addressDoc) {
      const point = { lat: Number(addressDoc.y), lng: Number(addressDoc.x) };
      geocodeCache.set(key, point);
      return point;
    }

    const keywordUrl = new URL("https://dapi.kakao.com/v2/local/search/keyword.json");
    keywordUrl.searchParams.set("query", address);
    keywordUrl.searchParams.set("size", "1");

    apiMetrics.kakaoCallsToday += 1;
    const keywordRes = await fetch(keywordUrl, headers);
    if (!keywordRes.ok) throw new Error(`Kakao keyword search failed: ${keywordRes.status}`);
    const keywordBody = (await keywordRes.json()) as {
      documents: Array<{ x: string; y: string }>;
    };
    const keywordDoc = keywordBody.documents[0];
    if (!keywordDoc) throw new Error(`Address not found: ${address}`);

    const point = { lat: Number(keywordDoc.y), lng: Number(keywordDoc.x) };
    geocodeCache.set(key, point);
    return point;
  })();

  geocodeInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    geocodeInFlight.delete(key);
  }
}

export function makeCandidateGrid(center: Point, maxCandidates: number): CandidatePoint[] {
  const step = 0.02;
  const radius = Math.max(1, Math.floor(Math.sqrt(maxCandidates)));
  const points: CandidatePoint[] = [];

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      if (points.length >= maxCandidates) return points;
      const lat = center.lat + dy * step;
      const lng = center.lng + dx * step;
      points.push({
        id: `grid-${dx}-${dy}`,
        name: `grid(${dx},${dy})`,
        lat,
        lng
      });
    }
  }

  return points;
}

export async function searchSubwayStationCandidates(
  center: Point,
  maxCandidates: number
): Promise<CandidatePoint[]> {
  rollMetricsDate();
  const apiKey = mustEnv("KAKAO_REST_API_KEY");
  const headers = {
    headers: { Authorization: `KakaoAK ${apiKey}` }
  };
  const found: CandidatePoint[] = [];
  const seen = new Set<string>();
  const maxPages = Math.min(3, Math.ceil(maxCandidates / 15) + 1);

  for (let page = 1; page <= maxPages; page++) {
    const url = new URL("https://dapi.kakao.com/v2/local/search/category.json");
    url.searchParams.set("category_group_code", "SW8");
    url.searchParams.set("x", String(center.lng));
    url.searchParams.set("y", String(center.lat));
    url.searchParams.set("radius", "20000");
    url.searchParams.set("sort", "distance");
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", "15");

    apiMetrics.kakaoCallsToday += 1;
    const res = await fetch(url, headers);
    if (!res.ok) {
      throw new Error(`Kakao subway category search failed: ${res.status}`);
    }

    const body = (await res.json()) as {
      documents: Array<{
        id: string;
        place_name: string;
        x: string;
        y: string;
      }>;
    };

    for (const doc of body.documents) {
      if (found.length >= maxCandidates) break;
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      found.push({
        id: `subway-${doc.id}`,
        name: doc.place_name,
        lat: Number(doc.y),
        lng: Number(doc.x)
      });
    }

    if (body.documents.length < 15 || found.length >= maxCandidates) break;
  }

  return found;
}

export async function getTransitRoute(
  start: Point,
  end: Point,
  debugMeta?: { fromLabel?: string; toLabel?: string }
): Promise<RouteResult> {
  rollMetricsDate();
  // Cache key uses rounded coords to improve hit rate.
  // Include a time bucket to avoid reusing stale routes for too long.
  const cacheKey = `route:${pointKey(start)}->${pointKey(end)}:tb=${timeBucketKey(30)}`;
  const cached = routeCache.get(cacheKey);
  if (cached) {
    apiMetrics.routeCacheHits += 1;
    return cached;
  }
  apiMetrics.routeCacheMisses += 1;

  const inFlight = routeInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const promise = (async () => {
  const apiKey = mustEnv("ODSAY_API_KEY");
  if (!hasLoggedOdsayEnv) {
    const wh = odsayWebOriginHeaders();
    console.log("[ODsay] env check", {
      exists: Boolean(apiKey),
      length: apiKey.length,
      ODSAY_WEB_ORIGIN_env: process.env.ODSAY_WEB_ORIGIN?.trim() ? "set" : "EMPTY",
      originSentToOdsay: wh.Origin,
      refererSentToOdsay: wh.Referer
    });
    if (!process.env.ODSAY_WEB_ORIGIN?.trim()) {
      if (process.env.NODE_ENV === "production") {
        console.warn(
          `[ODsay] ODSAY_WEB_ORIGIN unset — using default ${PRODUCTION_FRONTEND_ORIGIN} for WEB headers. 명시하려면 Railway에 ODSAY_WEB_ORIGIN을 설정하세요.`
        );
      } else {
        console.log(
          `[ODsay] ODSAY_WEB_ORIGIN unset — using ${LOCAL_DEV_FRONTEND_ORIGIN} (development). WEB 키 테스트는 .env에 ODSAY_WEB_ORIGIN=${PRODUCTION_FRONTEND_ORIGIN} 권장.`
        );
      }
    }
    hasLoggedOdsayEnv = true;
  }

  const requestUrl =
    "https://api.odsay.com/v1/api/searchPubTransPathT" +
    `?SX=${encodeURIComponent(String(start.lng))}` +
    `&SY=${encodeURIComponent(String(start.lat))}` +
    `&EX=${encodeURIComponent(String(end.lng))}` +
    `&EY=${encodeURIComponent(String(end.lat))}` +
    `&apiKey=${encodeURIComponent(apiKey)}`;
  const maskedRequestUrl = maskApiKeyInUrl(requestUrl);
  const webHeaders = odsayWebOriginHeaders();
  const requestConfig = {
    method: "GET",
    headers: {
      Referer: webHeaders.Referer,
      Origin: webHeaders.Origin
    }
  } as const;

  for (let attempt = 1; attempt <= MAX_ODSAY_RETRY; attempt++) {
    await odsayLimiter.consume(1);
    apiMetrics.odsayCallsToday += 1;
    console.log("[ODsay] request", {
      attempt,
      from: debugMeta?.fromLabel ?? "unknown",
      to: debugMeta?.toLabel ?? "unknown",
      start,
      end,
      url: maskedRequestUrl,
      config: requestConfig
    });

    let res: Response;
    try {
      res = await fetch(requestUrl, requestConfig);
    } catch (error) {
      console.error("[ODsay] network error", {
        attempt,
        config: requestConfig,
        url: maskedRequestUrl,
        error
      });
      if (attempt < MAX_ODSAY_RETRY) {
        await sleep(attempt * 700);
        continue;
      }
      throw error;
    }

    if (!res.ok) {
      const responseText = await res.text();
      console.error("[ODsay] http error response", {
        attempt,
        status: res.status,
        statusText: res.statusText,
        data: responseText,
        config: requestConfig,
        url: maskedRequestUrl
      });
      if (res.status === 429 && attempt < MAX_ODSAY_RETRY) {
        await sleep(attempt * 1200);
        continue;
      }
      throw new Error(`ODsay route failed: ${res.status}`);
    }

    const body = (await res.json()) as {
      error?: Array<{ code?: string | number; message?: string; msg?: string }> | { code?: string | number; message?: string; msg?: string };
      result?: {
        path?: Array<{
          info?: { totalTime?: number; busTransitCount?: number; subwayTransitCount?: number };
        }>;
      };
    };
    console.log("[ODsay] response", JSON.stringify(body, null, 2));

    const firstError = Array.isArray(body.error) ? body.error[0] : body.error;
    const errorMessage = firstError?.message ?? firstError?.msg;
    if (firstError) {
      console.error("[ODsay] api error", {
        attempt,
        from: debugMeta?.fromLabel ?? "unknown",
        to: debugMeta?.toLabel ?? "unknown",
        code: firstError.code,
        message: errorMessage
      });
    }
    if (errorMessage?.includes("Too Many Requests") && attempt < MAX_ODSAY_RETRY) {
      await sleep(attempt * 1200);
      continue;
    }
    if (errorMessage?.includes("ApiKey authentication failed")) {
      throw new Error(
        "ODsay API key authentication failed. Check ODSAY_API_KEY value, app status, and allowed usage in ODsay console."
      );
    }

    const paths = body.result?.path;
    if (!Array.isArray(paths) || paths.length === 0) {
      console.error("[ODsay] no path result", {
        attempt,
        from: debugMeta?.fromLabel ?? "unknown",
        to: debugMeta?.toLabel ?? "unknown",
        reason:
          errorMessage ??
          "No path in result.path (too short distance, unsupported area, or API-side filtering)"
      });
      throw new Error(
        `No transit path from ODsay: ${errorMessage ?? "result.path is missing or empty"}`
      );
    }

    const best = paths[0]?.info;
    if (!best?.totalTime) {
      console.error("[ODsay] missing best.info.totalTime", {
        attempt,
        from: debugMeta?.fromLabel ?? "unknown",
        to: debugMeta?.toLabel ?? "unknown",
        best
      });
      throw new Error("No transit path from ODsay: missing totalTime.");
    }
    const transferCount = (best.busTransitCount ?? 0) + (best.subwayTransitCount ?? 0);
    const route = { totalMinutes: best.totalTime, transferCount, raw: body };
    routeCache.set(cacheKey, route);
    return route;
  }

  throw new Error("No transit path from ODsay: Too Many Requests");
  })();

  routeInFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    routeInFlight.delete(cacheKey);
  }
}

export async function loadLane(mapObj: string): Promise<unknown> {
  rollMetricsDate();
  const normalized = mapObj.startsWith("0:0@") ? mapObj : `0:0@${mapObj}`;
  const cacheKey = `lane:${normalized}`;
  const cached = laneCache.get(cacheKey);
  if (cached) {
    apiMetrics.laneCacheHits += 1;
    return cached;
  }
  apiMetrics.laneCacheMisses += 1;

  const inFlight = laneInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const promise = (async () => {

  const apiKey = mustEnv("ODSAY_API_KEY");
  const requestUrl =
    "https://api.odsay.com/v1/api/loadLane" +
    `?mapObject=${encodeURIComponent(normalized)}` +
    `&apiKey=${encodeURIComponent(apiKey)}`;

  for (let attempt = 1; attempt <= MAX_ODSAY_RETRY; attempt++) {
    await odsayLimiter.consume(1);
    apiMetrics.odsayCallsToday += 1;
    const webHeaders = odsayWebOriginHeaders();
    const res = await fetch(requestUrl, {
      method: "GET",
      headers: {
        Referer: webHeaders.Referer,
        Origin: webHeaders.Origin
      }
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 429 && attempt < MAX_ODSAY_RETRY) {
        await sleep(attempt * 1200);
        continue;
      }
      throw new Error(`ODsay loadLane failed: ${res.status} ${text}`);
    }
    const json = JSON.parse(text) as unknown;
    laneCache.set(cacheKey, json);
    return json;
  }

  throw new Error("ODsay loadLane failed: Too Many Requests");
  })();

  laneInFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    laneInFlight.delete(cacheKey);
  }
}
