# 중간지점 대중교통 서비스 개발 리포트 (2026-04-16 23:27:57)

이 문서는 **대중교통 기반 중간지점 찾기 웹서비스**를 구현하면서 반영된 기능, 구조, 시행착오, 해결 과정을 대화 흐름 기준으로 정리한 리포트입니다.

---

## 목표/컨셉

- **입력**: 친구들의 거주지(주소/지명/역명)
- **출력**: 추천 중간지점(Top-N) + 친구별 대중교통 소요시간/경로
- **모드**
  - **균등(balanced)**: 전체의 공정성(편차 최소화) 우선, 초기 구현은 minimax 중심
  - **비균등(majority)**: 다수 평균시간 최소화(소수 outlier 희생 허용) + 환승/경로 제약을 패널티로 반영

---

## 최종 아키텍처(현 상태)

### 데이터/역할 분리

- **Kakao Local API (서버)**: 입력 텍스트 → 좌표(geocode), 지하철역 후보 검색
- **ODsay API (서버)**: 출발지↔후보지 대중교통 경로/시간, `mapObj` 기반 그래픽 데이터(loadLane)
- **Kakao Maps JS SDK (프론트)**: 지도 렌더링(마커/오버레이/폴리라인), 역지오코딩(가능할 때)

### 구성 요소

- **백엔드**: Express
  - 정적 파일 서빙 + API 제공
- **프론트**: 정적 HTML/JS
  - 입력 UI + 지도 + 후보 카드 + 바텀시트(상세 경로)

---

## 구현된 기능(주요)

### 1) 서버 정적 서빙 (Cannot GET / 해결)

- 현상: `http://localhost:4000/` 접속 시 `Cannot GET /`
- 해결: Express에 `express.static` 및 `/` 라우팅 추가

관련 파일:
- `server/index.ts`

---

### 2) 입력(주소/역명) → 좌표 변환 강화

- 현상: `범계역` 같은 입력에서 `Address not found`
- 원인: Kakao “주소 검색”만 사용하면 역명/장소명은 실패
- 해결: 주소 검색 실패 시 **키워드 검색**으로 fallback

관련 파일:
- `server/apis.ts` (`geocodeAddress`)

---

### 3) ODsay 경로 검색 안정화(방어적 파싱/로그)

#### 3-1) 좌표/파라미터 순서 검증

- Kakao 결과 `x=경도(lng)`, `y=위도(lat)`를 올바르게 매핑
- ODsay 파라미터도 `SX=lng`, `SY=lat`, `EX=lng`, `EY=lat`로 전달

#### 3-2) 응답 구조 방어 처리

- ODsay는 `result.path`가 없을 수 있고, `error`가 배열로 오기도 함
- 에러/빈 path 케이스를 명확히 분기하고 로그/메시지를 강화

#### 3-3) 디버그 로그 강화(원인 추적)

- Kakao로부터 얻은 출발 좌표 로그
- ODsay 요청 URL(키 제외/포함 등 단계별) 및 전체 응답 JSON 출력

관련 파일:
- `server/apis.ts`
- `server/midpointService.ts`

---

### 4) ODsay 인증 이슈(해결 과정)

#### 4-1) “경로 없음”처럼 보이던 실제 원인

- 실제 응답: `ApiKeyAuthFailed` (인증 실패)
- 초기에 응답 파싱이 단순해서 인증 실패를 path 없음으로 오인할 여지가 있었음

#### 4-2) 키 인코딩/플랫폼 이슈 논의

- 키에 `/` 등의 특수문자가 포함될 수 있어 **문서상 URI 인코딩 권장**
- 또한 ODsay 콘솔에서 플랫폼 설정(URI/Server(IP))에 따른 제약이 있어, 로컬 개발 시 공인 IP/플랫폼 설정 혼선이 있었음

#### 4-3) 단독 테스트 도구 제공

