const friendsEl = document.getElementById("friends");
const addFriendBtn = document.getElementById("addFriend");
const runBtn = document.getElementById("run");
const modeEl = document.getElementById("mode");
const resultEl = document.getElementById("result");
const cardsEl = document.getElementById("cards");
const mapEl = document.getElementById("map");
const mapStatusEl = document.getElementById("mapStatus");
const sheetBackdropEl = document.getElementById("sheetBackdrop");
const sheetEl = document.getElementById("sheet");
const sheetCloseEl = document.getElementById("sheetClose");
const sheetTitleEl = document.getElementById("sheetTitle");
const sheetSubtitleEl = document.getElementById("sheetSubtitle");
const friendSelectEl = document.getElementById("friendSelect");
const pathListEl = document.getElementById("pathList");
const friendTimeListEl = document.getElementById("friendTimeList");
const stationPlaceholders = [
  "ex. 신도림역",
  "ex. 문정역",
  "ex. 사당역",
  "ex. 왕십리역",
  "ex. 합정역",
  "ex. 잠실역"
];

let map;
let geocoder;
let markers = [];
let infoWindows = [];
let isMapReady = false;
let mapInitTried = false;
let pendingResultsForMap = null;
let sdkInjected = false;
let lastResults = [];
let routePolylines = [];
let markersHiddenForSheet = false;
let routeMarkers = [];
let routeLabelOverlays = [];
let reasonOverlays = [];
let kakaoJsKey = "";

