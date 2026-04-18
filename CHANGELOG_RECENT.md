# 최근 변경 내역 요약

작성일 기준: Midpoint Navigator(쌤밋 · 중간지점 찾기) 저장소의 로컬 변경 사항을 정리한 문서입니다.

---

## 1. 링크 미리보기 (Open Graph / Twitter)

- **`index.html`**
  - `og:image`, `og:image:secure_url`, `og:image:type`, `og:image:alt`
  - `twitter:image`, `twitter:image:alt` (`summary_large_image`와 맞춤)
  - 이미지 URL은 배포 호스트 기준 절대 경로: `https://midpoint-navigator.vercel.app/og-image.png`
  - 커스텀 도메인만 쓸 경우 위 URL의 호스트를 실제 공개 URL에 맞게 바꾸는 것이 좋습니다.
- **`og-image.png`** (신규)
  - 소셜/카카오 링크 미리보기용 배너 이미지.
- **`Thumbnail.png`** (미추적)
  - 워크스페이스에 별도로 생긴 썸네일일 수 있음. 저장소에 포함할지 여부는 선택 사항입니다.

---

## 2. 결과 지도 UX (`src/main.js`)

- **중간지점 계산 완료 후**
  - 친구별로 **고정 색**으로 대중교통 경로 폴리라인 표시(ODsay `loadLane`).
  - 각 친구 **출발지 핀 + 이름 라벨** 표시.
  - 중간지점 마커·선정 이유 배지·인포윈도우 유지.
  - 경로 데이터가 없을 때는 후보·친구 좌표만으로 `fitBounds` 시도.
- **세부 내용 조회(시트)**
  - 상세 모드에서 전체 친구 핀은 잠시 숨기고, 선택한 친구 구간만 **환승 구간별 색**으로 표시.
  - `drawRouteOnMap` 완료 후 출발/도착 핀을 그리도록 **`await` 순서** 정리.
  - 시트 열 때 **`map.relayout()`**, 지도 영역 **`scrollIntoView`** 로 위쪽 지도가 함께 보이도록 처리.
  - 이전에 시트에서 후보 마커를 숨기던 동작은 제거(후보 지점이 계속 보이도록).
- **시트 닫기**
  - 상세 경로 오버레이 제거 후, 친구 핀 복원 및 **`lastOverviewItem` 기준으로 전체 색 경로 다시 그리기**.

- **구현 세부**
  - `appendPolylinesFromRaw`, `redrawMapOverviewRoutes`, `friendOverviewEntries` / `clearFriendOverviewPins` / `setFriendOverviewPinsVisible`
  - `clearMapObjects` 시 경로 오버레이·친구 핀까지 정리.

---

## 3. 하단 시트 레이아웃 (`index.html`)

- 경로 상세 패널에 **`max-h-[min(52vh,420px)]`**, **`overflow-y-auto`** 적용해 지도가 더 많이 보이도록 조정.

---

## 4. 서버·스크립트 (`server/apis.ts`, `scripts/test-odsay.js`)

- ODsay 호출 관련 **재시도**, **`ODSAY_WEB_ORIGIN` 처리**, 로그용 **URL 내 API 키 마스킹**(`maskApiKeyInUrl`) 등 운영·디버깅 보강.
- 테스트 스크립트에서도 로그에 키가 그대로 노출되지 않도록 맞춤.

*(정확한 diff는 `git diff` 로 확인하세요.)*

---

## Git 커밋·푸시 예시

저장소 루트는 **`Midpoint Navigator`** 디렉터리입니다.

```powershell
cd "c:\Users\cocak\OneDrive\OneSyncFiles\Obsidian\ZZ. Cursor\Midpoint Navigator"

git status
git add index.html src/main.js server/apis.ts scripts/test-odsay.js og-image.png CHANGELOG_RECENT.md
```

`Thumbnail.png` 를 같이 올릴 경우:

```powershell
git add Thumbnail.png
```

커밋 메시지 예시:

```powershell
git commit -m "feat(ui): 결과 지도에 친구별 경로·핀, OG 이미지 및 시트 개선

- OG/Twitter 메타 + og-image.png
- 계산 후 전체 친구 색 경로·출발 핀, 상세 시트 연동
- ODsay 로그 마스킹 및 관련 스크립트 정리
- CHANGELOG_RECENT.md 추가"
```

원격에 푸시:

```powershell
git push origin main
```

브랜치 이름이 `main` 이 아니면 해당 브랜치명으로 바꿉니다.

```powershell
git branch --show-current
```
