-- B2B 통계용: 출발지들간 평균 거리 + 최종 목적지를 함께 조회
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
