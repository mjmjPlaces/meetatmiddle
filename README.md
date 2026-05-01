# Midpoint Transit Service (MVP)

친구들 출발지 기준으로 대중교통 중간지점을 찾는 서비스입니다.

## 구현 범위
- 단일 균등 모드 - 최대 소요시간(minimax) 중심
- 상권 규모 보정 점수 반영 (상권 데이터 기반)
- Kakao Local API: 주소 -> 좌표
- ODsay API: 출발지 -> 후보지 대중교통 소요시간/환승수
- 후보지 샘플링 + 캐시 + 레이트리밋 적용

## 파일 구조
- `server/index.ts`: API 엔드포인트
- `server/midpointService.ts`: 핵심 계산 흐름
- `server/scoring.ts`: 점수 계산
- `server/apis.ts`: Kakao/ODsay 연동
- `server/cache.ts`: TTL 캐시
- `server/rateLimiter.ts`: 토큰 버킷 레이트리밋
- `docs/api-keys-checklist.md`: 키/도메인/쿼터 체크리스트

## 실행 준비
1. Node.js 20+ 설치
2. `npm install`
3. `.env.example`를 `.env`로 복사 후 키 입력 (또는 `.env.local.example` -> `.env.local`)
4. `npm run dev`

## 운영 환경 변수
- `NODE_ENV`: `production` 권장
- `PORT`: 서버 포트
- `DATABASE_URL`: (선택) Postgres URL. 설정 시 세션 선택/공유 분석 데이터 영속화
- `ALLOWED_ORIGINS`: 콤마 구분 허용 origin 목록 (운영 + 프리뷰)
- `KAKAO_REST_API_KEY`, `KAKAO_JS_KEY`
- ODsay 키/Origin (환경별 분리 권장)
  - `ODSAY_API_KEY_DEV`, `ODSAY_WEB_ORIGIN_DEV`
  - `ODSAY_API_KEY_PROD`, `ODSAY_WEB_ORIGIN_PROD`
  - 하위 호환: `ODSAY_API_KEY`, `ODSAY_WEB_ORIGIN`
- `DAILY_ODSAY_BUDGET`: 일 ODsay 호출 예산
- `GEOCODE_CACHE_TTL_MIN`, `ROUTE_CACHE_TTL_MIN`, `LANE_CACHE_TTL_MIN`
- `REDIS_URL`: (선택) Railway Redis 연결 URL. 미설정 시 메모리 캐시만 사용
- `REDIS_ROUTE_CACHE_TTL_SEC`: Redis route 캐시 TTL(초, 권장 3600~7200)
- `REDIS_ROUTE_CACHE_BUCKET_MIN`: route 캐시 시간 버킷(분, 권장 30~60)
- `MIDPOINT_P95_WARN_MS`: `/api/midpoint` p95 경고 임계치(ms, 기본 8000)
- `MIDPOINT_ALERT_WEBHOOK_URL`: p95 초과 경고를 보낼 Incoming Webhook URL (선택)
- `MIDPOINT_ALERT_COOLDOWN_MS`: 경고 재전송 최소 간격(ms, 기본 600000=10분)
- `AUTO_REBALANCE_GAP_MIN`: 2인 검색 1순위의 친구 간 시간차가 이 값 이상이면 2차 확장 탐색 수행(기본 30분)
- `AUTO_REBALANCE_MAX_CANDIDATES`: 2차 확장 탐색 시 최대 후보 수 상한(기본 60)
- `AUTO_REBALANCE_REFINE_CANDIDATES`: 2차 확장 탐색 시 정밀평가 후보 수 상한(기본 24)
- `TWO_USER_REFINE_MIN`: 2인 검색 시 유지할 정밀평가 후보 최소 개수(기본 20)
- `MULTI_USER_REFINE_MIN`: 3인 이상 검색 시 유지할 정밀평가 후보 최소 개수(기본 15)
- `FAIRNESS_MODE_GAP_MIN`: 2인 검색에서 최상위 후보 시간차가 이 값 이상이면 공정성 우선 랭킹 모드 적용(기본 30분)
- `FAIRNESS_MODE_GAP_WINDOW_MIN`: 최소 시간차와 허용 윈도우(분). 동률권 내 상권 점수로 최종 우선순위 결정(기본 8분)
- `EXTREME_GAP_PENALTY_THRESHOLD_MIN`: 극단 편차 추가 패널티 시작 분(기본 35분)
- `EXTREME_GAP_PENALTY_PER_MINUTE`: 임계치 초과 1분당 가산 패널티(기본 1.2)
- `FAIRNESS_SECONDARY_POOL_SIZE`: 고편차 시 서버가 2순위(공정성 후보) 선정을 위해 보는 상위 풀 크기(기본 6)
- `FAIRNESS_SECONDARY_MAX_GAP_DELTA`: 2순위 후보는 1순위 대비 시간차 허용 범위 내에서만 선발(기본 +5분)
- `FAIRNESS_SECONDARY_MAX_MAX_MINUTES`: 2순위 후보의 최장 이동시간 상한(기본 60분)
- `ONE_SIDED_MINUTES_THRESHOLD`: 한 명만 지나치게 가까운 패턴 감지용 최소시간 임계치(기본 10분)
- `ONE_SIDED_MEDIAN_THRESHOLD`: 나머지가 오래 걸리는 패턴 감지용 중앙값 임계치(기본 35분)
- `ONE_SIDED_PENALTY`: 한쪽만 유리한 패턴에 부여할 추가 패널티(기본 18)
- `MULTI_FRIEND_STDDEV_WEIGHT`: 3인 이상에서 표준편차 기반 분산 패널티 가중치(기본 0.8)

