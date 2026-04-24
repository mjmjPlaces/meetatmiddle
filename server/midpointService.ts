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
  usedRefineCandidates: 0
};

export function getMidpointRunMeta() {
  return { ...midpointRunMeta };
}

function centroid(points: Point[]): Point {
  const lat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const lng = points.reduce((sum, p) => sum + p.lng, 0) / points.length;
  return { lat, lng };
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
  let apiCallCount = 0;

  const dailyBudget = Number(process.env.DAILY_ODSAY_BUDGET ?? 15000);
  const usedToday = getApiMetrics().odsayCallsToday;
  const budgetRatio = dailyBudget > 0 ? usedToday / dailyBudget : 0;
  let maxCandidates = configuredMaxCandidates;
  let refineCandidates = configuredRefineCandidates;
  midpointRunMeta.degradedMode = false;
  midpointRunMeta.degradedReason = "";
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
  const subwayCandidates = await searchSubwayStationCandidates(center, maxCandidates);
  const rawCandidates =
    subwayCandidates.length > 0 ? subwayCandidates : makeCandidateGrid(center, maxCandidates);
  const candidatesWithMeta = applyPriorityCandidateMeta(rawCandidates);
  const candidates = await shiftNonPriorityCandidates(candidatesWithMeta);
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
    .slice(0, refineCandidates)
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

  console.log("[Midpoint] evaluation stats", {
    candidateCount: candidates.length,
    shortlistedCount: shortlisted.length,
    evaluatedCount: evaluations.length,
    apiCallCount,
    degradedMode: midpointRunMeta.degradedMode,
    degradedReason: midpointRunMeta.degradedReason,
    elapsedMs: Date.now() - startedAt
  });

  return evaluations.sort((a, b) => a.score - b.score).slice(0, topN);
}
