export type StationTier = 1 | 2 | 3;

export interface StationMaster {
  name: string;
  tier: StationTier;
  region: "서울" | "경기";
}

export const STATION_MASTERS: StationMaster[] = [
  { name: "강남역", tier: 1, region: "서울" },
  { name: "홍대입구역", tier: 1, region: "서울" },
  { name: "건대입구역", tier: 1, region: "서울" },
  { name: "명동역", tier: 1, region: "서울" },
  { name: "잠실역", tier: 1, region: "서울" },
  { name: "서울역", tier: 1, region: "서울" },
  { name: "용산역", tier: 1, region: "서울" },
  { name: "수원역", tier: 1, region: "경기" },
  { name: "판교역", tier: 1, region: "경기" },
  { name: "서현역", tier: 1, region: "경기" },

  { name: "사당역", tier: 2, region: "서울" },
  { name: "신도림역", tier: 2, region: "서울" },
  { name: "영등포역", tier: 2, region: "서울" },
  { name: "왕십리역", tier: 2, region: "서울" },
  { name: "고속터미널역", tier: 2, region: "서울" },
  { name: "합정역", tier: 2, region: "서울" },
  { name: "성수역", tier: 2, region: "서울" },
  { name: "을지로입구역", tier: 2, region: "서울" },
  { name: "범계역", tier: 2, region: "경기" },
  { name: "인덕원역", tier: 2, region: "경기" },
  { name: "부평역", tier: 2, region: "경기" },
  { name: "정발산역", tier: 2, region: "경기" },
  { name: "구리역", tier: 2, region: "경기" },

  { name: "노원역", tier: 3, region: "서울" },
  { name: "수유역", tier: 3, region: "서울" },
  { name: "천호역", tier: 3, region: "서울" },
  { name: "목동역", tier: 3, region: "서울" },
  { name: "서울대입구역", tier: 3, region: "서울" },
  { name: "불광역", tier: 3, region: "서울" },
  { name: "상동역", tier: 3, region: "경기" },
  { name: "철산역", tier: 3, region: "경기" },
  { name: "야탑역", tier: 3, region: "경기" },
  { name: "금정역", tier: 3, region: "경기" }
];

function normalizeStationName(name: string): string {
  return name.replace(/\s+/g, "").replace(/역$/, "");
}

const masterTierByName = new Map(
  STATION_MASTERS.map((station) => [normalizeStationName(station.name), station.tier])
);

export function getStationTierByName(name: string): StationTier | undefined {
  return masterTierByName.get(normalizeStationName(name));
}

const masterNameByNormalized = new Map(
  STATION_MASTERS.map((station) => [normalizeStationName(station.name), station.name])
);

// Non-priority stations are shifted to verified nearby hubs.
const SHIFT_TARGETS: Record<string, string> = {
  남태령: "사당역",
  선바위: "사당역",
  낙성대: "서울대입구역",
  당산: "신도림역",
  신림: "서울대입구역",
  이수: "사당역",
  교대: "강남역",
  가산디지털단지: "신도림역",
  군자: "건대입구역",
  창동: "노원역",
  회기: "왕십리역"
};

export function getCanonicalMasterName(name: string): string | undefined {
  return masterNameByNormalized.get(normalizeStationName(name));
}

export function getShiftTargetName(name: string): string | undefined {
  const normalized = normalizeStationName(name);
  return SHIFT_TARGETS[normalized];
}
