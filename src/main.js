const friendsEl = document.getElementById("friends");
const addFriendBtn = document.getElementById("addFriend");
const runBtn = document.getElementById("run");
const resultEl = document.getElementById("result");
const cardsEl = document.getElementById("cards");
const searchPanelEl = document.getElementById("searchPanel");
const backToSearchBtnEl = document.getElementById("backToSearch");
const mapEl = document.getElementById("map");
const mapWrapEl = document.getElementById("mapWrap");
const mapStatusEl = document.getElementById("mapStatus");
const sheetBackdropEl = document.getElementById("sheetBackdrop");
const sheetEl = document.getElementById("sheet");
const sheetCloseEl = document.getElementById("sheetClose");
const sheetTitleEl = document.getElementById("sheetTitle");
const sheetSubtitleEl = document.getElementById("sheetSubtitle");
const pathListEl = document.getElementById("pathList");
const friendTimeListEl = document.getElementById("friendTimeList");
const locateBtnEl = document.getElementById("locateBtn");
const stickyShareBtnEl = document.getElementById("stickyShare");
const stationPlaceholders = [
  "ex. 신도림역",
  "ex. 문정역",
  "ex. 사당역",
  "ex. 왕십리역",
  "ex. 합정역",
  "ex. 잠실역"
];

/** Vercel은 정적 호스팅만 하고 API는 Railway에서 제공. 같은 호스트가 아니면 Railway URL로 직접 호출 (CORS는 ALLOWED_ORIGINS로 허용). */
const RAILWAY_API_ORIGIN = "https://meetatmiddle-production.up.railway.app";
const PUBLIC_SHARE_ORIGIN = "https://samemeet.com";

function isLocalLikeHost(hostname) {
  if (!hostname) return false;
  const host = hostname.trim().toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) {
    return true;
  }
  // Mobile-on-LAN testing often uses private IP hosts.
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

function apiUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  const h = window.location.hostname;
  const apiOnSameHost =
    h === "localhost" || h === "127.0.0.1" || h.endsWith(".up.railway.app");
  if (apiOnSameHost) return p;
  return `${RAILWAY_API_ORIGIN}${p}`;
}

function shareApiUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (isLocalLikeHost(window.location.hostname)) return `${RAILWAY_API_ORIGIN}${p}`;
  return apiUrl(p);
}

let map;
let geocoder;
let markers = [];
let isMapReady = false;
let mapInitTried = false;
let pendingResultsForMap = null;
let sdkInjected = false;
let lastResults = [];
let routePolylines = [];
let markersHiddenForSheet = false;
let routeMarkers = [];
let routeLabelOverlays = [];
/** 추천 지점 통합 카드(제목·주소·선정 이유 한 박스) */
let candidateRecommendOverlay = null;
let candidatePulseOverlay = null;
let recommendOverlayIdleHandler = null;
let kakaoJsKey = "";
let lastSharePayload = null;
let lastShareErrorDetail = "";
/** 상세 시트를 닫은 뒤 전체 경로를 다시 그릴 때 사용 */
let lastOverviewItem = null;
/** 결과 화면에서 친구 출발지 핀(세부 경로 모드에서는 잠시 숨김) */
let friendOverviewEntries = [];
let midpointLoadingTimer = null;
let midpointLoadingProgress = 0;
let currentShareSessionId = "";
const selectionRecordedBySid = new Set();

const FRIEND_ROUTE_COLORS = ["#E53935", "#1E88E5", "#43A047", "#FB8C00", "#8E24AA", "#00897B"];

function friendRouteColor(index) {
  return FRIEND_ROUTE_COLORS[index % FRIEND_ROUTE_COLORS.length];
}

/**
 * public-config fetch + dapi 스크립트 onload까지 await 한 뒤 maps.load로 지도를 연다.
 * (이전: fetch가 느리면 5초 폴링이 먼저 끝나 SDK가 늦게 와도 init이 영원히 안 돌 수 있음)
 */
async function injectKakaoSdk() {
  if (sdkInjected) return;
  sdkInjected = true;
  mapStatusEl.textContent = "Kakao SDK 스크립트 요청 중...";

  try {
    const res = await fetch(apiUrl("/api/public-config"));
    const data = await res.json();
    kakaoJsKey = data?.kakaoJsKey || "";
  } catch {
    kakaoJsKey = "";
  }
  if (!kakaoJsKey) {
    mapStatusEl.textContent =
      "Kakao JS 키를 가져오지 못했습니다. 서버의 KAKAO_JS_KEY 설정을 확인해 주세요.";
    return;
  }

  const script = document.createElement("script");
  const cacheBust = Date.now();
  script.src =
    "https://dapi.kakao.com/v2/maps/sdk.js" +
    `?appkey=${encodeURIComponent(kakaoJsKey)}` +
    "&libraries=services" +
    "&autoload=false" +
    `&_=${cacheBust}`;
  script.async = true;

  try {
    await new Promise((resolve, reject) => {
      script.onload = () => {
        window.__onKakaoSdkLoad?.();
        mapStatusEl.textContent = "Kakao SDK 로드 완료. 초기화 중...";
        resolve();
      };
      script.onerror = () => {
        window.__onKakaoSdkError?.();
        mapStatusEl.textContent =
          window.__kakaoSdk?.errorDetail ||
          "브라우저가 Kakao SDK 스크립트를 로드하지 못했습니다.";
        reject(new Error("kakao maps script failed"));
      };
      document.head.appendChild(script);
    });
  } catch {
    return;
  }

  if (!window.kakao?.maps?.load) {
    mapStatusEl.textContent = "Kakao maps API(load)를 찾지 못했습니다. 도메인 허용·스크립트 차단을 확인해 주세요.";
    return;
  }
  kakao.maps.load(() => {
    initMap();
    requestAnimationFrame(() => {
      try {
        map?.relayout?.();
      } catch {
        // ignore
      }
    });
  });
}

async function ensureKakaoShareReady() {
  if (!kakaoJsKey) {
    lastShareErrorDetail = "서버에서 KAKAO_JS_KEY를 내려주지 못했습니다.";
    return false;
  }
  if (window.Kakao?.isInitialized?.()) return true;

  if (!document.querySelector('script[data-kakao-share-sdk="1"]')) {
    const shareScript = document.createElement("script");
    shareScript.src = "https://t1.kakaocdn.net/kakao_js_sdk/2.7.4/kakao.min.js";
    shareScript.dataset.kakaoShareSdk = "1";
    document.head.appendChild(shareScript);
    const loaded = await new Promise((resolve) => {
      shareScript.onload = resolve;
      shareScript.onerror = () => resolve(false);
    });
    if (!loaded) {
      lastShareErrorDetail = "카카오 공유 SDK 스크립트 로드에 실패했습니다.";
      return false;
    }
  }

  if (!window.Kakao) {
    lastShareErrorDetail = "window.Kakao 객체를 찾지 못했습니다.";
    return false;
  }
  if (!window.Kakao.isInitialized()) {
    try {
      window.Kakao.init(kakaoJsKey);
    } catch (error) {
      lastShareErrorDetail = `Kakao.init 실패: ${String(error)}`;
      return false;
    }
  }
  lastShareErrorDetail = "";
  return window.Kakao.isInitialized();
}

function initMap() {
  if (isMapReady) return;
  if (!window.kakao?.maps) return;
  const initialCenter = new kakao.maps.LatLng(37.5665, 126.978);
  map = new kakao.maps.Map(mapEl, {
    center: initialCenter,
    level: 8
  });
  isMapReady = true;
  if (kakao.maps.services?.Geocoder) {
    geocoder = new kakao.maps.services.Geocoder();
    mapStatusEl.textContent = "지도 준비 완료. (주소 변환 가능) 마커를 표시할 수 있습니다.";
  } else {
    mapStatusEl.textContent =
      "지도 준비 완료. (주소 변환 미사용) 마커를 표시할 수 있습니다.";
  }
  if (pendingResultsForMap?.results?.length) {
    void renderTopCandidates(pendingResultsForMap.results, pendingResultsForMap.options || {});
    pendingResultsForMap = null;
  }
}

function ensureMapReady() {
  if (isMapReady || mapInitTried) return;
  mapInitTried = true;
  mapStatusEl.textContent = "지도 SDK 로딩 중...";
  void injectKakaoSdk();
}