async function injectKakaoSdk() {
  if (sdkInjected) return;
  sdkInjected = true;
  mapStatusEl.textContent = "Kakao SDK 스크립트 요청 중...";

  try {
    const res = await fetch("/api/public-config");
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
  if (!kakaoJsKey) return false;
  if (window.Kakao?.isInitialized?.()) return true;

  if (!document.querySelector('script[data-kakao-share-sdk="1"]')) {
    const shareScript = document.createElement("script");
    shareScript.src = "https://t1.kakaocdn.net/kakao_js_sdk/2.7.4/kakao.min.js";
    shareScript.integrity =
      "sha384-DKYJsiAenoxQfQ3fU8XnY49ed41fR3kqwXdx4N4N6mErdlQ5fCHfY5mH8rquKy7L";
    shareScript.crossOrigin = "anonymous";
    shareScript.dataset.kakaoShareSdk = "1";
    document.head.appendChild(shareScript);
    await new Promise((resolve, reject) => {
      shareScript.onload = resolve;
      shareScript.onerror = reject;
    }).catch(() => null);
  }

  if (!window.Kakao) return false;
  if (!window.Kakao.isInitialized()) {
    window.Kakao.init(kakaoJsKey);
  }
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
    renderTopCandidates(pendingResultsForMap);
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

function clearMapObjects() {
  markers.forEach((marker) => marker.setMap(null));
  infoWindows.forEach((window) => window.close());
  reasonOverlays.forEach((overlay) => overlay.setMap(null));
  markers = [];
  infoWindows = [];
  reasonOverlays = [];
}

function setCandidateMarkersVisible(visible) {
  markersHiddenForSheet = !visible;
  markers.forEach((m) => m.setMap(visible ? map : null));
  if (!visible) {
    infoWindows.forEach((w) => w.close());
  }
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

function addReasonOverlay(position, reasonText) {
  const content = `<div class="reasonBadge"><span class="reasonDot"></span>${escapeHtml(reasonText)}</div>`;
  const overlay = new kakao.maps.CustomOverlay({
    map,
    position,
    content,
    yAnchor: 2.3
  });
  reasonOverlays.push(overlay);
}

async function shareTopCandidate(item, address, reasonText) {
  const ready = await ensureKakaoShareReady();
  if (!ready) {
    resultEl.textContent = "카카오 공유 SDK 초기화에 실패했습니다. KAKAO_JS_KEY 설정을 확인해 주세요.";
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
      title: `우리 모임 1순위 중간지점: ${destinationName}`,
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
  if (markers.length) setCandidateMarkersVisible(false);
}

function closeSheet() {
  sheetBackdropEl.style.display = "none";
  sheetEl.style.display = "none";
  document.body.style.overflow = "";
  clearRouteOverlay();
  if (markersHiddenForSheet) setCandidateMarkersVisible(true);
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

function renderFriendTimeList(perFriend) {
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
    const row = document.createElement("div");
    row.className = `friendTimeItem${isLongest ? " friendTimeItemLongest" : ""}`;
    row.innerHTML = `
      <div class="friendTimeLabel">${escapeHtml(pf.friendName)}${
        isLongest ? '<span class="friendTimeBadge">최장</span>' : ""
      }</div>
      <div class="friendTimeValue">${pf?.route?.totalMinutes ?? "?"}분 (환승 ${
        pf?.route?.transferCount ?? "?"
      })</div>
    `;
    friendTimeListEl.appendChild(row);
  });
}

function extractMapObj(raw) {
  return raw?.result?.path?.[0]?.info?.mapObj || "";
}

async function drawRouteOnMap(raw) {
  if (!isMapReady || !map) return;
  clearRouteOverlay();
  const mapObj = extractMapObj(raw);
  if (!mapObj) return;

  const res = await fetch(`/api/odsay/loadLane?mapObj=${encodeURIComponent(mapObj)}`);
  const data = await res.json();
  if (data?.error) {
    console.warn("loadLane error", data.error);
    return;
  }

  const lanes = data?.result?.lane ?? [];
  const bounds = new kakao.maps.LatLngBounds();
  let pointCount = 0;

  const colorForLane = (lane) => {
    const type = Number(lane?.type);
    if (type === 1) return "#1E88E5"; // subway
    if (type === 2) return "#E53935"; // bus
    if (type === 3) return "#43A047"; // express/intercity
    return "#6D4C41";
  };

  for (const lane of lanes) {
    const sections = lane?.section ?? [];
    for (const section of sections) {
      const graph = section?.graphPos ?? [];
      if (!graph.length) continue;
      const path = graph
        .map((p) => {
          const lat = Number(p.y);
          const lng = Number(p.x);
          const ll = new kakao.maps.LatLng(lat, lng);
          bounds.extend(ll);
          pointCount += 1;
          return ll;
        })
        .filter(Boolean);
      if (path.length < 2) continue;
      const polyline = new kakao.maps.Polyline({
        map,
        path,
        strokeWeight: 5,
        strokeColor: colorForLane(lane),
        strokeOpacity: 0.85,
        strokeStyle: "solid"
      });
      routePolylines.push(polyline);
    }
  }

  if (pointCount > 0) {
    map.setBounds(bounds);
  }
}

function addRouteMarkers(startPoint, endPoint, labels) {
  if (!isMapReady || !map) return;
  if (!startPoint?.lat || !startPoint?.lng || !endPoint?.lat || !endPoint?.lng) return;

  const startPos = new kakao.maps.LatLng(startPoint.lat, startPoint.lng);
  const endPos = new kakao.maps.LatLng(endPoint.lat, endPoint.lng);

  const svgPin = (color) => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 34 44">` +
      `<path d="M17 0C7.6 0 0 7.3 0 16.3c0 10.4 13.3 26.7 16.1 30.1.5.7 1.6.7 2.1 0C20.7 43 34 26.7 34 16.3 34 7.3 26.4 0 17 0z" fill="${color}"/>` +
      `<circle cx="17" cy="16.5" r="6.2" fill="#fff" fill-opacity="0.95"/>` +
      `</svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  };

  const startImage = new kakao.maps.MarkerImage(svgPin("#1E88E5"), new kakao.maps.Size(34, 44), {
    offset: new kakao.maps.Point(17, 44)
  });
  const endImage = new kakao.maps.MarkerImage(svgPin("#8E24AA"), new kakao.maps.Size(34, 44), {
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
  sheetTitleEl.textContent = item?.candidate?.name ? `상세 경로 - ${item.candidate.name}` : "상세 경로";
  sheetSubtitleEl.textContent = address ? `주소: ${address}` : "";

  const perFriend = item?.perFriend ?? [];
  renderFriendTimeList(perFriend);
  friendSelectEl.innerHTML = "";
  perFriend.forEach((pf, idx) => {
    const opt = document.createElement("option");
    opt.value = String(idx);
    opt.textContent = `${pf.friendName} (${pf.route?.totalMinutes ?? "?"}분)`;
    friendSelectEl.appendChild(opt);
  });

  const update = () => {
    const idx = Number(friendSelectEl.value || "0");
    const pf = perFriend?.[idx];
    const raw = pf?.route?.raw;
    renderPathList(summarizeOdsayPath(raw));
    void drawRouteOnMap(raw);
    addRouteMarkers(pf?.startPoint, item?.candidate, {
      startLabel: `출발(${pf?.friendName ?? "친구"})`,
      endLabel: `도착(${item?.candidate?.name ?? "중간지점"})`
    });
  };
  friendSelectEl.onchange = update;
  update();

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
  addReasonOverlay(position, reasonText);

  const infoHtml = `
    <div style="padding:10px;min-width:260px;line-height:1.45;">
      <strong>추천 1순위: ${name}</strong><br />
      <span>주소: ${address}</span><br />
      <span style="color:#b7442a;font-weight:700;">${reasonText}</span>
    </div>
  `;
  const infoWindow = new kakao.maps.InfoWindow({ content: infoHtml });
  infoWindows.push(infoWindow);
  infoWindow.open(map, marker);
  kakao.maps.event.addListener(marker, "click", () => infoWindow.open(map, marker));
  kakao.maps.event.addListener(marker, "dblclick", () => openCandidateDetails(item, address));

  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `
    <strong>추천 1순위 - ${name}</strong>
    <div class="meta">주소: ${address}</div>
    <div class="meta">신뢰 등급: ${item?.candidate?.tier ? `Tier ${item.candidate.tier}` : "일반 후보"}</div>
    ${
      item?.candidate?.shiftedFrom
        ? `<div class="meta">후보 보정: ${escapeHtml(item.candidate.shiftedFrom)} → ${escapeHtml(
            item.candidate.name
          )}</div>`
        : ""
    }
    <div class="meta">선정 이유: ${reasonText}</div>
    <div class="meta">평균 ${Math.round(item.averageMinutes)}분 · 최대 ${Math.round(item.maxMinutes)}분</div>
    <div class="cardActions">
      <button type="button" class="btnPrimary" data-action="details">세부 내용 조회</button>
      <button type="button" class="btnPrimary" data-action="share">카카오톡 공유</button>
    </div>
  `;
  card.querySelector('[data-action="details"]').addEventListener("click", () =>
    openCandidateDetails(item, address)
  );
  card.querySelector('[data-action="share"]').addEventListener("click", () =>
    shareTopCandidate(item, address, reasonText)
  );
  cardsEl.appendChild(card);

  fitBounds([item.candidate]);
  mapStatusEl.textContent = "1순위 추천 지점과 선정 이유를 지도에 표시했습니다.";
}

function addFriendRow(name = "", address = "", addressPlaceholder = "ex. 신도림역") {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `
    <input placeholder="이름" value="${name}" class="name" />
    <input placeholder="${addressPlaceholder}" value="${address}" class="address" style="width:420px" />
  `;
  friendsEl.appendChild(row);
}

addFriendRow("친구1", "", "ex. 신도림역");
addFriendRow("친구2", "", "ex. 문정역");
addFriendBtn.addEventListener("click", () => {
  const nextIndex = friendsEl.querySelectorAll(".row").length + 1;
  const placeholder = stationPlaceholders[(nextIndex - 1) % stationPlaceholders.length];
  addFriendRow(`친구${nextIndex}`, "", placeholder);
});

runBtn.addEventListener("click", async () => {
  const rows = [...friendsEl.querySelectorAll(".row")];
  const friends = rows
    .map((row, index) => ({
      id: `f-${index + 1}`,
      name: row.querySelector(".name").value.trim() || `친구${index + 1}`,
      address: row.querySelector(".address").value.trim()
    }))
    .filter((f) => f.address.length > 0);

  const payload = {
    mode: modeEl.value,
    friends,
    options: {
      topN: 3,
      maxCandidates: 12,
      transferPenalty: 8,
      outlierWeight: 0.5,
      reducedOutlierCount: 1
    }
  };

  resultEl.textContent = "중간지점 계산 중...";
  cardsEl.innerHTML = "";
  clearMapObjects();
  try {
    const res = await fetch("http://localhost:4000/api/midpoint", {
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

ensureMapReady();
