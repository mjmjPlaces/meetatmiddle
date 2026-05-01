import {
  geocodeAddress,
  getApiMetrics,
  getTransitRoute,
  makeCandidateGrid,
  searchSubwayStationCandidates
} from "./apis.js";
import { scoreBalanced } from "./scoring.js";
import {
  getCanonicalMasterName,
  getCommerceHubByName,
  getShiftTargetName,
  getStationTierByName
} from "./constants/station_master.js";
import {
  CandidatePoint,
  CandidateEvaluation,
  MidpointRequest,
  Point
} from "./types.js";

const midpointRunMeta = {
  degradedMode: false,
  degradedReason: "",
  usedMaxCandidates: 0,
  usedRefineCandidates: 0,
  autoRebalanced: false,
  autoRebalanceReason: ""
};

export function getMidpointRunMeta() {
  return { ...midpointRunMeta };
}

function friendTimeGapMinutes(perFriend: CandidateEvaluation["perFriend"]): number {
  if (!Array.isArray(perFriend) || perFriend.length < 2) return 0;
  const mins = perFriend.map((p) => Number(p.route.totalMinutes ?? 0)).filter((m) => Number.isFinite(m));
  if (mins.length < 2) return 0;
  return Math.max(0, Math.max(...mins) - Math.min(...mins));
}

function centroid(points: Point[]): Point {
  const lat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const lng = points.reduce((sum, p) => sum + p.lng, 0) / points.length;
  return { lat, lng };
}

function haversineMeters(a: Point, b: Point): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(x)));
}

function roughDistanceScore(candidate: CandidatePoint, points: Point[]): number {
  const distances = points.map((p) => {
    const dx = p.lng - candidate.lng;
    const dy = p.lat - candidate.lat;
    return Math.sqrt(dx * dx + dy * dy);
  });
  const max = Math.max(...distances);
  const avg = distances.reduce((a, b) => a + b, 0) / distances.length;
  return max + avg * 0.2;
}

function hasExpressRedBus(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const paths = (raw as { result?: { path?: Array<{ subPath?: Array<{ lane?: Array<{ busNo?: string }> }> }> } })
    .result?.path;
  if (!paths?.length) return false;

  const subPaths = paths[0]?.subPath ?? [];
  for (const subPath of subPaths) {
    const lanes = subPath.lane ?? [];
    for (const lane of lanes) {
      const busNo = lane.busNo?.trim();
      if (!busNo) continue;
      if (/^9\d{3}$/.test(busNo) || /^M\d+$/i.test(busNo)) {
        return true;
      }
    }
  }
  return false;
}

function priorityAdjustedRoughScore(candidate: CandidatePoint, baseScore: number): number {
  if (!candidate.tier) return baseScore + 0.03;
  if (candidate.tier === 1) return baseScore - 0.08;
  if (candidate.tier === 2) return baseScore - 0.04;
  return baseScore - 0.015;
}

function commerceScaleBonus(candidateName: string): number {
  const hub = getCommerceHubByName(candidateName);
  if (!hub) return 0;
  const trafficWeight: Record<string, number> = {
    very_high: 1.2,
    high: 0.8,
    medium: 0.4,
    low: 0
  };
  const gradeWeight: Record<string, number> = {
    S: 1.2,
    A: 0.7,
    B: 0.3
  };
  return (
    hub.connectivity * 0.25 +
    hub.psychological * 0.2 +
    hub.vibeScore * 0.2 +
    (trafficWeight[hub.eveningTraffic] ?? 0) +
    (gradeWeight[hub.commerceGrade] ?? 0)
  );
}

function isShiftTargetsEnabled(): boolean {
  const raw = (process.env.ENABLE_SHIFT_TARGETS ?? "true").trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off");
}

function representativeScore(candidate: CandidatePoint, points: Point[]): number {
  const rough = roughDistanceScore(candidate, points);
  const tierBonus =
    candidate.tier === 1 ? 0.08 : candidate.tier === 2 ? 0.04 : candidate.tier === 3 ? 0.015 : -0.03;
  return rough - tierBonus - commerceScaleBonus(candidate.name) * 0.005;
}

