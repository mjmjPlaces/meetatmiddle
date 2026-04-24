import { COMMERCE_HUBS } from "../../priority_place_100/commerce_hubs.js";

export type StationTier = 1 | 2 | 3;

export type StationRegion = "서울" | "경기" | "인천";

export interface StationMaster {
  name: string;
  tier: StationTier;
  region: StationRegion;
}

/** 수도권 상권 거점 100 — `priority_place_100/commerce_hubs.ts` 단일 소스 */
export const STATION_MASTERS: StationMaster[] = COMMERCE_HUBS.map((h) => ({
  name: h.name,
  tier: h.tier,
  region: h.region
}));

function normalizeStationName(name: string): string {
  return name
    .replace(/\s+/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\d+호선/g, "")
    .replace(/역$/, "");
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

const hubByNormalized = new Map(
  COMMERCE_HUBS.map((hub) => [normalizeStationName(hub.name), hub])
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

export function getCommerceHubByName(name: string) {
  return hubByNormalized.get(normalizeStationName(name));
}

export function getShiftTargetName(name: string): string | undefined {
  const normalized = normalizeStationName(name);
  return SHIFT_TARGETS[normalized];
}