- 백엔드 로직을 우회하고 “키만으로 ODsay 호출”하는 테스트 스크립트 추가

관련 파일:
- `scripts/test-odsay.js`
- `package.json` (`test:odsay` 스크립트)

---

### 5) 호출량 폭증(429 Too Many Requests) 대응

현상:
- 후보×친구 조합을 전수 평가하면 호출량이 쉽게 커짐
- 버튼 반복 클릭 + 재시도까지 합쳐지면 400회 이상도 가능

해결(서버/클라이언트 동시 적용):
- **재시도(backoff) + 429 방어** (서버)
- 프론트 기본 후보 수 감소 (클라이언트)
- 호출량 자체를 줄이는 알고리즘 변경(아래 6번)

관련 파일:
- `server/apis.ts` (재시도/레이트리밋/캐시)
- `src/main.js` (옵션 기본값)

---

### 6) 중간지점 탐색 알고리즘 최적화(호출 최소화)

적용된 최적화:
- **2단계 탐색**: 직선거리 기반 rough score로 1차 후보 축소 후 정밀 평가
- **Early stop**: 이미 최적보다 불리한 후보는 평가 중단
- **API 호출 예산(maxApiCalls)**: 요청당 호출 상한 도입
- 디버깅용 통계 로그: 후보 수/shortlist 수/실제 평가 수/호출 수/소요 시간(ms)

관련 파일:
- `server/midpointService.ts`
- `server/types.ts` (옵션 확장)

---

### 7) 지하철역 중심 후보 + 원거리 빨간버스 트래킹

목표:
- “중간지점은 우선 지하철역 중심”으로 탐색
- 다만 원거리(예: 경기 외곽) 친구가 과도하게 불리할 때는, 그 친구에게 빨간버스가 유리한 후보를 2차로 선호

구현:
- **Kakao 카테고리 검색(SW8)**으로 지하철역 후보 생성
- 후보 평가 후 “원거리 친구” 경로 raw에 빨간버스(예: `9xxx`, `M버스`)가 포함되면 점수 보정
- 지하철 후보가 없으면 grid 후보로 fallback

관련 파일:
- `server/apis.ts` (`searchSubwayStationCandidates`)
- `server/midpointService.ts` (`hasExpressRedBus` 및 점수 보정)

---

### 8) Kakao 지도 SDK 로딩/401 문제 해결(중요 시행착오)

#### 8-1) 로딩 타이밍/SDK 미준비

- `coord2Address` undefined 등의 타이밍 이슈 발생
- 지도 준비와 Geocoder 준비를 분리하고, 미준비 시 좌표 fallback 처리

#### 8-2) sdk.js Network에 안 뜨는 문제

- 원인 진단을 위해 SDK를 **동적 삽입** 방식으로 변경하여 Network에서 요청을 강제로 확인 가능하게 함

#### 8-3) sdk.js 401(Unauthorized)

- 원인: 도메인을 `제품 링크 관리 > 웹 도메인`에 등록했지만 **지도 SDK는 별도 설정 필요**
- 해결: 공식 문서 확인 후
  - `플랫폼키 > JavaScript 키 > JavaScript SDK 도메인`에 `http://localhost:4000` 등록
  - 즉시 401 해결, 지도 정상 표시

관련 파일:
- `src/main.js` (`/api/public-config`로 키를 받아 SDK 동적 로드)
- Kakao 콘솔 설정(운영 절차)

---

### 9) UI: 후보 표시 + 바텀시트(모바일 친화) 상세 경로

초기:
- JSON/점수 등 디버깅 정보가 과다 노출

개선:
- 후보 카드: 친구별 소요시간(분/환승) 중심으로 간단히 표시
- 상세는 **바텀시트(Bottom Sheet)**로 분리하여 모바일에서 비교/상세가 깔끔하게 동작
- 친구 선택 드롭다운으로 상세 경로 전환

관련 파일:
- `index.html`
- `src/main.js`