function clusterNearbyCandidates(
  candidates: CandidatePoint[],
  points: Point[],
  radiusM = 850
): CandidatePoint[] {
  const clusters: CandidatePoint[][] = [];

  for (const candidate of candidates) {
    let targetCluster: CandidatePoint[] | null = null;
    for (const cluster of clusters) {
      const hasNearby = cluster.some((existing) => haversineMeters(existing, candidate) <= radiusM);
      if (hasNearby) {
        targetCluster = cluster;
        break;
      }
    }
    if (targetCluster) {
      targetCluster.push(candidate);
    } else {
      clusters.push([candidate]);
    }
  }

  return clusters.map((cluster) => {
    const sorted = [...cluster].sort((a, b) => representativeScore(a, points) - representativeScore(b, points));
    const selected = sorted[0];
    if (cluster.length <= 1) return selected;
    const shiftedFrom = cluster
      .filter((c) => c.id !== selected.id)
      .map((c) => c.name)
      .slice(0, 3)
      .join(", ");
    if (!shiftedFrom) return selected;
    return { ...selected, shiftedFrom };
  });
}

function applyPriorityCandidateMeta(candidates: CandidatePoint[]): CandidatePoint[] {
  return candidates.map((candidate) => {
    const tier = getStationTierByName(candidate.name);
    return {
      ...candidate,
      tier,
      isPriority: Boolean(tier)
    };
  });
}

async function shiftNonPriorityCandidates(candidates: CandidatePoint[]): Promise<CandidatePoint[]> {
  if (!isShiftTargetsEnabled()) {
    return candidates;
  }
  const output: CandidatePoint[] = [];
  const seen = new Map<string, CandidatePoint>();

  for (const candidate of candidates) {
    if (candidate.isPriority) {
      const canonical = getCanonicalMasterName(candidate.name) ?? candidate.name;
      const key = canonical.replace(/\s+/g, "");
      const normalizedCandidate = { ...candidate, name: canonical };
      seen.set(key, normalizedCandidate);
      continue;
    }

    const shiftTarget = getShiftTargetName(candidate.name);
    if (!shiftTarget) {
      output.push(candidate);
      continue;
    }

    const targetKey = shiftTarget.replace(/\s+/g, "");
    const already = seen.get(targetKey);
    if (already) {
      if (!already.shiftedFrom) {
        already.shiftedFrom = candidate.name;
      }
      continue;
    }

    const targetPoint = await geocodeAddress(shiftTarget);
    const shifted: CandidatePoint = {
      id: `shifted-${candidate.id}`,
      name: shiftTarget,
      lat: targetPoint.lat,
      lng: targetPoint.lng,
      tier: getStationTierByName(shiftTarget),
      isPriority: true,
      shiftedFrom: candidate.name
    };
    seen.set(targetKey, shifted);
  }

  for (const candidate of seen.values()) {
    output.push(candidate);
  }
  return output;
}