## 운영 API
- `GET /api/ops/metrics`: API 호출량/캐시 효율/현재 degraded 모드 상태 확인
- `POST /api/v1/sessions/:sid/select`: 추천지 선택/확정 이벤트 기록
- `POST /api/v1/sessions/:sid/share`: 공유 완료 이벤트 기록

### `/api/ops/metrics` 응답 예시

```json
{
  "env": "production",
  "allowedOrigins": [
    "https://midpoint.example.com",
    "https://midpoint-git-feature-foo.vercel.app"
  ],
  "api": {
    "date": "2026-04-17",
    "kakaoCallsToday": 124,
    "odsayCallsToday": 982,
    "cache": {
      "geocode": { "hits": 340, "misses": 24, "hitRate": 0.934 },
      "route": {
        "hits": 1120,
        "misses": 210,
        "hitRate": 0.842,
        "redisHits": 380,
        "redisMisses": 140,
        "redisHitRate": 0.731
      },
      "lane": { "hits": 188, "misses": 34, "hitRate": 0.847 }
    }
  },
  "midpoint": {
    "degradedMode": false,
    "degradedReason": "",
    "usedMaxCandidates": 20,
    "usedRefineCandidates": 6
  },
  "midpointPerf": {
    "windowSize": 300,
    "requestCountWindow": 84,
    "requestCountTotal": 196,
    "failureCountTotal": 3,
    "avgMs": 5142.8,
    "p50Ms": 4320,
    "p95Ms": 9050,
    "avgOdsayCallsPerRequest": 17.2,
    "p95WarnThresholdMs": 8000,
    "alertWebhookEnabled": false,
    "lastRun": {
      "durationMs": 6310,
      "odsayCalls": 21,
      "ok": true,
      "degradedMode": false,
      "degradedReason": "",
      "timestamp": "2026-04-25T14:02:21.100Z"
    }
  }
}
```

### 운영에서 보는 포인트
- `api.odsayCallsToday`: 일일 예산(`DAILY_ODSAY_BUDGET`) 대비 사용량 체크
- 사용량이 `DAILY_ODSAY_BUDGET`의 `90%` 이상이면 degraded 모드가 켜지고 후보 수를 자동 축소
- `api.cache.route.hitRate`: 0.8 이상 유지 권장 (낮으면 후보 수/TTL 재조정)
- `api.cache.route.redisHitRate`: Redis를 켠 경우 0.2 이상부터 효과 체감 가능
- `midpoint.degradedMode`: `true`면 쿼터 보호 모드 동작 중
- `midpoint.degradedReason`: 현재는 `odsay_daily_budget_over_90_percent` 값만 사용
- `midpointPerf.p95Ms`: 목표 8000ms 이하
- `midpointPerf.avgOdsayCallsPerRequest`: 기존 대비 30% 감소 목표
- `midpointPerf.failureCountTotal`: 릴리즈 전후 급증 여부 확인
- `midpointPerf.alertWebhookEnabled`: 외부 경고 전송이 켜졌는지 확인
- `allowedOrigins`: 실제 운영/프리뷰 도메인이 정확히 포함되어 있는지 점검