function clearFriendOverviewPins() {
  friendOverviewEntries.forEach(({ marker, overlay }) => {
    marker.setMap(null);
    overlay.setMap(null);
  });
  friendOverviewEntries = [];
}

function setFriendOverviewPinsVisible(visible) {
  friendOverviewEntries.forEach(({ marker, overlay }) => {
    marker.setMap(visible ? map : null);
    overlay.setMap(visible ? map : null);
  });
}

function clearCandidateRecommendOverlay() {
  if (recommendOverlayIdleHandler && map && window.kakao?.maps?.event?.removeListener) {
    kakao.maps.event.removeListener(map, "idle", recommendOverlayIdleHandler);
    recommendOverlayIdleHandler = null;
  }
  if (candidateRecommendOverlay) {
    candidateRecommendOverlay.setMap(null);
    candidateRecommendOverlay = null;
  }
  if (candidatePulseOverlay) {
    candidatePulseOverlay.setMap(null);
    candidatePulseOverlay = null;
  }
}

function setCandidateRecommendOverlayVisible(visible) {
  if (candidateRecommendOverlay) {
    candidateRecommendOverlay.setMap(visible ? map : null);
  }
}

function clearMapObjects() {
  clearRouteOverlay();
  clearFriendOverviewPins();
  clearCandidateRecommendOverlay();
  markers.forEach((marker) => marker.setMap(null));
  markers = [];
}

function updateStickyShareButton() {
  if (!stickyShareBtnEl) return;
  const isSheetOpen = sheetEl?.style?.display === "block";
  if (!lastSharePayload || isSheetOpen) {
    stickyShareBtnEl.classList.add("hidden");
    stickyShareBtnEl.disabled = true;
    return;
  }
  stickyShareBtnEl.classList.remove("hidden");
  stickyShareBtnEl.disabled = false;
}

function setSearchViewVisible(visible) {
  if (searchPanelEl) {
    searchPanelEl.style.display = visible ? "" : "none";
  }
  if (backToSearchBtnEl) {
    backToSearchBtnEl.classList.toggle("hidden", visible);
  }
}

function stopMidpointLoadingIndicator() {
  if (midpointLoadingTimer) {
    clearInterval(midpointLoadingTimer);
    midpointLoadingTimer = null;
  }
}

function renderResultSkeleton(message = "중간지점 후보를 계산하는 중…") {
  cardsEl.innerHTML = `
    <div class="resultSkeletonCard app-fade" aria-hidden="true">
      <div class="resultSkeletonProgressWrap">
        <div class="resultSkeletonProgressFill" style="width:0%"></div>
      </div>
      <div class="resultSkeletonProgressLabel">진행률 0%</div>
      <div class="resultSkeletonLine w-36" style="animation-delay:0ms"></div>
      <div class="resultSkeletonLine w-[72%]" style="animation-delay:120ms"></div>
      <div class="resultSkeletonLine w-[58%]" style="animation-delay:220ms"></div>
      <div class="resultSkeletonDivider"></div>
      <div class="resultSkeletonLine w-[88%]" style="animation-delay:340ms"></div>
      <div class="resultSkeletonLine w-[64%]" style="animation-delay:440ms"></div>
      <div class="resultSkeletonPulseDot" aria-hidden="true"></div>
    </div>
  `;
  resultEl.textContent = message;
}

function updateMidpointLoadingProgress(nextValue) {
  midpointLoadingProgress = Math.max(0, Math.min(100, Math.round(nextValue)));
  const fillEl = cardsEl.querySelector(".resultSkeletonProgressFill");
  if (fillEl) fillEl.style.width = `${midpointLoadingProgress}%`;
  const labelEl = cardsEl.querySelector(".resultSkeletonProgressLabel");
  if (labelEl) labelEl.textContent = `진행률 ${midpointLoadingProgress}%`;
}

function startMidpointLoadingIndicator() {
  stopMidpointLoadingIndicator();
  midpointLoadingProgress = 0;
  const phases = [
    "중간지점 계산 중… (1/4 친구별 이동시간을 수집하는 중)",
    "중간지점 계산 중… (2/4 후보 지점을 정렬하는 중)",
    "중간지점 계산 중… (3/4 최적 후보를 비교하는 중)",
    "중간지점 계산 중… (4/4 결과 카드를 준비하는 중)"
  ];
  let idx = 0;
  updateMidpointLoadingProgress(0);
  resultEl.textContent = phases[idx];
  midpointLoadingTimer = setInterval(() => {
    idx = (idx + 1) % phases.length;
    const delta = midpointLoadingProgress < 55 ? 7 : midpointLoadingProgress < 80 ? 4 : 2;
    updateMidpointLoadingProgress(Math.min(95, midpointLoadingProgress + delta));
    resultEl.textContent = phases[idx];
  }, 1100);
}

function setCandidateMarkersVisible(visible) {
  markersHiddenForSheet = !visible;
  markers.forEach((m) => m.setMap(visible ? map : null));
}

function clearRouteOverlay() {
  routePolylines.forEach((pl) => pl.setMap(null));
  routePolylines = [];
  routeMarkers.forEach((m) => m.setMap(null));
  routeMarkers = [];
  routeLabelOverlays.forEach((o) => o.setMap(null));
  routeLabelOverlays = [];
}

function buildReasonSummary(item) {
  const routes = item?.perFriend ?? [];
  if (!routes.length) return "이동시간 균형 우수";
  const allZeroTransfer = routes.every((r) => Number(r?.route?.transferCount ?? 0) === 0);
  if (allZeroTransfer) return "모두 환승 0회";

  const minutes = routes.map((r) => Number(r?.route?.totalMinutes ?? 0));
  const min = Math.min(...minutes);
  const max = Math.max(...minutes);
  const avg = minutes.reduce((a, b) => a + b, 0) / minutes.length;
  if (max - min <= 15) return "이동시간 편차 최소";
  if (avg <= 40) return "평균 이동시간 우수";
  return "다수 이동시간 최적";
}

function recommendationStrengthLabel(tier) {
  if (tier === 1) return "아주 추천";
  if (tier === 2) return "추천";
  return "무난";
}

function suitabilityLabel(tier, isPriority) {
  if (tier === 1 || tier === 2) return "높음";
  if (tier === 3 || isPriority) return "보통";
  return "참고";
}

function hotplaceAccessibilityLabel(item) {
  const tier = item?.candidate?.tier;
  const spread = Math.round((item?.maxMinutes ?? 0) - (item?.averageMinutes ?? 0));
  if (tier === 1) return "상권 활발";
  if (spread <= 10) return "균형형";
  if (tier === 2 || tier === 3) return "접근성 좋음";
  return "균형형";
}

function meetingIndexScore(item) {
  const avg = Number(item?.averageMinutes ?? 0);
  const max = Number(item?.maxMinutes ?? 0);
  const spreadPenalty = Math.max(0, max - avg) * 0.9;
  const tierBoost = item?.candidate?.tier === 1 ? 8 : item?.candidate?.tier === 2 ? 5 : item?.candidate?.tier === 3 ? 2 : 0;
  const raw = 100 - avg * 0.7 - spreadPenalty + tierBoost;
  return Math.max(35, Math.min(98, Math.round(raw)));
}