export async function findMidpoints(req: MidpointRequest): Promise<CandidateEvaluation[]> {
  const startedAt = Date.now();
  const configuredMaxCandidates = req.options?.maxCandidates ?? 20;
  const configuredRefineCandidates = req.options?.refineCandidates ?? 6;
  const maxApiCalls = req.options?.maxApiCalls ?? 80;
  const transferPenalty = req.options?.transferPenalty ?? 8;
  const topN = req.options?.topN ?? 3;
  const farMinutesThreshold = 65;
  const expressBusBonus = 8;
  const autoRebalanceGapMin = Number(process.env.AUTO_REBALANCE_GAP_MIN ?? 30);
  const autoRebalanceMaxCandidates = Number(process.env.AUTO_REBALANCE_MAX_CANDIDATES ?? 60);
  const autoRebalanceRefineCandidates = Number(process.env.AUTO_REBALANCE_REFINE_CANDIDATES ?? 24);
  let apiCallCount = 0;

  const dailyBudget = Number(process.env.DAILY_ODSAY_BUDGET ?? 15000);
  const usedToday = getApiMetrics().odsayCallsToday;
  const budgetRatio = dailyBudget > 0 ? usedToday / dailyBudget : 0;
  let maxCandidates = configuredMaxCandidates;
  let refineCandidates = configuredRefineCandidates;
  midpointRunMeta.degradedMode = false;
  midpointRunMeta.degradedReason = "";
  midpointRunMeta.autoRebalanced = false;
  midpointRunMeta.autoRebalanceReason = "";
  if (budgetRatio >= 0.9) {
    maxCandidates = Math.min(maxCandidates, 8);
    refineCandidates = Math.min(refineCandidates, 3);
    midpointRunMeta.degradedMode = true;
    midpointRunMeta.degradedReason = "odsay_daily_budget_over_90_percent";
  }
  refineCandidates = Math.min(refineCandidates, maxCandidates);
  midpointRunMeta.usedMaxCandidates = maxCandidates;
  midpointRunMeta.usedRefineCandidates = refineCandidates;

  const friendPoints = await Promise.all(
    req.friends.map(async (friend) => ({
      ...friend,
      point: await geocodeAddress(friend.address)
    }))
  );
  console.log(
    "[Kakao] geocoded friend points",
    friendPoints.map((f) => ({
      friendId: f.id,
      friendName: f.name,
      input: f.address,
      lat: f.point.lat,
      lng: f.point.lng
    }))
  );

  const center = centroid(friendPoints.map((f) => f.point));
  async function evaluateCandidates(currentMaxCandidates: number, currentRefineCandidates: number) {
    const subwayCandidates = await searchSubwayStationCandidates(center, currentMaxCandidates);
    const rawCandidates =
      subwayCandidates.length > 0 ? subwayCandidates : makeCandidateGrid(center, currentMaxCandidates);
    const candidatesWithMeta = applyPriorityCandidateMeta(rawCandidates);
    const clusteredCandidates = clusterNearbyCandidates(
      candidatesWithMeta,
      friendPoints.map((f) => f.point)
    );
    const candidates = await shiftNonPriorityCandidates(clusteredCandidates);
    if (subwayCandidates.length === 0) {
      console.warn("[Midpoint] no subway station candidates from Kakao, fallback to grid");
    }
    const shortlisted = candidates
      .map((candidate) => ({
        candidate,
        roughScore: priorityAdjustedRoughScore(
          candidate,
          roughDistanceScore(candidate, friendPoints.map((f) => f.point))
        )
      }))
      .sort((a, b) => a.roughScore - b.roughScore)
      .slice(0, currentRefineCandidates)
      .map((item) => item.candidate);

    const evaluations: CandidateEvaluation[] = [];
    let bestScore = Number.POSITIVE_INFINITY;

    for (const candidate of shortlisted) {
      const orderedFriends = [...friendPoints].sort((a, b) => {
        const aDx = a.point.lng - candidate.lng;
        const aDy = a.point.lat - candidate.lat;
        const bDx = b.point.lng - candidate.lng;
        const bDy = b.point.lat - candidate.lat;
        return Math.sqrt(bDx * bDx + bDy * bDy) - Math.sqrt(aDx * aDx + aDy * aDy);
      });

      const perFriend: CandidateEvaluation["perFriend"] = [];
      let shouldSkipCandidate = false;

      for (const friend of orderedFriends) {
        if (apiCallCount >= maxApiCalls) {
          console.warn("[Midpoint] API call budget reached", { maxApiCalls });
          shouldSkipCandidate = true;
          break;
        }
        apiCallCount += 1;
        const route = await getTransitRoute(friend.point, candidate, {
          fromLabel: `${friend.name}(${friend.address})`,
          toLabel: `${candidate.name}[${candidate.lat},${candidate.lng}]`
        });
        perFriend.push({
          friendId: friend.id,
          friendName: friend.name,
          friendAddress: friend.address,
          startPoint: friend.point,
          route
        });

        const currentMax = Math.max(...perFriend.map((p) => p.route.totalMinutes));
        if (currentMax >= bestScore) {
          shouldSkipCandidate = true;
          break;
        }
      }

      if (shouldSkipCandidate || perFriend.length !== friendPoints.length) {
        continue;
      }

      const total = perFriend.reduce((sum, p) => sum + p.route.totalMinutes, 0);
      const max = Math.max(...perFriend.map((p) => p.route.totalMinutes));
      const evaluation: CandidateEvaluation = {
        candidate,
        perFriend,
        score: 0,
        averageMinutes: total / perFriend.length,
        maxMinutes: max
      };

      evaluation.score = scoreBalanced(evaluation, { transferPenalty });

      if (!evaluation.candidate.isPriority) {
        evaluation.score += 10;
      } else if (evaluation.candidate.tier === 1) {
        evaluation.score -= 6;
      } else if (evaluation.candidate.tier === 2) {
        evaluation.score -= 3;
      } else if (evaluation.candidate.tier === 3) {
        evaluation.score -= 1.5;
      }
      evaluation.score -= commerceScaleBonus(evaluation.candidate.name);

      const farRoutes = evaluation.perFriend.filter((p) => p.route.totalMinutes >= farMinutesThreshold);
      if (farRoutes.length > 0) {
        const redBusCount = farRoutes.filter((p) => hasExpressRedBus(p.route.raw)).length;
        if (redBusCount > 0) {
          evaluation.score -= redBusCount * expressBusBonus;
        }
      }

      evaluations.push(evaluation);
      bestScore = Math.min(bestScore, evaluation.score);
    }

    return {
      candidateCount: candidates.length,
      shortlistedCount: shortlisted.length,
      evaluations: evaluations.sort((a, b) => a.score - b.score)
    };
  }

  let evalRun = await evaluateCandidates(maxCandidates, refineCandidates);
  let finalEvaluations = evalRun.evaluations;

  const topGap = friendTimeGapMinutes(finalEvaluations[0]?.perFriend ?? []);
  const canExpandSearch =
    friendPoints.length === 2 &&
    topGap >= autoRebalanceGapMin &&
    !midpointRunMeta.degradedMode &&
    maxCandidates < autoRebalanceMaxCandidates;

  if (canExpandSearch) {
    const expandedMax = Math.min(autoRebalanceMaxCandidates, Math.max(maxCandidates * 2, maxCandidates + 20));
    const expandedRefine = Math.min(
      autoRebalanceRefineCandidates,
      Math.max(refineCandidates * 2, refineCandidates + 8)
    );
    midpointRunMeta.autoRebalanced = true;
    midpointRunMeta.autoRebalanceReason = `top_gap_${topGap}_over_${autoRebalanceGapMin}`;
    midpointRunMeta.usedMaxCandidates = expandedMax;
    midpointRunMeta.usedRefineCandidates = expandedRefine;

    const expandedRun = await evaluateCandidates(expandedMax, expandedRefine);
    if (expandedRun.evaluations.length > 0) {
      evalRun = expandedRun;
      finalEvaluations = expandedRun.evaluations;
    }
  }

  console.log("[Midpoint] evaluation stats", {
    candidateCount: evalRun.candidateCount,
    shortlistedCount: evalRun.shortlistedCount,
    evaluatedCount: finalEvaluations.length,
    apiCallCount,
    degradedMode: midpointRunMeta.degradedMode,
    degradedReason: midpointRunMeta.degradedReason,
    autoRebalanced: midpointRunMeta.autoRebalanced,
    autoRebalanceReason: midpointRunMeta.autoRebalanceReason,
    elapsedMs: Date.now() - startedAt
  });

  return finalEvaluations.slice(0, topN);
}