## Vercel + Railway 배포 체크리스트
1. Railway에 백엔드 배포 후 env 설정:
   - `NODE_ENV=production`
   - `ALLOWED_ORIGINS=https://<vercel-prod-domain>,https://<vercel-preview-domain>`
   - Kakao/ODsay 키
2. Vercel 프론트에서 API 기본 URL을 Railway로 연결
3. Kakao Developers:
   - `앱 > 플랫폼키 > JavaScript 키 > JavaScript SDK 도메인`에 Vercel 도메인 등록
4. ODsay 플랫폼/키 정책 확인 후 운영 서버 기준으로 적용
5. `/api/ops/metrics`로 호출량과 캐시 hit-rate 모니터링

## 개발/테스트/릴리즈 시퀀스 (권장)
규모가 커질수록 **로컬 확인 -> Preview 확인 -> Production 릴리즈** 순서가 안전합니다.

### 1) 로컬 개발/검증
1. 작업 브랜치 생성: `feature/<topic>`
2. 로컬 실행:
   - `npm install`
   - `npm run dev`
3. 아래 항목을 로컬에서 우선 점검:
   - 중간지점 계산 성공/실패 메시지
   - 세부 경로 시트 스크롤/버튼 동작
   - 카카오 공유 버튼(가능하면 모바일 브라우저 포함)
4. 로컬 커밋:
   - `git add <changed files>`
   - `git commit -m "<message>"`

### 2) 내부 Preview 테스트
1. 브랜치를 원격으로 push
2. Vercel Preview URL 생성 확인
3. (권장) Railway Staging/Preview API와 연결해 통합 확인
4. Preview에서 체크리스트 실행:
   - CORS 오류 없음
   - Kakao SDK/공유 정상
   - ODsay 경로 계산 및 fallback(700m) 정상
   - 지도/경로/세부 UI 동작 정상

### 3) Production 릴리즈
1. Preview 검증 통과 후 `main`에 병합
2. `main` 배포 완료 확인 (Vercel + Railway)
3. 운영 점검:
   - `GET /api/health`
   - `GET /api/ops/metrics`
   - 실제 공유 썸네일/카카오 공유 동작 확인

### 빠른 체크 명령 예시 (PowerShell)
```powershell
cd "C:\Users\cocak\OneDrive\OneSyncFiles\Obsidian\ZZ. Cursor\Midpoint Navigator"
git checkout -b feature/<topic>
npm install
npm run dev
```

## SHIFT A/B 회귀 체크
`ENABLE_SHIFT_TARGETS`를 켰을 때/껐을 때 결과 품질이 급격히 흔들리는지 자동 확인합니다.

1. 실행:
   - `npm run test:ab-shift`
2. 산출물:
   - `docs/ab-shift-report.latest.json`
3. 판정 기준(기본):
   - Top1 변경 케이스 수 <= 1
   - Top1 평균시간 차이 <= 6분
   - Top1 점수 차이 <= 12

> 기준은 서비스 운영 데이터에 맞춰 점진적으로 조정하세요.

## API 사용 예시
`POST /api/midpoint`

```json
{
  "friends": [
    { "id": "f1", "name": "A", "address": "서울특별시 강남구" },
    { "id": "f2", "name": "B", "address": "서울특별시 마포구" }
  ],
  "options": {
    "topN": 3,
    "maxCandidates": 25,
    "transferPenalty": 8
  }
}
```

### 사용자 의사결정 추적 (Session DB)
- DB가 켜져 있으면(`DATABASE_URL`) `/api/share` 생성 시 `sessions`, `session_origins`에 저장
- 출발지 좌표는 개인정보 최소화를 위해 소수점 3자리까지 저장(`lat_approx`, `lng_approx`)
- 추천지 클릭 시 `POST /api/v1/sessions/:sid/select`
- 카카오 공유 성공 시 `POST /api/v1/sessions/:sid/share`
- B2B 통계용 View SQL: `docs/sql/session_origin_destination_stats_view.sql`