function toBase64Url(value) {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  encoded.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(token) {
  const b64 = token.replaceAll("-", "+").replaceAll("_", "/");
  const padded = `${b64}${"=".repeat((4 - (b64.length % 4 || 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function buildShareUrls(payload) {
  // Always publish Kakao share links to production domain for consistency.
  const shareOrigin = PUBLIC_SHARE_ORIGIN;
  const base = `${shareOrigin}/`;
  const token = encodeURIComponent(toBase64Url(payload));
  const rootUrl = `${base}?share=${token}`;
  return {
    rootUrl,
    mapUrl: `${rootUrl}&view=map`,
    friendRouteUrl: `${rootUrl}&view=friends`
  };
}

/** 공유 카드에 넣는 웹 오리진(로컬에서 공유해도 수신자는 프로덕션으로 연결) */
function shareLinkOrigin() {
  return isLocalLikeHost(window.location.hostname) ? PUBLIC_SHARE_ORIGIN : window.location.origin;
}

/**
 * sid는 짧은 경로 `/s/:sid`에 두고, 만료·API 실패 시를 대비한 페이로드는 `#share=`에 둔다.
 * (카카오 인앱 등에서 긴 쿼리가 잘리는 경우가 있어 쿼리 `share`에만 의존하지 않음)
 */
function buildShareUrlsFromSid(sid, fallbackPayload = null) {
  const origin = shareLinkOrigin();
  const enc = encodeURIComponent(sid);
  const hash =
    fallbackPayload != null
      ? `#share=${encodeURIComponent(toBase64Url(fallbackPayload))}`
      : "";
  const base = `${origin}/s/${enc}`;
  return {
    rootUrl: `${base}${hash}`,
    mapUrl: `${base}?view=map${hash}`,
    friendRouteUrl: `${base}?view=friends${hash}`
  };
}

/** 카카오 링크 필드 길이 제한(초과 시 전송 실패). #share= 해시 제거 후에도 길면 카카오맵 링크로 대체(긴 ?share= 잘라내기 방지). */
const KAKAO_LINK_URL_MAX = 1000;

function clipUrlsForKakaoShare(urls, mapFallbackUrl) {
  const trimOne = (u) => {
    if (!u || typeof u !== "string") return u;
    if (u.length <= KAKAO_LINK_URL_MAX) return u;
    const noHash = u.split("#")[0];
    if (noHash.length <= KAKAO_LINK_URL_MAX) return noHash;
    return mapFallbackUrl;
  };
  return {
    rootUrl: trimOne(urls.rootUrl),
    mapUrl: trimOne(urls.mapUrl),
    friendRouteUrl: trimOne(urls.friendRouteUrl)
  };
}

function truncateKakaoField(text, maxChars) {
  const s = String(text ?? "").replace(/\r\n/g, "\n");
  if (s.length <= maxChars) return s;
  if (maxChars <= 1) return "…";
  return `${s.slice(0, maxChars - 1)}…`;
}

async function createShareSession(payload) {
  try {
    const res = await fetch(shareApiUrl("/api/share"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) return "";
    const data = await res.json();
    return String(data?.sid ?? "");
  } catch {
    return "";
  }
}

async function recordSessionSelection(candidate, source = "card_click") {
  const sid = currentShareSessionId || readSidFromLocation() || "";
  const selectedPlaceId = String(candidate?.id ?? candidate?.name ?? "").trim();
  if (!sid || !selectedPlaceId || selectionRecordedBySid.has(`${sid}:${selectedPlaceId}`)) return;
  try {
    const res = await fetch(shareApiUrl(`/api/v1/sessions/${encodeURIComponent(sid)}/select`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedPlaceId,
        selectedPlaceName: candidate?.name ?? "",
        lat: candidate?.lat,
        lng: candidate?.lng,
        source
      })
    });
    if (res.ok) {
      selectionRecordedBySid.add(`${sid}:${selectedPlaceId}`);
    }
  } catch {
    // non-blocking analytics write
  }
}

async function recordSessionShared(sid) {
  if (!sid) return;
  try {
    await fetch(shareApiUrl(`/api/v1/sessions/${encodeURIComponent(sid)}/share`), {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
  } catch {
    // non-blocking analytics write
  }
}

function buildCompactSharePayload(item, address, reasonText) {
  return {
    item: {
      candidate: {
        name: item?.candidate?.name,
        lat: item?.candidate?.lat,
        lng: item?.candidate?.lng,
        tier: item?.candidate?.tier,
        isPriority: item?.candidate?.isPriority,
        shiftedFrom: item?.candidate?.shiftedFrom
      },
      averageMinutes: item?.averageMinutes,
      maxMinutes: item?.maxMinutes,
      perFriend: (item?.perFriend ?? []).map((pf) => ({
        friendId: pf?.friendId,
        friendName: pf?.friendName,
        friendAddress: pf?.friendAddress,
        startPoint: pf?.startPoint,
        route: {
          totalMinutes: pf?.route?.totalMinutes,
          transferCount: pf?.route?.transferCount
        }
      }))
    },
    address,
    reasonText
  };
}

function buildTinyShareFallbackPayload(item, address, reasonText) {
  return {
    item: {
      candidate: {
        name: item?.candidate?.name,
        lat: item?.candidate?.lat,
        lng: item?.candidate?.lng
      },
      averageMinutes: item?.averageMinutes,
      maxMinutes: item?.maxMinutes,
      perFriend: []
    },
    address,
    reasonText
  };
}

function readSidFromLocation() {
  const pathMatch = window.location.pathname.match(/^\/s\/([^/]+)\/?$/);
  if (pathMatch?.[1]) {
    try {
      return decodeURIComponent(pathMatch[1]);
    } catch {
      return pathMatch[1];
    }
  }
  return new URLSearchParams(window.location.search).get("sid");
}

function readShareTokenFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("share");
  if (fromQuery) return fromQuery;
  const rawHash = window.location.hash.replace(/^#/, "");
  if (!rawHash) return null;
  return new URLSearchParams(rawHash).get("share");
}

function looksLikeShareLinkIntent() {
  if (/^\/s\/[^/]+/.test(window.location.pathname)) return true;
  const p = new URLSearchParams(window.location.search);
  if (p.get("sid") || p.get("share")) return true;
  if (window.location.hash.includes("share=")) return true;
  return false;
}

async function readShareStateFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  const sid = readSidFromLocation();
  const shareToken = readShareTokenFromLocation();

  if (sid) {
    try {
      const res = await fetch(shareApiUrl(`/api/share/${encodeURIComponent(sid)}`));
      if (res.ok) {
        const data = await res.json();
        const payload = data?.payload;
        if (payload?.item?.candidate) {
          return { payload, view, shareLookup: "sid" };
        }
      }
    } catch {
      // 네트워크/CORS 오류 → 아래 share 토큰으로 시도
    }
  }
  if (!shareToken) return null;
  try {
    const payload = fromBase64Url(shareToken);
    if (!payload?.item?.candidate) return null;
    return { payload, view, shareLookup: "token" };
  } catch {
    return null;
  }
}

function pickRecommendCardPlacement(candidate, perFriend) {
  const friends = (perFriend ?? []).map((pf) => pf?.startPoint).filter(Boolean);
  if (!candidate || !friends.length) {
    return { side: "right", vertical: "down" };
  }
  const avgLat = friends.reduce((sum, p) => sum + p.lat, 0) / friends.length;
  const avgLng = friends.reduce((sum, p) => sum + p.lng, 0) / friends.length;
  return {
    side: avgLng >= candidate.lng ? "left" : "right",
    vertical: avgLat >= candidate.lat ? "down" : "up"
  };
}

function projectPointToViewport(point) {
  const projection = map?.getProjection?.();
  if (!projection?.containerPointFromCoords || !mapEl || !point) return null;
  const containerPoint = projection.containerPointFromCoords(new kakao.maps.LatLng(point.lat, point.lng));
  const mapRect = mapEl.getBoundingClientRect();
  return {
    x: mapRect.left + containerPoint.x,
    y: mapRect.top + containerPoint.y
  };
}

function computeRecommendCardOffset(cardEl, pinPoint, avoidancePoints = []) {
  if (!cardEl || !mapEl) return { x: 0, y: 0 };
  const baseRect = cardEl.getBoundingClientRect();
  const mapRect = mapEl.getBoundingClientRect();
  const cardW = baseRect.width || 260;
  const cardH = baseRect.height || 120;
  const margin = 12;

  const projectedAvoids = avoidancePoints.map(projectPointToViewport).filter(Boolean);
  const projectedPin = projectPointToViewport(pinPoint);
  if (!projectedPin) return { x: 0, y: 0 };

  const options = [
    { x: 0, y: 0 },
    { x: 0, y: 84 },
    { x: 120, y: 62 },
    { x: -120, y: 62 },
    { x: 160, y: -18 },
    { x: -160, y: -18 },
    { x: 0, y: -96 },
    { x: 196, y: 96 },
    { x: -196, y: 96 },
    { x: 220, y: -88 },
    { x: -220, y: -88 }
  ];

  let best = options[0];
  let bestScore = Number.POSITIVE_INFINITY;
  options.forEach((opt, index) => {
    const rect = {
      left: baseRect.left + opt.x,
      right: baseRect.left + opt.x + cardW,
      top: baseRect.top + opt.y,
      bottom: baseRect.top + opt.y + cardH
    };
    let score = index * 2;

    if (rect.left < mapRect.left + margin) score += (mapRect.left + margin - rect.left) * 3.5;
    if (rect.right > mapRect.right - margin) score += (rect.right - (mapRect.right - margin)) * 3.5;
    if (rect.top < mapRect.top + margin) score += (mapRect.top + margin - rect.top) * 2.5;
    if (rect.bottom > mapRect.bottom - margin) score += (rect.bottom - (mapRect.bottom - margin)) * 3.5;

    projectedAvoids.forEach((pt) => {
      const overlapMargin = 18;
      const inX = pt.x >= rect.left - overlapMargin && pt.x <= rect.right + overlapMargin;
      const inY = pt.y >= rect.top - overlapMargin && pt.y <= rect.bottom + overlapMargin;
      if (inX && inY) score += 1200;
    });

    const cardCenterX = (rect.left + rect.right) / 2;
    const cardCenterY = (rect.top + rect.bottom) / 2;
    const pinDistance = Math.hypot(cardCenterX - projectedPin.x, cardCenterY - projectedPin.y);
    score += Math.abs(pinDistance - 170) * 0.45;

    if (score < bestScore) {
      bestScore = score;
      best = opt;
    }
  });
  // Final hard clamp: always keep the card inside map viewport.
  const clamped = { ...best };
  const finalRect = {
    left: baseRect.left + clamped.x,
    right: baseRect.left + clamped.x + cardW,
    top: baseRect.top + clamped.y,
    bottom: baseRect.top + clamped.y + cardH
  };
  if (finalRect.left < mapRect.left + margin) {
    clamped.x += mapRect.left + margin - finalRect.left;
  }
  if (finalRect.right > mapRect.right - margin) {
    clamped.x -= finalRect.right - (mapRect.right - margin);
  }
  if (finalRect.top < mapRect.top + margin) {
    clamped.y += mapRect.top + margin - finalRect.top;
  }
  if (finalRect.bottom > mapRect.bottom - margin) {
    clamped.y -= finalRect.bottom - (mapRect.bottom - margin);
  }
  return clamped;
}

function enableRecommendCardDragging(cardOrId, placement = {}, position = null, initialOffset = null) {
  const cardEl =
    typeof cardOrId === "string" ? document.getElementById(cardOrId) : cardOrId;
  if (!cardEl) return;

  let dragX = Number(initialOffset?.x ?? 0);
  let dragY = Number(initialOffset?.y ?? 0);
  let renderedX = 0;
  let renderedY = 0;
  let pointerId = null;
  let dragging = false;
  let animationFrameId = 0;
  let startClientX = 0;
  let startClientY = 0;
  let startX = 0;
  let startY = 0;
  const connectorEl = cardEl.querySelector(".mapRecommendConnector");

  const updateConnector = () => {
    if (!connectorEl) return;
    const cardRect = cardEl.getBoundingClientRect();
    const cardWidth = cardRect.width || 260;
    const cardHeight = cardRect.height || 120;

    const projection = map?.getProjection?.();
    const pinPoint =
      position && projection?.containerPointFromCoords
        ? projection.containerPointFromCoords(position)
        : null;
    if (!pinPoint || !mapEl) return;
    const mapRect = mapEl.getBoundingClientRect();
    const pinXGlobal = mapRect.left + pinPoint.x;
    const pinYGlobal = mapRect.top + pinPoint.y;

    const cardCenterX = cardRect.left + cardWidth / 2;
    const cardCenterY = cardRect.top + cardHeight / 2;
    const vx = pinXGlobal - cardCenterX;
    const vy = pinYGlobal - cardCenterY;
    const halfW = cardWidth / 2;
    const halfH = cardHeight / 2;
    const scaleX = Math.abs(vx) > 0.0001 ? halfW / Math.abs(vx) : Number.POSITIVE_INFINITY;
    const scaleY = Math.abs(vy) > 0.0001 ? halfH / Math.abs(vy) : Number.POSITIVE_INFINITY;
    const scale = Math.min(scaleX, scaleY);
    const edgeX = cardCenterX + vx * scale;
    const edgeY = cardCenterY + vy * scale;

    const attachXLocal = edgeX - cardRect.left;
    const attachYLocal = edgeY - cardRect.top;

    const attachXGlobal = cardRect.left + attachXLocal;
    const attachYGlobal = cardRect.top + attachYLocal;
    const dx = pinXGlobal - attachXGlobal;
    const dy = pinYGlobal - attachYGlobal;
    const length = Math.max(8, Math.hypot(dx, dy));
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    connectorEl.style.left = `${attachXLocal}px`;
    connectorEl.style.top = `${attachYLocal}px`;
    connectorEl.style.width = `${length}px`;
    connectorEl.style.transform = `rotate(${angleDeg}deg)`;
  };

  const renderFrame = () => {
    const easing = dragging ? 0.32 : 0.22;
    renderedX += (dragX - renderedX) * easing;
    renderedY += (dragY - renderedY) * easing;
    if (Math.abs(dragX - renderedX) < 0.2) renderedX = dragX;
    if (Math.abs(dragY - renderedY) < 0.2) renderedY = dragY;
    cardEl.style.setProperty("--recommend-drag-x", `${renderedX}px`);
    cardEl.style.setProperty("--recommend-drag-y", `${renderedY}px`);
    updateConnector();
    if (renderedX !== dragX || renderedY !== dragY) {
      animationFrameId = requestAnimationFrame(renderFrame);
    } else {
      animationFrameId = 0;
    }
  };

  const applyTransform = () => {
    if (!animationFrameId) {
      animationFrameId = requestAnimationFrame(renderFrame);
    }
  };

  const keepCardInsideMap = () => {
    if (!mapEl) return;
    const margin = 12;
    const mapRect = mapEl.getBoundingClientRect();
    const cardRect = cardEl.getBoundingClientRect();
    let nextX = dragX;
    let nextY = dragY;
    if (cardRect.left < mapRect.left + margin) nextX += mapRect.left + margin - cardRect.left;
    if (cardRect.right > mapRect.right - margin) nextX -= cardRect.right - (mapRect.right - margin);
    if (cardRect.top < mapRect.top + margin) nextY += mapRect.top + margin - cardRect.top;
    if (cardRect.bottom > mapRect.bottom - margin) nextY -= cardRect.bottom - (mapRect.bottom - margin);
    if (nextX !== dragX || nextY !== dragY) {
      dragX = nextX;
      dragY = nextY;
      applyTransform();
    }
  };

  const beginDrag = (clientX, clientY) => {
    dragging = true;
    startClientX = clientX;
    startClientY = clientY;
    startX = dragX;
    startY = dragY;
    cardEl.classList.add("mapRecommendCardDragging");
    map?.setDraggable?.(false);
  };

  const moveDrag = (clientX, clientY) => {
    if (!dragging) return;
    dragX = startX + (clientX - startClientX);
    dragY = startY + (clientY - startClientY);
    applyTransform();
  };

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    cardEl.classList.remove("mapRecommendCardDragging");
    map?.setDraggable?.(true);
    pointerId = null;
  };

  const onPointerDown = (event) => {
    pointerId = event.pointerId;
    beginDrag(event.clientX, event.clientY);
    if (cardEl.setPointerCapture) {
      cardEl.setPointerCapture(pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerMove = (event) => {
    if (pointerId == null || event.pointerId !== pointerId) return;
    moveDrag(event.clientX, event.clientY);
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerUp = (event) => {
    if (pointerId == null || event.pointerId !== pointerId) return;
    if (cardEl.releasePointerCapture) {
      cardEl.releasePointerCapture(pointerId);
    }
    endDrag();
    event.preventDefault();
    event.stopPropagation();
  };

  const onMouseMove = (event) => {
    if (!dragging || pointerId != null) return;
    moveDrag(event.clientX, event.clientY);
    event.preventDefault();
  };

  const onMouseUp = () => {
    if (pointerId != null) return;
    endDrag();
  };

  const onTouchMove = (event) => {
    if (!dragging || pointerId != null) return;
    const touch = event.touches?.[0];
    if (!touch) return;
    moveDrag(touch.clientX, touch.clientY);
    event.preventDefault();
  };

  const onTouchEnd = () => {
    if (pointerId != null) return;
    endDrag();
  };

  cardEl.addEventListener("mousedown", (event) => {
    if (pointerId != null) return;
    beginDrag(event.clientX, event.clientY);
    event.preventDefault();
    event.stopPropagation();
  });
  cardEl.addEventListener(
    "touchstart",
    (event) => {
      if (pointerId != null) return;
      const touch = event.touches?.[0];
      if (!touch) return;
      beginDrag(touch.clientX, touch.clientY);
      event.preventDefault();
      event.stopPropagation();
    },
    { passive: false }
  );
  cardEl.addEventListener("pointerdown", onPointerDown);
  cardEl.addEventListener("pointermove", onPointerMove);
  cardEl.addEventListener("pointerup", onPointerUp);
  cardEl.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("touchmove", onTouchMove, { passive: false });
  window.addEventListener("touchend", onTouchEnd);
  window.addEventListener("touchcancel", onTouchEnd);
  applyTransform();
  requestAnimationFrame(() => {
    keepCardInsideMap();
    applyTransform();
  });
  if (map && window.kakao?.maps?.event?.addListener) {
    if (recommendOverlayIdleHandler && window.kakao?.maps?.event?.removeListener) {
      kakao.maps.event.removeListener(map, "idle", recommendOverlayIdleHandler);
    }
    recommendOverlayIdleHandler = () => {
      keepCardInsideMap();
      applyTransform();
    };
    kakao.maps.event.addListener(map, "idle", recommendOverlayIdleHandler);
  }
}

function addCandidateHighlightPin(position) {
  if (!isMapReady || !map) return null;
  const pinImage = new kakao.maps.MarkerImage(
    svgPinImageUrl("#ff6f4f"),
    new kakao.maps.Size(34, 44),
    { offset: new kakao.maps.Point(17, 44) }
  );
  const marker = new kakao.maps.Marker({
    map,
    position,
    image: pinImage,
    zIndex: 9
  });
  markers.push(marker);

  const pulseHtml = `
    <div class="candidatePulseWrap">
      <span class="candidatePulseRing" aria-hidden="true"></span>
      <span class="candidatePulseCore" aria-hidden="true"></span>
    </div>
  `;
  candidatePulseOverlay = new kakao.maps.CustomOverlay({
    map,
    position,
    content: pulseHtml,
    xAnchor: 0.5,
    yAnchor: 0.5,
    zIndex: 8
  });
  return marker;
}

function addCandidateRecommendCard(position, { name, address, reasonText, placement, avoidancePoints = [] }) {
  clearCandidateRecommendOverlay();
  const sideClass = placement?.side === "left" ? "mapRecommendCardLeft" : "mapRecommendCardRight";
  const cardEl = document.createElement("div");
  cardEl.className = `mapRecommendCard ${sideClass}`;
  cardEl.innerHTML = `
    <span class="mapRecommendConnector" aria-hidden="true"></span>
    <div class="mapRecommendKicker">추천 1순위</div>
    <div class="mapRecommendTitle">${escapeHtml(name)}</div>
    <div class="mapRecommendAddr">${escapeHtml(address)}</div>
    <div class="mapRecommendDivider"></div>
    <div class="mapRecommendReasonRow">
      <span class="mapRecommendReasonDot" aria-hidden="true"></span>
      <span class="mapRecommendReasonText">${escapeHtml(reasonText)}</span>
    </div>
  `;
  candidateRecommendOverlay = new kakao.maps.CustomOverlay({
    map,
    position,
    content: cardEl,
    // Keep initial card reliably visible: center-aligned and placed below midpoint pin.
    xAnchor: 0.5,
    yAnchor: 0,
    zIndex: 7,
    clickable: true
  });
  requestAnimationFrame(() => {
    const initialOffset = computeRecommendCardOffset(cardEl, position, avoidancePoints);
    enableRecommendCardDragging(cardEl, placement, position, initialOffset);
  });
}

async function shareTopCandidate(item, address, reasonText) {
  const ready = await ensureKakaoShareReady();
  if (!ready) {
    resultEl.textContent = `카카오 공유 SDK 초기화에 실패했습니다. ${
      lastShareErrorDetail || "KAKAO_JS_KEY/카카오 Web 도메인 설정을 확인해 주세요."
    }`;
    return;
  }

  const avgText = `${Math.round(item?.averageMinutes ?? 0)}분`;
  const maxText = `${Math.round(item?.maxMinutes ?? 0)}분`;
  const destinationName = item?.candidate?.name ?? "추천 지점";
  const addressOneLine = (address || "").replace(/\s+/g, " ").trim();
  const addressShort =
    addressOneLine.length > 42 ? `${addressOneLine.slice(0, 40)}…` : addressOneLine;
  const friendBlock = (item?.perFriend ?? [])
    .map(
      (pf) =>
        `${pf.friendName} ${pf?.route?.totalMinutes ?? "?"}분 (환승 ${pf?.route?.transferCount ?? "?"})`
    )
    .join("\n");
  /** 카톡 카드: 작은 라벨은 구역, 본문은 선정 장소 → 요약·주소 → 친구별 시간 */
  const shareItemLines = [
    destinationName,
    `평균 ${avgText} · 최대 ${maxText}`,
    ...(addressShort ? [addressShort] : []),
    "",
    "친구별 소요시간",
    friendBlock || "링크에서 확인"
  ];
  const shareItemTitle = shareItemLines.join("\n").slice(0, 400);
  const tinyFallbackPayload = buildTinyShareFallbackPayload(item, address, reasonText);
  const compactPayload = buildCompactSharePayload(item, address, reasonText);
  const shareSessionId = await createShareSession(compactPayload);
  if (shareSessionId) currentShareSessionId = shareSessionId;
  const shareUrls = shareSessionId
    ? buildShareUrlsFromSid(shareSessionId, tinyFallbackPayload)
    : buildShareUrls(tinyFallbackPayload);
  const mapOnlyUrl = `https://map.kakao.com/link/map/${encodeURIComponent(destinationName)},${item?.candidate?.lat},${item?.candidate?.lng}`;
  const kakaoUrls = clipUrlsForKakaoShare(shareUrls, mapOnlyUrl);
  /** tiny URL만 쓰면 perFriend가 비어 view=friends가 빈약함 → sid가 있을 때만 하단 버튼 노출 */
  const kakaoShareButtons = shareSessionId
    ? [
        {
          title: "지도에서 보기",
          link: { mobileWebUrl: kakaoUrls.mapUrl, webUrl: kakaoUrls.mapUrl }
        },
        {
          title: "친구 별 경로 보기",
          link: { mobileWebUrl: kakaoUrls.friendRouteUrl, webUrl: kakaoUrls.friendRouteUrl }
        }
      ]
    : undefined;

  const kakaoTitle = truncateKakaoField(`쌤밋 · 우리 모임 1순위 중간지점: ${destinationName}`, 80);
  const kakaoDescription = truncateKakaoField(
    `${reasonText} · 평균 ${avgText} / 최대 ${maxText}\n${address}`,
    160
  );
  const kakaoItemText = truncateKakaoField(shareItemTitle, 180);

  try {
    window.Kakao.Share.sendDefault({
      objectType: "feed",
      content: {
        title: kakaoTitle,
        description: kakaoDescription,
        imageUrl: "https://samemeet.com/samemeet-thumbnail.png",
        link: {
          mobileWebUrl: kakaoUrls.rootUrl,
          webUrl: kakaoUrls.rootUrl
        }
      },
      ...(kakaoShareButtons ? { buttons: kakaoShareButtons } : {}),
      itemContent: {
        profileText: truncateKakaoField("1순위 중간지점", 24),
        titleImageText: kakaoItemText
      }
    });
    if (shareSessionId) {
      void recordSessionShared(shareSessionId);
    }
  } catch (error) {
    // Fallback for Kakao validation failures (e.g. oversized URL/payload)
    lastShareErrorDetail = `공유 요청 실패: ${String(error)}`;
    resultEl.textContent = `${lastShareErrorDetail} (간소 링크로 재시도해 주세요)`;
    window.Kakao.Share.sendDefault({
      objectType: "feed",
      content: {
        title: kakaoTitle,
        description: kakaoDescription,
        imageUrl: "https://samemeet.com/samemeet-thumbnail.png",
        link: { mobileWebUrl: mapOnlyUrl, webUrl: mapOnlyUrl }
      },
      itemContent: {
        profileText: truncateKakaoField("1순위 중간지점", 24),
        titleImageText: kakaoItemText
      }
    });
  }
}

function reverseGeocode(lat, lng) {
  return new Promise((resolve) => {
    if (!geocoder?.coord2Address) {
      resolve(`위도 ${lat.toFixed(5)}, 경도 ${lng.toFixed(5)}`);
      return;
    }
    geocoder.coord2Address(lng, lat, (result, status) => {
      if (status === kakao.maps.services.Status.OK && result[0]?.address?.address_name) {
        resolve(result[0].address.address_name);
        return;
      }
      resolve(`위도 ${lat.toFixed(5)}, 경도 ${lng.toFixed(5)}`);
    });
  });
}

function fitBounds(points) {
  if (!points.length) return;
  const bounds = new kakao.maps.LatLngBounds();
  points.forEach((point) => bounds.extend(new kakao.maps.LatLng(point.lat, point.lng)));
  map.setBounds(bounds);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function summarizeOdsayPath(raw) {
  const path0 = raw?.result?.path?.[0];
  const subPaths = path0?.subPath ?? [];
  const segments = [];

  for (const sub of subPaths) {
    const trafficType = sub?.trafficType;
    if (trafficType === 3) {
      const mins = sub?.sectionTime;
      segments.push(`도보 ${mins ?? "?"}분`);
    } else if (trafficType === 1) {
      const laneName = sub?.lane?.[0]?.name ?? "지하철";
      const mins = sub?.sectionTime;
      segments.push(`${laneName} ${mins ?? "?"}분`);
    } else if (trafficType === 2) {
      const busNo = sub?.lane?.[0]?.busNo ?? "버스";
      const mins = sub?.sectionTime;
      segments.push(`버스 ${busNo} ${mins ?? "?"}분`);
    }
  }

  return segments;
}

function openSheet() {
  sheetBackdropEl.style.display = "block";
  sheetEl.style.display = "block";
  updateStickyShareButton();
  document.body.style.overflow = "hidden";
  if (map && isMapReady) {
    map.relayout();
  }
  mapWrapEl?.scrollIntoView({ behavior: "auto", block: "nearest" });
}

function closeSheet() {
  sheetBackdropEl.style.display = "none";
  sheetEl.style.display = "none";
  updateStickyShareButton();
  document.body.style.overflow = "";
  clearRouteOverlay();
  if (markersHiddenForSheet) setCandidateMarkersVisible(true);
  setFriendOverviewPinsVisible(true);
  setCandidateRecommendOverlayVisible(true);
  if (lastOverviewItem && isMapReady && map) {
    void redrawMapOverviewRoutes(lastOverviewItem);
  }
  if (map && isMapReady) {
    map.relayout();
  }
}

function renderPathList(segments) {
  pathListEl.innerHTML = "";
  if (!segments?.length) {
    const li = document.createElement("li");
    li.textContent = "세부 경로 정보가 없습니다.";
    pathListEl.appendChild(li);
    return;
  }
  for (const seg of segments) {
    const li = document.createElement("li");
    li.textContent = seg;
    pathListEl.appendChild(li);
  }
}

function renderFriendTimeList(perFriend, selectedFriendId, onSelectFriend) {
  friendTimeListEl.innerHTML = "";
  if (!perFriend?.length) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "친구별 소요시간 정보가 없습니다.";
    friendTimeListEl.appendChild(empty);
    return;
  }
  const sorted = [...perFriend].sort(
    (a, b) => Number(a?.route?.totalMinutes ?? Infinity) - Number(b?.route?.totalMinutes ?? Infinity)
  );
  const maxMinutes = Math.max(...sorted.map((pf) => Number(pf?.route?.totalMinutes ?? 0)));

  sorted.forEach((pf) => {
    const minutes = Number(pf?.route?.totalMinutes ?? 0);
    const isLongest = minutes === maxMinutes && maxMinutes > 0;
    const isSelected = pf?.friendId === selectedFriendId;
    const row = document.createElement("div");
    row.className = `friendTimeItem${isLongest ? " friendTimeItemLongest" : ""}${
      isSelected ? " friendTimeItemSelected" : ""
    }`;
    const locationText = pf?.friendAddress ? `(${pf.friendAddress})` : "";
    row.innerHTML = `
      <div class="friendTimeLabel">
        <span class="friendTimeMain">${escapeHtml(pf.friendName)}<span class="friendTimeLocation">${escapeHtml(
          locationText
        )}</span></span>
        ${isLongest ? '<span class="friendTimeBadge">(최장시간)</span>' : ""}
      </div>
      <div class="friendTimeValue">${pf?.route?.totalMinutes ?? "?"}분 (환승 ${
        pf?.route?.transferCount ?? "?"
      })</div>
    `;
    row.tabIndex = 0;
    row.role = "button";
    row.setAttribute("aria-label", `${pf.friendName} 경로 선택`);
    row.addEventListener("click", () => onSelectFriend?.(pf.friendId));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelectFriend?.(pf.friendId);
      }
    });
    friendTimeListEl.appendChild(row);
  });
}

function extractMapObj(raw) {
  return raw?.result?.path?.[0]?.info?.mapObj || "";
}

function strokeColorForTransitLane(lane) {
  const type = Number(lane?.type);
  if (type === 1) return "#1E88E5";
  if (type === 2) return "#E53935";
  if (type === 3) return "#43A047";
  return "#6D4C41";
}

/**
 * ODsay loadLane로 경로 폴리라인을 그린다. routePolylines에 누적한다.
 * @returns pointCount
 */
async function appendPolylinesFromRaw(raw, strokeColorFn, extendBounds) {
  if (!isMapReady || !map) return 0;
  const mapObj = extractMapObj(raw);
  if (!mapObj) return 0;

  const res = await fetch(
    apiUrl(`/api/odsay/loadLane?mapObj=${encodeURIComponent(mapObj)}`)
  );
  const data = await res.json();
  if (data?.error) {
    console.warn("loadLane error", data.error);
    return 0;
  }

  const lanes = data?.result?.lane ?? [];
  let pointCount = 0;

  for (const lane of lanes) {
    const sections = lane?.section ?? [];
    const strokeColor = strokeColorFn(lane);
    for (const section of sections) {
      const graph = section?.graphPos ?? [];
      if (!graph.length) continue;
      const path = graph
        .map((p) => {
          const lat = Number(p.y);
          const lng = Number(p.x);
          const ll = new kakao.maps.LatLng(lat, lng);
          if (extendBounds) extendBounds.extend(ll);
          pointCount += 1;
          return ll;
        })
        .filter(Boolean);
      if (path.length < 2) continue;
      const polyline = new kakao.maps.Polyline({
        map,
        path,
        strokeWeight: 5,
        strokeColor,
        strokeOpacity: 0.85,
        strokeStyle: "solid"
      });
      routePolylines.push(polyline);
    }
  }

  return pointCount;
}

async function drawRouteOnMap(raw) {
  if (!isMapReady || !map) return;
  clearRouteOverlay();
  const bounds = new kakao.maps.LatLngBounds();
  const n = await appendPolylinesFromRaw(raw, strokeColorForTransitLane, bounds);
  if (n > 0) {
    map.setBounds(bounds);
  }
}

async function redrawMapOverviewRoutes(item) {
  if (!isMapReady || !map || !item?.perFriend?.length) return 0;
  const bounds = new kakao.maps.LatLngBounds();
  const perFriend = item.perFriend;
  /** 친구마다 loadLane이 순차면 RTT가 누적돼 모바일·크로스오리진에서 체감이 크게 느려짐 → 병렬 요청 */
  const counts = await Promise.all(
    perFriend.map((pf, i) =>
      appendPolylinesFromRaw(pf?.route?.raw, () => friendRouteColor(i), bounds)
    )
  );
  const totalPoints = counts.reduce((a, n) => a + n, 0);
  const c = item?.candidate;
  if (c?.lat != null && c?.lng != null) {
    bounds.extend(new kakao.maps.LatLng(c.lat, c.lng));
  }
  if (totalPoints > 0) {
    map.setBounds(bounds);
  }
  return totalPoints;
}

function svgPinImageUrl(fillHex) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 34 44">` +
    `<path d="M17 0C7.6 0 0 7.3 0 16.3c0 10.4 13.3 26.7 16.1 30.1.5.7 1.6.7 2.1 0C20.7 43 34 26.7 34 16.3 34 7.3 26.4 0 17 0z" fill="${fillHex}"/>` +
    `<circle cx="17" cy="16.5" r="6.2" fill="#fff" fill-opacity="0.95"/>` +
    `</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function addFriendOverviewPin(startPoint, friendName, colorHex) {
  if (!isMapReady || !map) return;
  if (!startPoint?.lat || !startPoint?.lng) return;
  const pos = new kakao.maps.LatLng(startPoint.lat, startPoint.lng);
  const pinImage = new kakao.maps.MarkerImage(
    svgPinImageUrl(colorHex),
    new kakao.maps.Size(34, 44),
    { offset: new kakao.maps.Point(17, 44) }
  );
  const marker = new kakao.maps.Marker({ map, position: pos, image: pinImage });
  const content = `<div class="markerLabel"><span class="markerDot" style="background:${colorHex}"></span>${escapeHtml(
    friendName
  )}</div>`;
  const overlay = new kakao.maps.CustomOverlay({
    map,
    position: pos,
    content,
    yAnchor: 1.45
  });
  friendOverviewEntries.push({ marker, overlay });
}

function addRouteMarkers(startPoint, endPoint, labels) {
  if (!isMapReady || !map) return;
  if (!startPoint?.lat || !startPoint?.lng || !endPoint?.lat || !endPoint?.lng) return;

  const startPos = new kakao.maps.LatLng(startPoint.lat, startPoint.lng);
  const endPos = new kakao.maps.LatLng(endPoint.lat, endPoint.lng);

  const startImage = new kakao.maps.MarkerImage(svgPinImageUrl("#1E88E5"), new kakao.maps.Size(34, 44), {
    offset: new kakao.maps.Point(17, 44)
  });
  const endImage = new kakao.maps.MarkerImage(svgPinImageUrl("#8E24AA"), new kakao.maps.Size(34, 44), {
    offset: new kakao.maps.Point(17, 44)
  });

  const startMarker = new kakao.maps.Marker({ map, position: startPos, image: startImage });
  const endMarker = new kakao.maps.Marker({ map, position: endPos, image: endImage });
  routeMarkers.push(startMarker, endMarker);

  const makeLabel = (text, color) =>
    `<div class="markerLabel"><span class="markerDot" style="background:${color}"></span>${escapeHtml(
      text
    )}</div>`;

  const startOverlay = new kakao.maps.CustomOverlay({
    map,
    position: startPos,
    content: makeLabel(labels?.startLabel ?? "출발", "#1E88E5"),
    yAnchor: 1.45
  });
  const endOverlay = new kakao.maps.CustomOverlay({
    map,
    position: endPos,
    content: makeLabel(labels?.endLabel ?? "도착", "#8E24AA"),
    yAnchor: 1.45
  });
  routeLabelOverlays.push(startOverlay, endOverlay);
}

async function openCandidateDetails(item, address) {
  setCandidateRecommendOverlayVisible(false);
  setFriendOverviewPinsVisible(false);

  sheetTitleEl.textContent = item?.candidate?.name ? `상세 경로 - ${item.candidate.name}` : "상세 경로";
  sheetSubtitleEl.textContent = address ? `주소: ${address}` : "";

  const perFriend = item?.perFriend ?? [];
  if (!perFriend.length) {
    renderFriendTimeList(perFriend, "", () => {});
    renderPathList([]);
    openSheet();
    return;
  }

  let selectedFriendId = perFriend[0]?.friendId ?? "";
  const indexByFriendId = new Map(perFriend.map((pf, idx) => [pf.friendId, idx]));

  const update = async () => {
    const idxFromId = indexByFriendId.get(selectedFriendId);
    const idx = idxFromId != null ? idxFromId : 0;
    const pf = perFriend?.[idx];
    if (!pf) return;
    selectedFriendId = pf.friendId;
    const raw = pf?.route?.raw;
    renderFriendTimeList(perFriend, selectedFriendId, (friendId) => {
      selectedFriendId = friendId;
      void update();
    });
    renderPathList(summarizeOdsayPath(raw));
    await drawRouteOnMap(raw);
    addRouteMarkers(pf?.startPoint, item?.candidate, {
      startLabel: `🏃‍♂️ 출발(${pf?.friendName ?? "친구"})`,
      endLabel: `🚩 도착(${item?.candidate?.name ?? "중간지점"})`
    });
  };

  renderFriendTimeList(perFriend, selectedFriendId, (friendId) => {
    selectedFriendId = friendId;
    void update();
  });
  pathListEl.innerHTML = "";
  const loadingLi = document.createElement("li");
  loadingLi.textContent = "노선 지도를 불러오는 중…";
  pathListEl.appendChild(loadingLi);
  openSheet();
  await update();
}

async function renderTopCandidates(results, options = {}) {
  if (!isMapReady || !map) return;
  clearMapObjects();
  cardsEl.innerHTML = "";
  if (!results?.length) return;
  const item = results[0];
  lastResults = [item];
  const { lat, lng, name } = item.candidate;
  const address = options?.preferredAddress || (await reverseGeocode(lat, lng));
  const reasonText = buildReasonSummary(item);
  const recommendationStrength = recommendationStrengthLabel(item?.candidate?.tier);
  const suitability = suitabilityLabel(item?.candidate?.tier, item?.candidate?.isPriority);
  const contextLabel = hotplaceAccessibilityLabel(item);
  const meetingIndex = meetingIndexScore(item);

  const position = new kakao.maps.LatLng(lat, lng);
  const candidateMarker = addCandidateHighlightPin(position);
  const placement = pickRecommendCardPlacement(item?.candidate, item?.perFriend);
  const avoidancePoints = [
    item?.candidate,
    ...(item?.perFriend ?? []).map((pf) => pf?.startPoint).filter(Boolean)
  ];
  addCandidateRecommendCard(position, { name, address, reasonText, placement, avoidancePoints });
  if (candidateMarker) {
    kakao.maps.event.addListener(candidateMarker, "dblclick", () => void openCandidateDetails(item, address));
  }

  const perFriends = item?.perFriend ?? [];
  perFriends.forEach((pf, i) => {
    addFriendOverviewPin(
      pf?.startPoint,
      pf?.friendName ?? `친구${i + 1}`,
      friendRouteColor(i)
    );
  });

  const card = document.createElement("div");
  card.className = "rounded-3xl border border-coral-100 bg-white p-4 shadow-softCard app-fade";
  card.innerHTML = `
    <strong class="text-slate-800">🌟 추천 1순위 - ${name}</strong>
    <div class="mt-1 text-xs text-slate-500">주소: ${address}</div>
    <div class="mt-1 text-xs text-slate-600">추천 강도: ${recommendationStrength}</div>
    <div class="mt-1 text-xs text-slate-600">만남 적합도: ${suitability}</div>
    <div class="mt-1 text-xs text-slate-600">라벨: ${contextLabel}</div>
    <div class="mt-1 text-xs font-bold text-coral-600">만남지수 ${meetingIndex}점</div>
    ${
      item?.candidate?.shiftedFrom
        ? `<div class="mt-1 text-xs text-slate-500">후보 보정: ${escapeHtml(item.candidate.shiftedFrom)} → ${escapeHtml(
            item.candidate.name
          )}</div>`
        : ""
    }
    <div class="mt-1 text-xs text-coral-600 font-bold">선정 이유: ${reasonText}</div>
    <div class="mt-1 text-xs text-slate-600">평균 ${Math.round(item.averageMinutes)}분 · 최대 ${Math.round(item.maxMinutes)}분</div>
    <div class="mt-3">
      <button type="button" class="tap-press h-11 w-full rounded-2xl border border-coral-200 bg-coral-50 px-3 text-sm font-bold text-coral-600" data-action="details">세부 내용 조회</button>
    </div>
  `;
  card.querySelector('[data-action="details"]').addEventListener("click", () =>
    void openCandidateDetails(item, address)
  );
  card.addEventListener("click", () => {
    void recordSessionSelection(item?.candidate, "recommend_card");
  });
  cardsEl.appendChild(card);
  lastSharePayload = { item, address, reasonText };
  updateStickyShareButton();

  lastOverviewItem = item;
  mapStatusEl.textContent = "친구별 경로를 지도에 그리는 중…";
  const polyPts = await redrawMapOverviewRoutes(item);
  if (!polyPts) {
    const pts = [];
    if (item.candidate) pts.push(item.candidate);
    perFriends.forEach((pf) => {
      if (pf?.startPoint) pts.push(pf.startPoint);
    });
    if (pts.length) fitBounds(pts);
  }
  mapStatusEl.textContent = "1순위 추천, 친구별 경로·핀을 표시했습니다.";
  if (options?.autoOpenDetails) {
    await openCandidateDetails(item, address);
  }
}

function addFriendRow(name = "", address = "", addressPlaceholder = "ex. 신도림역") {
  const row = document.createElement("div");
  row.className = "friend-row grid grid-cols-[110px_minmax(0,1fr)_44px] gap-2";
  row.innerHTML = `
    <input type="text" placeholder="이름" value="${name}" class="name h-12 w-full min-w-0 rounded-2xl border border-coral-200 bg-[#fffdfb] px-3" autocomplete="name" enterkeyhint="next" />
    <input type="text" placeholder="${addressPlaceholder}" value="${address}" class="address h-12 w-full min-w-0 rounded-2xl border border-coral-200 bg-[#fffdfb] px-3" autocomplete="street-address" enterkeyhint="done" />
    <button type="button" class="remove-friend tap-press h-12 w-11 rounded-2xl border border-coral-200 bg-white text-lg text-coral-500" aria-label="친구 삭제" title="친구 삭제">🗑️</button>
  `;
  const removeBtn = row.querySelector(".remove-friend");
  removeBtn?.addEventListener("click", () => {
    const rows = [...friendsEl.querySelectorAll(".friend-row")];
    if (rows.length <= 2) {
      resultEl.textContent = "친구는 최소 2명 이상 필요해요.";
      return;
    }
    row.remove();
    refreshFriendRowPlaceholders();
  });
  friendsEl.appendChild(row);
}

function refreshFriendRowPlaceholders() {
  const rows = [...friendsEl.querySelectorAll(".friend-row")];
  rows.forEach((row, index) => {
    const addressInput = row.querySelector(".address");
    if (addressInput) {
      addressInput.placeholder = stationPlaceholders[index % stationPlaceholders.length];
    }
  });
}

function nextUniqueFriendDefaultName() {
  const usedNames = new Set(
    [...friendsEl.querySelectorAll(".friend-row .name")]
      .map((el) => el.value.trim())
      .filter(Boolean)
  );
  let index = 1;
  while (usedNames.has(`친구${index}`)) {
    index += 1;
  }
  return `친구${index}`;
}

addFriendRow("친구1", "", "ex. 신도림역");
addFriendRow("친구2", "", "ex. 문정역");
addFriendBtn.addEventListener("click", () => {
  const nextIndex = friendsEl.querySelectorAll(".friend-row").length + 1;
  const placeholder = stationPlaceholders[(nextIndex - 1) % stationPlaceholders.length];
  addFriendRow(nextUniqueFriendDefaultName(), "", placeholder);
  refreshFriendRowPlaceholders();
});

runBtn.addEventListener("click", async () => {
  const rows = [...friendsEl.querySelectorAll(".friend-row")];
  const friends = rows
    .map((row, index) => ({
      id: `f-${index + 1}`,
      name: row.querySelector(".name").value.trim() || `친구${index + 1}`,
      address: row.querySelector(".address").value.trim()
    }))
    .filter((f) => f.address.length > 0);

  const payload = {
    friends,
    options: {
      topN: 3,
      maxCandidates: 12,
      transferPenalty: 8
    }
  };
  if (friends.length < 2) {
    resultEl.textContent = "친구는 최소 2명 이상 입력해 주세요.";
    return;
  }
  runBtn.disabled = true;
  runBtn.classList.add("opacity-70");
  renderResultSkeleton("중간지점 계산 중… (친구별 이동시간을 수집하는 중)");
  startMidpointLoadingIndicator();
  lastSharePayload = null;
  lastOverviewItem = null;
  updateStickyShareButton();
  clearMapObjects();
  try {
    const res = await fetch(apiUrl("/api/midpoint"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.error) {
      stopMidpointLoadingIndicator();
      cardsEl.innerHTML = "";
      resultEl.textContent = `계산 실패: ${data.error}`;
      return;
    }
    const results = data.results ?? [];
    if (results.length) {
      setSearchViewVisible(false);
    }
    // Stop rotating loading copy before rendering result cards,
    // otherwise async map/detail rendering can overwrite completion text.
    stopMidpointLoadingIndicator();
    updateMidpointLoadingProgress(100);
    resultEl.textContent = "중간지점 계산 완료.";
    if (isMapReady) {
      await renderTopCandidates(results);
    } else {
      pendingResultsForMap = { results, options: {} };
      mapStatusEl.textContent = "지도 SDK 준비 후 자동으로 마커를 표시합니다.";
    }
  } catch (error) {
    stopMidpointLoadingIndicator();
    cardsEl.innerHTML = "";
    resultEl.textContent = `요청 실패: ${String(error)}`;
  } finally {
    stopMidpointLoadingIndicator();
    runBtn.disabled = false;
    runBtn.classList.remove("opacity-70");
  }
});

if (backToSearchBtnEl) {
  backToSearchBtnEl.addEventListener("click", () => {
    closeSheet();
    setSearchViewVisible(true);
    cardsEl.innerHTML = "";
    resultEl.textContent = "";
    lastSharePayload = null;
    lastOverviewItem = null;
    updateStickyShareButton();
    clearMapObjects();
    mapStatusEl.textContent = "친구 정보를 입력하고 중간지점을 다시 계산해 주세요.";
  });
}

sheetCloseEl.addEventListener("click", closeSheet);
sheetBackdropEl.addEventListener("click", closeSheet);

if (stickyShareBtnEl) {
  stickyShareBtnEl.addEventListener("click", () => {
    if (!lastSharePayload) return;
    void shareTopCandidate(lastSharePayload.item, lastSharePayload.address, lastSharePayload.reasonText);
  });
}

if (locateBtnEl) {
  locateBtnEl.addEventListener("click", () => {
    if (!navigator.geolocation) {
      mapStatusEl.textContent = "이 브라우저에서는 위치 기능을 지원하지 않습니다.";
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!isMapReady || !map) return;
        const current = new kakao.maps.LatLng(pos.coords.latitude, pos.coords.longitude);
        map.setCenter(current);
        map.setLevel(5);
        mapStatusEl.textContent = "현재 위치로 이동했습니다.";
      },
      () => {
        mapStatusEl.textContent = "위치 권한이 필요합니다. 브라우저 설정에서 허용해 주세요.";
      },
      { enableHighAccuracy: true, timeout: 7000 }
    );
  });
}

ensureMapReady();

void (async () => {
  const sharedState = await readShareStateFromQuery();
  if (sharedState?.payload?.item) {
    setSearchViewVisible(false);
    resultEl.textContent = "공유된 중간지점 결과를 불러왔습니다.";
    const sharedOptions = {
      preferredAddress: sharedState.payload.address || "",
      autoOpenDetails: sharedState.view === "friends"
    };
    if (isMapReady) {
      void renderTopCandidates([sharedState.payload.item], sharedOptions);
    } else {
      pendingResultsForMap = { results: [sharedState.payload.item], options: sharedOptions };
      mapStatusEl.textContent = "공유 결과를 지도에 표시하는 중...";
    }
    if (sharedState.shareLookup === "sid" && readSidFromLocation() && window.history?.replaceState) {
      try {
        const sid = readSidFromLocation();
        currentShareSessionId = sid ?? "";
        const origin = window.location.origin;
        const v = sharedState.view ? `?view=${encodeURIComponent(sharedState.view)}` : "";
        window.history.replaceState(window.history.state, "", `${origin}/s/${encodeURIComponent(sid ?? "")}${v}`);
      } catch {
        // ignore
      }
    } else if (readSidFromLocation()) {
      currentShareSessionId = readSidFromLocation() ?? "";
    }
  } else if (looksLikeShareLinkIntent()) {
    resultEl.textContent =
      "공유 링크를 불러오지 못했습니다. 서버에 세션이 없거나(재시작·만료) 앱에서 주소가 잘렸을 수 있어요. 브라우저로 다시 열거나 친구에게 공유를 한 번 더 요청해 주세요.";
  }
})();
