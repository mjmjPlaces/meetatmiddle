# 수도권 상권 거점 데이터 — 약속장소 중간지점 선정용

약속장소 선정 시 양쪽 출발지의 "중간 거점"을 탐색할 때 우선 고려할 100개 역/상권 Pre-data입니다.

---

## 파일 구조

```
commerce_hubs.ts    — TypeScript (타입 정의 + 데이터, Cursor에서 바로 import)
commerce_hubs.json  — JSON (프레임워크 무관 범용 사용)
```

---

## 데이터 출처 (Sources)

| 코드 | 출처 | 활용 목적 |
|------|------|-----------|
| S1 | [서울교통공사 일평균 승하차순위 (2024.12)](https://www.data.go.kr/data/15044250/fileData.do) | 역별 유동인구 규모 판단 |
| S2 | [서울교통공사 시간대별 승하차인원 (2023.12)](https://www.data.go.kr/data/15048032/fileData.do) | 18~22시 저녁시간대 하차 패턴 도출 |
| S3 | [소상공인시장진흥공단 상권정보시스템](https://sg.sbiz.or.kr) / [공공데이터포털](https://www.data.go.kr/data/15029180/standard.do) | 상권등급(S/A/B), 업종 밀집도 |
| S4 | [서울시 상권분석 서비스 (골목상권)](https://golmok.seoul.go.kr) | 행정동별 유동인구·점포수·매출 순위 |
| S5 | [통계지리정보서비스 생활업종 통계지도 (2023 사업체조사)](https://sgis.kostat.go.kr/view/bizStats/bizStatsMap) | 음식점·카페·주점 사업체 수 |
| S6 | 나무위키 [서울특별시/상권](https://namu.wiki/w/서울특별시/상권) / [경기도/상권](https://namu.wiki/w/경기도/상권) (2026.03) | 상권 성격·Vibe·심리적 중심성 참고 |
| S7 | 커뮤니티/SNS 키워드 빈도 (네이버 데이터랩·카카오맵 리뷰 집계 추정) | "역명+맛집/약속/회식" 검색량 기반 psychological 보정 |

> **주의:** S6(나무위키), S7(SNS 키워드)는 정성적 참고 자료입니다. 정량 데이터(S1~S5)를 우선으로 하고, 보완 목적으로 활용했습니다.

---

## Tier 분류 기준

| Tier | 정의 | 개수 |
|------|------|------|
| **1** | 초거대 허브 — 전국구 인지도, 일평균 승하차 상위권, 상권등급 S | 10 |
| **2** | 광역 거점 — 교통 요충(환승 2개 이상) + 대형 상권, 상권등급 A~S | 38 |
| **3** | 지역 거점 — 역세권 상권 발달, 상권등급 B~A | 52 |

---

## 필드 설명

```typescript
{
  id: string                // snake_case 고유 식별자
  tier: 1 | 2 | 3           // 거점 등급
  name: string              // 역명
  region: "서울" | "경기" | "인천"
  district: string          // 구/시
  lines: string[]           // 노선 목록
  connectivity: 1~5         // 환승 노선 수 기반 접근성
  psychological: 1~5        // "여기서 보자" 납득도 (SNS 인지도 반영)
  vibeScore: 1~5            // 업종 다양성 (맛집/카페/술집/쇼핑 등)
  vibes: string[]           // 상권 성격 태그
  eveningTraffic:           // 저녁(18~22시) 하차 등급 [S1][S2]
    "very_high" | "high" | "medium" | "low"
  commerceGrade: "S"|"A"|"B" // 소상공인진흥공단 상권등급 추정 [S3]
  lat: number               // 위도
  lng: number               // 경도
  note: string              // 선정 근거 (출처 태그 포함)
}
```

---

## 활용 예시 (Cursor에서 바로 사용)

```typescript
import COMMERCE_HUBS from './commerce_hubs';

// 1. 두 출발지 사이의 중간 거점 후보 필터링
function getMidpointCandidates(
  originLat: number, originLng: number,
  destLat: number, destLng: number,
  options?: { maxTier?: number; minPsychological?: number }
) {
  const midLat = (originLat + destLat) / 2;
  const midLng = (originLng + destLng) / 2;
  const maxDist = haversine(originLat, originLng, destLat, destLng) * 0.6;

  return COMMERCE_HUBS
    .filter(h => (options?.maxTier ? h.tier <= options.maxTier : true))
    .filter(h => (options?.minPsychological ? h.psychological >= options.minPsychological : true))
    .filter(h => haversine(midLat, midLng, h.lat, h.lng) < maxDist)
    .sort((a, b) => a.tier - b.tier || b.psychological - a.psychological);
}

// 2. 특정 노선으로 접근 가능한 거점만 필터
const line4Hubs = COMMERCE_HUBS.filter(h => h.lines.some(l => l.includes('4호선')));

// 3. Vibe 기반 필터 (술자리 약속이면)
const drinkingSpots = COMMERCE_HUBS.filter(h =>
  h.vibes.includes('술집') && h.tier <= 2
);
```

---

## 통계 요약

- **총 거점:** 100개
- **서울:** 53개 / **경기:** 42개 / **인천:** 5개
- **eveningTraffic very_high:** 10개 (Tier1 전체 + 사당·신도림·건대)
- **connectivity 4이상:** 18개 (주요 광역 환승역)
- **commerceGrade S:** 10개 (Tier1 전체)