---

### 10) 상세 경로 지도 시각화(폴리라인)

구현 방식:
- ODsay `searchPubTransPathT` 응답의 `mapObj` 추출
- 서버 프록시: `GET /api/odsay/loadLane?mapObj=...`
- `graphPos` 좌표를 Kakao Polyline으로 렌더링
- **구간 색상 차등**(lane type 기반)

관련 파일:
- `server/apis.ts` (`loadLane`, 캐시)
- `server/index.ts` (`/api/odsay/loadLane`)
- `src/main.js` (`drawRouteOnMap`)

---

### 11) 경로 화면 전환 UX(가시성 정리)

- 바텀시트 오픈 시: Top1~3 추천 마커/인포윈도우 숨김
- 닫을 때: 추천 마커 복구
- 경로 변경/닫기 시: 폴리라인/마커/라벨 오버레이 정리

관련 파일:
- `src/main.js`

---

### 12) 출발/도착 마커 + 텍스트 배지

- 출발(친구) 마커: 파랑 SVG 핀
- 도착(중간지점) 마커: 보라 SVG 핀
- 마커 상단 텍스트 배지(CustomOverlay):
  - `출발(친구이름)`
  - `도착(역이름)`

구현을 위해 서버 응답에 출발 좌표를 포함:
- `CandidateEvaluation.perFriend[]`에 `startPoint` 추가

관련 파일:
- `server/types.ts`
- `server/midpointService.ts`
- `index.html` (배지 스타일)
- `src/main.js`

---

## 주요 API 엔드포인트(현 상태)

- `GET /` : 프론트 진입점
- `GET /api/health` : 헬스 체크
- `GET /api/public-config` : 프론트용 공개 설정(현재 Kakao JS 키)
- `POST /api/midpoint` : 중간지점 계산
- `GET /api/odsay/loadLane?mapObj=...` : 경로 그래픽(폴리라인) 데이터 프록시

---

## 핵심 코드/파일 맵

- 백엔드
  - `server/index.ts`: 라우팅/정적서빙/공개설정/ODsay 프록시
  - `server/apis.ts`: Kakao(지오코드/지하철 후보), ODsay(경로/그래픽)
  - `server/midpointService.ts`: 후보 생성/평가(2단계/early stop/budget), 점수 보정
  - `server/scoring.ts`: balanced/majority 점수식
  - `server/cache.ts`, `server/rateLimiter.ts`: TTL 캐시/레이트리밋

- 프론트
  - `index.html`: 입력 UI, 지도 영역, 바텀시트 UI, 스타일
  - `src/main.js`: SDK 로드, 후보 렌더링, 바텀시트, 폴리라인/마커/오버레이

---

## 다음 단계 제안(현 상태 기준)

- **친구별 상세 경로를 더 풍부하게**
  - 정류장/환승/도보 구간을 더 정교하게 표시
  - “지도 위 구간별(도보/버스/지하철) 스타일 차등” 강화
- **후보 생성 고도화**
  - 지하철역 후보 반경/페이지/정렬 튜닝
  - 주요 환승역 가중치/클러스터 기반 후보 강화
- **모드/옵션 UI화**
  - `refineCandidates`, `maxApiCalls`, outlier 관련 파라미터를 UI 슬라이더로 노출
- **운영 안정성**
  - 디버그 로그/민감 정보 노출 최소화(특히 API 키/원본 응답 로그)
  - 캐시 키 전략(시간대 버킷 등) 개선

---

## 비고(중요한 교훈)

- Kakao 콘솔의 **제품 링크 도메인**과 **JavaScript SDK 도메인**은 목적이 다르며, 지도 SDK 401은 후자 설정이 핵심이었다.
- ODsay는 호출량이 쉽게 폭증하므로 “후보 전수 평가”는 과금/제한 측면에서 불리하고, 탐색 최적화(2단계/early stop/budget)와 캐시가 필수다.

