# API 키 체크리스트

## Kakao
- REST API 키 발급 완료
- JavaScript 키 발급 완료
- 허용 도메인 등록: `http://localhost:5173`, `http://localhost:4000`(로컬에서 Express로 띄울 때), `https://midpoint-navigator.vercel.app` 등 운영 도메인
- 쿼터/제한 확인: Local API 일 호출량

## ODsay
- API 키 발급 완료 (WEB/URI 키면 콘솔 도메인 = `https://midpoint-navigator.vercel.app`; 서버→ODsay `Origin` 기본값은 `server/constants/public_origins.ts`의 `PRODUCTION_FRONTEND_ORIGIN`, 필요 시 `ODSAY_WEB_ORIGIN`으로 덮어쓰기)
- 요금제 기준 일 호출량 확인
- 초당 요청 제한 확인 (기본값 서버 코드: 4 rps)

## 배포 전 검증
- `.env`에 실키 입력
- 브라우저 노출 금지: REST/ODsay 키는 서버에서만 사용
- 프론트에는 Kakao JS 키만 주입
