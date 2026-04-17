# Midpoint Transit Service (MVP)

친구들 출발지 기준으로 대중교통 중간지점을 찾는 서비스입니다.

## 구현 범위
- 모드 1: 균등 모드(`balanced`) - 최대 소요시간(minimax) 중심
- 모드 2: 비균등 모드(`majority`) - 다수 평균시간 최소화(이상치 가중치 완화)
- Kakao Local API: 주소 -> 좌표
- ODsay API: 출발지 -> 후보지 대중교통 소요시간/환승수
- 후보지 샘플링 + 캐시 + 레이트리밋 적용

## 파일 구조
- `server/index.ts`: API 엔드포인트
- `server/midpointService.ts`: 핵심 계산 흐름
- `server/scoring.ts`: 모드별 점수 계산
- `server/apis.ts`: Kakao/ODsay 연동
- `server/cache.ts`: TTL 캐시
- `server/rateLimiter.ts`: 토큰 버킷 레이트리밋
- `docs/api-keys-checklist.md`: 키/도메인/쿼터 체크리스트

## 실행 준비
1. Node.js 20+ 설치
2. `npm install`
3. `.env.example`를 `.env`로 복사 후 키 입력
4. `npm run dev`

## 운영 환경 변수
- `NODE_ENV`: `production` 권장
- `PORT`: 서버 포트
- `ALLOWED_ORIGINS`: 콤마 구분 허용 origin 목록 (운영 + 프리뷰)
- `KAKAO_REST_API_KEY`, `KAKAO_JS_KEY`, `ODSAY_API_KEY`
- `DAILY_ODSAY_BUDGET`: 일 ODsay 호출 예산
- `GEOCODE_CACHE_TTL_MIN`, `ROUTE_CACHE_TTL_MIN`, `LANE_CACHE_TTL_MIN`

## 운영 API
- `GET /api/ops/metrics`: API 호출량/캐시 효율/현재 degraded 모드 상태 확인

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
      "route": { "hits": 1120, "misses": 210, "hitRate": 0.842 },
      "lane": { "hits": 188, "misses": 34, "hitRate": 0.847 }
    }
  },
  "midpoint": {
    "degradedMode": false,
    "degradedReason": "",
    "usedMaxCandidates": 20,
    "usedRefineCandidates": 6
  }
}
```

### 운영에서 보는 포인트
- `api.odsayCallsToday`: 일일 예산(`DAILY_ODSAY_BUDGET`) 대비 사용량 체크
- 사용량이 `DAILY_ODSAY_BUDGET`의 `90%` 이상이면 degraded 모드가 켜지고 후보 수를 자동 축소
- `api.cache.route.hitRate`: 0.8 이상 유지 권장 (낮으면 후보 수/TTL 재조정)
- `midpoint.degradedMode`: `true`면 쿼터 보호 모드 동작 중
- `midpoint.degradedReason`: 현재는 `odsay_daily_budget_over_90_percent` 값만 사용
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

## API 사용 예시
`POST /api/midpoint`

```json
{
  "mode": "balanced",
  "friends": [
    { "id": "f1", "name": "A", "address": "서울특별시 강남구" },
    { "id": "f2", "name": "B", "address": "서울특별시 마포구" }
  ],
  "options": {
    "topN": 3,
    "maxCandidates": 25,
    "transferPenalty": 8,
    "outlierWeight": 0.5,
    "reducedOutlierCount": 1
  }
}
```
