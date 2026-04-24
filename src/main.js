const friendsEl = document.getElementById("friends");
const addFriendBtn = document.getElementById("addFriend");
const runBtn = document.getElementById("run");
const resultEl = document.getElementById("result");
const cardsEl = document.getElementById("cards");
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

function apiUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  const h = window.location.hostname;
  const apiOnSameHost =
    h === "localhost" || h === "127.0.0.1" || h.endsWith(".up.railway.app");
  if (apiOnSameHost) return p;
  return `${RAILWAY_API_ORIGIN}${p}`;
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
let kakaoJsKey = "";
let lastSharePayload = null;
let lastShareErrorDetail = "";
/** 상세 시트를 닫은 뒤 전체 경로를 다시 그릴 때 사용 */
let lastOverviewItem = null;
/** 결과 화면에서 친구 출발지 핀(세부 경로 모드에서는 잠시 숨김) */
let friendOverviewEntries = [];

const FRIEND_ROUTE_COLORS = ["#E53935", "#1E88E5", "#43A047", "#FB8C00", "#8E24AA", "#00897B"];

function friendRouteColor(index) {
  return FRIEND_ROUTE_COLORS[index % FRIEND_ROUTE_COLORS.length];
}

async function injectKakaoSdk() {
  if (sdkInjected) return;
  sdkInjected = true;
  mapStatusEl.textContent = "Kakao SDK 스크립트 요청 중...";

  try {
    const res = await fetch(apiUrl("/api/public-config"));
    const data = await res.json();
    kakaoJsKey = data?.kakaoJsKey || "";
  } catch {
    // ignore
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
  script.onload = () => {
    window.__onKakaoSdkLoad?.();
    mapStatusEl.textContent = "Kakao SDK 로드 완료. 초기화 중...";
  };
  script.onerror = () => {
    window.__onKakaoSdkError?.();
    mapStatusEl.textContent =
      window.__kakaoSdk?.errorDetail ||
      "브라우저가 Kakao SDK 스크립트를 로드하지 못했습니다.";
  };
  document.head.appendChild(script);
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
  if (pendingResultsForMap?.length) {
    void renderTopCandidates(pendingResultsForMap);
    pendingResultsForMap = null;
  }
}

function ensureMapReady() {
  if (isMapReady || mapInitTried) return;
  mapInitTried = true;

  let attempts = 0;
  const maxAttempts = 20;
  void injectKakaoSdk();
  mapStatusEl.textContent = "지도 SDK 로딩 중...";
  const timer = setInterval(() => {
    attempts += 1;
    mapStatusEl.textContent = `지도 SDK 로딩 중... (${attempts}/${maxAttempts})`;
    if (window.__kakaoSdk?.errored) {
      clearInterval(timer);
      mapStatusEl.textContent =
        window.__kakaoSdk.errorDetail ||
        "Kakao 지도 SDK 로드에 실패했습니다. 네트워크 또는 도메인 허용 설정을 확인해 주세요.";
      return;
    }
    if (window.kakao?.maps?.load) {
      clearInterval(timer);
      kakao.maps.load(() => {
        initMap();
      });
      return;
    }

    if (attempts >= maxAttempts) {
      clearInterval(timer);
      mapStatusEl.textContent =
        "Kakao 지도 SDK 로드에 실패했습니다. 네트워크 또는 도메인 허용 설정을 확인해 주세요.";
    }
  }, 250);
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
  if (candidateRecommendOverlay) {
    candidateRecommendOverlay.setMap(null);
    candidateRecommendOverlay = null;
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
  if (!lastSharePayload) {
    stickyShareBtnEl.classList.add("hidden");
    stickyShareBtnEl.disabled = true;
    return;
  }
  stickyShareBtnEl.classList.remove("hidden");
  stickyShareBtnEl.disabled = false;
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
  if (item?.candidate?.tier) {
    return `검증된 약속장소 Tier ${item.candidate.tier}`;
  }
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

function addCandidateRecommendCard(position, { name, address, reasonText }) {
  clearCandidateRecommendOverlay();
  const html = `
    <div class="mapRecommendCard">
      <div class="mapRecommendKicker">추천 1순위</div>
      <div class="mapRecommendTitle">${escapeHtml(name)}</div>
      <div class="mapRecommendAddr">${escapeHtml(address)}</div>
      <div class="mapRecommendDivider"></div>
      <div class="mapRecommendReasonRow">
        <span class="mapRecommendReasonDot" aria-hidden="true"></span>
        <span class="mapRecommendReasonText">${escapeHtml(reasonText)}</span>
      </div>
    </div>
  `;
  candidateRecommendOverlay = new kakao.maps.CustomOverlay({
    map,
    position,
    content: html,
    xAnchor: 0.5,
    yAnchor: 1,
    zIndex: 5
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

  const friendSummary = (item?.perFriend ?? [])
    .map((pf) => `${pf.friendName}: ${pf?.route?.totalMinutes ?? "?"}분`)
    .join(" | ");
  const avgText = `${Math.round(item?.averageMinutes ?? 0)}분`;
  const maxText = `${Math.round(item?.maxMinutes ?? 0)}분`;
  const destinationName = item?.candidate?.name ?? "추천 지점";
  const mapUrl = `https://map.kakao.com/link/map/${encodeURIComponent(destinationName)},${item?.candidate?.lat},${item?.candidate?.lng}`;

  window.Kakao.Share.sendDefault({
    objectType: "feed",
    content: {
      title: `쌤밋 · 우리 모임 1순위 중간지점: ${destinationName}`,
      description: `${reasonText} · 평균 ${avgText} / 최대 ${maxText}\n${address}`,
      imageUrl: "https://developers.kakao.com/assets/img/about/logos/kakaolink/kakaolink_btn_small.png",
      link: {
        mobileWebUrl: mapUrl,
        webUrl: mapUrl
      }
    },
    buttons: [
      {
        title: "지도에서 보기",
        link: { mobileWebUrl: mapUrl, webUrl: mapUrl }
      },
      {
        title: "친구별 시간 보기",
        link: { mobileWebUrl: mapUrl, webUrl: mapUrl }
      }
    ],
    itemContent: {
      profileText: "친구별 예상 소요시간",
      titleImageText: friendSummary || "상세 경로는 서비스에서 확인해 주세요."
    }
  });
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
  document.body.style.overflow = "hidden";
  if (map && isMapReady) {
    map.relayout();
  }
  mapWrapEl?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeSheet() {
  sheetBackdropEl.style.display = "none";
  sheetEl.style.display = "none";
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
    row.innerHTML = `
      <div class="friendTimeLabel">${escapeHtml(pf.friendName)}${
        isLongest ? '<span class="friendTimeBadge">(최장시간)</span>' : ""
      }</div>
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
  let totalPoints = 0;
  const perFriend = item.perFriend;
  for (let i = 0; i < perFriend.length; i += 1) {
    const pf = perFriend[i];
    const color = friendRouteColor(i);
    const n = await appendPolylinesFromRaw(
      pf?.route?.raw,
      () => color,
      bounds
    );
    totalPoints += n;
  }
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
  await update();

  openSheet();
}

async function renderTopCandidates(results) {
  if (!isMapReady || !map) return;
  clearMapObjects();
  cardsEl.innerHTML = "";
  if (!results?.length) return;
  const item = results[0];
  lastResults = [item];
  const { lat, lng, name } = item.candidate;
  const address = await reverseGeocode(lat, lng);
  const reasonText = buildReasonSummary(item);

  const position = new kakao.maps.LatLng(lat, lng);
  const marker = new kakao.maps.Marker({ map, position });
  markers.push(marker);
  addCandidateRecommendCard(position, { name, address, reasonText });

  kakao.maps.event.addListener(marker, "dblclick", () => void openCandidateDetails(item, address));

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
    <div class="mt-1 text-xs text-slate-500">신뢰 등급: ${
      item?.candidate?.tier ? `Tier ${item.candidate.tier}` : "일반 후보"
    }</div>
    ${
      item?.candidate?.shiftedFrom
        ? `<div class="mt-1 text-xs text-slate-500">후보 보정: ${escapeHtml(item.candidate.shiftedFrom)} → ${escapeHtml(
            item.candidate.name
          )}</div>`
        : ""
    }
    <div class="mt-1 text-xs text-coral-600 font-bold">선정 이유: ${reasonText}</div>
    <div class="mt-1 text-xs text-slate-600">평균 ${Math.round(item.averageMinutes)}분 · 최대 ${Math.round(item.maxMinutes)}분</div>
    <div class="mt-3 flex flex-wrap gap-2">
      <button type="button" class="tap-press h-11 flex-1 rounded-2xl border border-coral-200 bg-coral-50 px-3 text-sm font-bold text-coral-600" data-action="details">세부 내용 조회</button>
      <button type="button" class="tap-press h-11 flex-1 rounded-2xl border border-coral-200 bg-coral-50 px-3 text-sm font-bold text-coral-600" data-action="share">카카오톡 공유</button>
    </div>
  `;
  card.querySelector('[data-action="details"]').addEventListener("click", () =>
    void openCandidateDetails(item, address)
  );
  card.querySelector('[data-action="share"]').addEventListener("click", () =>
    shareTopCandidate(item, address, reasonText)
  );
  cardsEl.appendChild(card);
  lastSharePayload = { item, address, reasonText };
  updateStickyShareButton();

  lastOverviewItem = item;
  mapStatusEl.textContent = "친구별 경로를 지도에 그리는 중...";
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
}

function addFriendRow(name = "", address = "", addressPlaceholder = "ex. 신도림역") {
  const row = document.createElement("div");
  row.className = "friend-row grid grid-cols-[110px_minmax(0,1fr)] gap-2";
  row.innerHTML = `
    <input type="text" placeholder="이름" value="${name}" class="name h-12 w-full min-w-0 rounded-2xl border border-coral-200 bg-[#fffdfb] px-3" autocomplete="name" enterkeyhint="next" />
    <input type="text" placeholder="${addressPlaceholder}" value="${address}" class="address h-12 w-full min-w-0 rounded-2xl border border-coral-200 bg-[#fffdfb] px-3" autocomplete="street-address" enterkeyhint="done" />
  `;
  friendsEl.appendChild(row);
}

addFriendRow("친구1", "", "ex. 신도림역");
addFriendRow("친구2", "", "ex. 문정역");
addFriendBtn.addEventListener("click", () => {
  const nextIndex = friendsEl.querySelectorAll(".friend-row").length + 1;
  const placeholder = stationPlaceholders[(nextIndex - 1) % stationPlaceholders.length];
  addFriendRow(`친구${nextIndex}`, "", placeholder);
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

  resultEl.textContent = "중간지점 계산 중...";
  cardsEl.innerHTML = "";
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
      resultEl.textContent = `계산 실패: ${data.error}`;
      return;
    }
    resultEl.textContent = "중간지점 계산 완료.";
    if (isMapReady) {
      await renderTopCandidates(data.results ?? []);
    } else {
      pendingResultsForMap = data.results ?? [];
      mapStatusEl.textContent = "지도 SDK 준비 후 자동으로 마커를 표시합니다.";
    }
  } catch (error) {
    resultEl.textContent = `요청 실패: ${String(error)}`;
  }
});

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
