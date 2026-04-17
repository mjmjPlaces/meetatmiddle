# Deploy Checklist (Vercel + Railway)

이 문서는 실제 배포/수익화 준비 시, **사용자가 직접 해야 하는 작업**만 모아둔 체크리스트입니다.

## 1) 저장소/GitHub

- [ ] 프로젝트 코드를 GitHub에 push
- [ ] (선택) 프론트/백 분리 저장소로 운영할지 결정

### 1) 첫 push 절차 (로컬 → GitHub)

프로젝트 폴더: `Midpoint Navigator`에서 PowerShell 실행.

1. `.gitignore`로 `.env` / `node_modules` 제외 확인 (저장소에 이미 포함됨).
2. 아직 Git이 없으면 초기화:

```powershell
cd "C:\Users\cocak\OneDrive\OneSyncFiles\Obsidian\ZZ. Cursor\Midpoint Navigator"
git init
git branch -M main
```

3. 원격 저장소 연결 (GitHub에서 만든 repo URL로 교체):

```powershell
git remote add origin https://github.com/<계정>/<저장소이름>.git
```

4. 커밋 후 push:

```powershell
git add .
git status
git commit -m "Initial commit: Midpoint Navigator"
git push -u origin main
```

5. 이미 원격에 README만 있는 경우:

```powershell
git pull origin main --allow-unrelated-histories
# 충돌 나면 해결 후
git push -u origin main
```

**참고**: 현재 구조는 **단일 저장소(프론트+백엔드 동일 repo)** 로 배포하기 적합합니다. Vercel/Railway는 같은 repo의 다른 Root/Build 설정으로 나눌 수 있습니다.

### 원클릭 스크립트 (저장소: `mjmjPlaces/meetatmiddle`)

프로젝트 루트에서 PowerShell:

```powershell
cd "C:\Users\cocak\OneDrive\OneSyncFiles\Obsidian\ZZ. Cursor\Midpoint Navigator"
powershell -ExecutionPolicy Bypass -File .\scripts\git-first-push.ps1
```

- Git이 PATH에 없으면 [Git for Windows](https://git-scm.com/download/win) 설치 후 다시 실행합니다.
- `push`가 거절되면 위 체크리스트 5번(원격 README 병합)을 따릅니다.

## 2) Railway (Backend)

- [ ] Railway 프로젝트 생성 + GitHub 연결
- [ ] Public URL 발급 확인 (`https://<service>.up.railway.app`)

### Railway 환경변수

- [ ] `NODE_ENV=production`
- [ ] `PORT=4000`
- [ ] `KAKAO_REST_API_KEY=...`
- [ ] `KAKAO_JS_KEY=...`
- [ ] `ODSAY_API_KEY=...`
- [ ] `DAILY_ODSAY_BUDGET=15000` (원하는 값으로 조정)
- [ ] `ALLOWED_ORIGINS=https://<prod-domain>,https://<www-domain>,https://<vercel-preview-domain>`
- [ ] **WEB 키 사용 시** `ODSAY_WEB_ORIGIN=https://<vercel-프로덕션-도메인>` (끝 `/` 없이) — ODsay 콘솔에 등록한 URI와 **동일**해야 함. **`ALLOWED_ORIGINS`와는 별개**(CORS용 vs ODsay 호출 시 `Origin`/`Referer`용). 미설정 시 production에서는 코드 기본값(`server/constants/public_origins.ts`의 `PRODUCTION_FRONTEND_ORIGIN`)을 사용.

## 3) Vercel (Frontend)

- [ ] Vercel 프로젝트 생성 + GitHub 연결
- [ ] 프로덕션/프리뷰 도메인 확인

### Vercel 프로젝트 설정 (이 레포 기준)

저장소 루트에 `vercel.json`이 있으면 빌드/출력/API 프록시가 여기에 맞춰집니다.

- **Root Directory**: `./` (또는 비움)
- **Framework Preset**: **Other** (자동으로 Next 등으로 잡히면 수동으로 Other로 변경)
- **Install Command**: `npm install --include=dev` (`vercel.json`에 반영됨 — `tsc`가 `devDependencies`에 있어서 필요)
- **Build Command**: `npm run build` (`vercel.json`에 반영됨)
- **Output Directory**: `.` (루트의 `index.html`, `src/` 등을 그대로 배포)

### API 경로

프론트(Vercel)와 API(Railway)가 **도메인이 다르므로**, 브라우저는 `src/main.js`의 `RAILWAY_API_ORIGIN`으로 Railway에 **직접** `fetch`합니다.  
Railway 공개 URL이 바뀌면 해당 상수를 수정한 뒤 다시 배포합니다.  
CORS는 Railway `ALLOWED_ORIGINS`에 Vercel 도메인을 넣어 두면 됩니다.

### Railway `ALLOWED_ORIGINS`

Vercel 프로덕션·프리뷰 URL을 콤마로 추가합니다. 예:

`https://meetatmiddle-production.up.railway.app,https://midpoint-navigator.vercel.app`

- **끝에 `/` 넣지 않기** — 브라우저 `Origin` 헤더는 슬래시 없이 옵니다 (`https://midpoint-navigator.vercel.app`).
- 값 수정 후 Railway가 **재배포**될 때까지 잠시 기다리기.
- 서버 로그에 `[cors] allowed origins:` 로 실제 반영 여부 확인 가능.

(프리뷰 URL은 호스트가 매번 다를 수 있어, 필요할 때마다 동일 형식으로 추가.)

## 4) Kakao / ODsay 콘솔 설정

### Kakao Developers

- [ ] `앱 > 플랫폼키 > JavaScript 키 > JavaScript SDK 도메인` 등록
- [ ] `http://localhost:4000`
- [ ] `https://<prod-domain>`
- [ ] `https://<www-domain>`
- [ ] `https://<vercel-preview-domain>` (필요 시)

### ODsay

- [ ] API Key 활성 상태 확인
- [ ] 허용 정책/쿼터/요금제 확인
- [ ] **URI(WEB) 키**: 콘솔에 등록한 도메인 = Railway의 `ODSAY_WEB_ORIGIN` (보통 Vercel URL). **Server(IP) 키**: egress IP 등록 — `ODSAY_WEB_ORIGIN` 불필요.

## 5) 도메인 / DNS / HTTPS

- [ ] 도메인 구매 (Gabia/Namecheap 등)
- [ ] 프론트 도메인 Vercel 연결 (`www.<domain>` 또는 루트)
- [ ] 백엔드 도메인 Railway 연결 (`api.<domain>` 권장)
- [ ] HTTPS 정상 발급 확인

## 6) 보안 / 운영 점검

- [ ] `.env`가 Git에 올라가지 않는지 확인 (`.gitignore`)
- [ ] 키 노출 커밋 이력 없는지 점검
- [ ] `/api/ops/metrics` 정상 응답 확인
- [ ] `degradedMode` 90% 임계 동작 확인

## 7) 비용 알림

- [ ] Vercel 사용량/결제 알림 설정
- [ ] Railway Spending Limit/알림 설정
- [ ] ODsay 월간 호출량 모니터링 기준 수립

---

## 빠른 재시작 순서 (프로젝트 재개 시)

1. `DEPLOY_CHECKLIST.md` 확인
2. Railway 환경변수/도메인 상태 확인
3. Vercel 환경변수/빌드 상태 확인
4. `/api/ops/metrics`로 운영 상태 점검
