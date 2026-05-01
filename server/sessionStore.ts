import { Pool } from "pg";

type SessionOrigin = {
  label: string;
  lat?: number;
  lng?: number;
  lawDong?: string;
};

type SessionSelectInput = {
  selectedPlaceId: string;
  selectedPlaceName?: string;
  lat?: number;
  lng?: number;
};

type SessionEventInput = {
  eventType: string;
  candidateId?: string;
  candidateName?: string;
  rank?: number;
  meta?: Record<string, unknown>;
};

let pool: Pool | null = null;
let enabled = false;

function optionalEnv(name: string): string {
  return process.env[name]?.trim().replace(/^["']|["']$/g, "") ?? "";
}

function round3(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function extractLawDong(label: string): string | null {
  const text = String(label ?? "").trim();
  if (!text) return null;
  const m = text.match(/([가-힣A-Za-z0-9_-]+(?:동|읍|면|리))(?:\s|$)/);
  return m?.[1] ?? null;
}

function normalizeOriginsFromPayload(payload: unknown): SessionOrigin[] {
  const perFriend =
    (payload as { item?: { perFriend?: Array<{ friendAddress?: string; startPoint?: { lat?: number; lng?: number } }> } })?.item
      ?.perFriend ?? [];
  return perFriend.map((pf) => {
    const label = String(pf?.friendAddress ?? "").trim();
    return {
      label: label || "unknown",
      lat: round3(pf?.startPoint?.lat) ?? undefined,
      lng: round3(pf?.startPoint?.lng) ?? undefined,
      lawDong: extractLawDong(label) ?? undefined
    };
  });
}

export function isSessionStoreEnabled() {
  return enabled;
}

export async function initSessionStore() {
  const url = optionalEnv("DATABASE_URL");
  if (!url) {
    console.log("[SessionStore] DATABASE_URL is empty; DB persistence disabled.");
    return;
  }
  try {
    pool = new Pool({ connectionString: url, max: 5 });
    await pool.query("SELECT 1");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        selected_place_id TEXT,
        selected_place_name TEXT,
        selected_place_lat_approx NUMERIC(9,3),
        selected_place_lng_approx NUMERIC(9,3),
        confirmed_at TIMESTAMPTZ,
        is_shared BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS session_origins (
        id BIGSERIAL PRIMARY KEY,
        sid TEXT NOT NULL REFERENCES sessions(sid) ON DELETE CASCADE,
        origin_label TEXT NOT NULL,
        lat_approx NUMERIC(9,3),
        lng_approx NUMERIC(9,3),
        law_dong TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_session_origins_sid ON session_origins (sid);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS session_candidate_events (
        id BIGSERIAL PRIMARY KEY,
        sid TEXT NOT NULL REFERENCES sessions(sid) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        candidate_id TEXT,
        candidate_name TEXT,
        rank_order INTEGER,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_session_candidate_events_sid ON session_candidate_events (sid, created_at DESC);
    `);
    await pool.query(`
      CREATE OR REPLACE VIEW v_session_origin_destination_stats AS
      WITH pairwise AS (
        SELECT
          o1.sid,
          (
            6371.0 * 2 * ASIN(
              SQRT(
                POWER(SIN(RADIANS((o2.lat_approx::double precision - o1.lat_approx::double precision) / 2)), 2) +
                COS(RADIANS(o1.lat_approx::double precision)) *
                COS(RADIANS(o2.lat_approx::double precision)) *
                POWER(SIN(RADIANS((o2.lng_approx::double precision - o1.lng_approx::double precision) / 2)), 2)
              )
            )
          ) AS distance_km
        FROM session_origins o1
        JOIN session_origins o2
          ON o1.sid = o2.sid
         AND o1.id < o2.id
        WHERE o1.lat_approx IS NOT NULL AND o1.lng_approx IS NOT NULL
          AND o2.lat_approx IS NOT NULL AND o2.lng_approx IS NOT NULL
      )
      SELECT
        s.sid,
        s.created_at,
        s.confirmed_at,
        s.is_shared,
        s.selected_place_id,
        COALESCE(s.selected_place_name, s.selected_place_id) AS final_destination,
        s.selected_place_lat_approx,
        s.selected_place_lng_approx,
        COUNT(o.id) AS origins_count,
        ROUND(AVG(p.distance_km)::numeric, 3) AS avg_origin_distance_km
      FROM sessions s
      LEFT JOIN session_origins o ON o.sid = s.sid
      LEFT JOIN pairwise p ON p.sid = s.sid
      GROUP BY
        s.sid, s.created_at, s.confirmed_at, s.is_shared, s.selected_place_id,
        s.selected_place_name, s.selected_place_lat_approx, s.selected_place_lng_approx;
    `);
    enabled = true;
    console.log("[SessionStore] Postgres session tracking enabled.");
  } catch (error) {
    console.warn("[SessionStore] failed to initialize; DB tracking disabled.", { error: String(error) });
    enabled = false;
    pool = null;
  }
}

export async function saveShareSession(sid: string, payload: unknown) {
  if (!enabled || !pool) return;
  const origins = normalizeOriginsFromPayload(payload);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
      INSERT INTO sessions (sid, payload)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (sid) DO UPDATE
        SET payload = EXCLUDED.payload,
            updated_at = NOW();
      `,
      [sid, JSON.stringify(payload ?? {})]
    );
    await client.query(`DELETE FROM session_origins WHERE sid = $1`, [sid]);
    for (const origin of origins) {
      await client.query(
        `
        INSERT INTO session_origins (sid, origin_label, lat_approx, lng_approx, law_dong)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [sid, origin.label, origin.lat ?? null, origin.lng ?? null, origin.lawDong ?? null]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    console.warn("[SessionStore] saveShareSession failed", { sid, error: String(error) });
  } finally {
    client.release();
  }
}

export async function markSessionSelected(sid: string, input: SessionSelectInput) {
  if (!enabled || !pool) return false;
  const selectedPlaceId = String(input.selectedPlaceId ?? "").trim();
  if (!selectedPlaceId) return false;
  const selectedPlaceName = String(input.selectedPlaceName ?? "").trim();
  try {
    const result = await pool.query(
      `
      UPDATE sessions
         SET selected_place_id = $2,
             selected_place_name = NULLIF($3, ''),
             selected_place_lat_approx = $4,
             selected_place_lng_approx = $5,
             confirmed_at = NOW(),
             updated_at = NOW()
       WHERE sid = $1
      `,
      [sid, selectedPlaceId, selectedPlaceName, round3(input.lat), round3(input.lng)]
    );
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    console.warn("[SessionStore] markSessionSelected failed", { sid, error: String(error) });
    return false;
  }
}

export async function markSessionShared(sid: string) {
  if (!enabled || !pool) return false;
  try {
    const result = await pool.query(
      `
      UPDATE sessions
         SET is_shared = TRUE,
             updated_at = NOW()
       WHERE sid = $1
      `,
      [sid]
    );
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    console.warn("[SessionStore] markSessionShared failed", { sid, error: String(error) });
    return false;
  }
}

export async function appendSessionEvents(sid: string, events: SessionEventInput[]) {
  if (!enabled || !pool || !events.length) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const event of events) {
      const eventType = String(event.eventType ?? "").trim();
      if (!eventType) continue;
      await client.query(
        `
        INSERT INTO session_candidate_events (sid, event_type, candidate_id, candidate_name, rank_order, meta)
        VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6::jsonb)
        `,
        [
          sid,
          eventType,
          String(event.candidateId ?? "").trim(),
          String(event.candidateName ?? "").trim(),
          event.rank ?? null,
          JSON.stringify(event.meta ?? {})
        ]
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    console.warn("[SessionStore] appendSessionEvents failed", { sid, error: String(error) });
    return false;
  } finally {
    client.release();
  }
}

export const SESSION_STATS_VIEW_SQL = `
CREATE OR REPLACE VIEW v_session_origin_destination_stats AS
WITH pairwise AS (
  SELECT
    o1.sid,
    (
      6371.0 * 2 * ASIN(
        SQRT(
          POWER(SIN(RADIANS((o2.lat_approx::double precision - o1.lat_approx::double precision) / 2)), 2) +
          COS(RADIANS(o1.lat_approx::double precision)) *
          COS(RADIANS(o2.lat_approx::double precision)) *
          POWER(SIN(RADIANS((o2.lng_approx::double precision - o1.lng_approx::double precision) / 2)), 2)
        )
      )
    ) AS distance_km
  FROM session_origins o1
  JOIN session_origins o2
    ON o1.sid = o2.sid
   AND o1.id < o2.id
  WHERE o1.lat_approx IS NOT NULL AND o1.lng_approx IS NOT NULL
    AND o2.lat_approx IS NOT NULL AND o2.lng_approx IS NOT NULL
)
SELECT
  s.sid,
  s.created_at,
  s.confirmed_at,
  s.is_shared,
  s.selected_place_id,
  COALESCE(s.selected_place_name, s.selected_place_id) AS final_destination,
  s.selected_place_lat_approx,
  s.selected_place_lng_approx,
  COUNT(o.id) AS origins_count,
  ROUND(AVG(p.distance_km)::numeric, 3) AS avg_origin_distance_km
FROM sessions s
LEFT JOIN session_origins o ON o.sid = s.sid
LEFT JOIN pairwise p ON p.sid = s.sid
GROUP BY
  s.sid, s.created_at, s.confirmed_at, s.is_shared, s.selected_place_id,
  s.selected_place_name, s.selected_place_lat_approx, s.selected_place_lng_approx;
`;
