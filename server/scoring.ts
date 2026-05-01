import { CandidateEvaluation, RouteResult } from "./types.js";

interface ScoreParams {
  transferPenalty: number;
}

function withTransferPenalty(route: RouteResult, transferPenalty: number): number {
  return route.totalMinutes + route.transferCount * transferPenalty;
}

export function scoreBalanced(
  candidate: CandidateEvaluation,
  params: ScoreParams
): number {
  const adjusted = candidate.perFriend.map((entry) =>
    withTransferPenalty(entry.route, params.transferPenalty)
  );
  const max = Math.max(...adjusted);
  const min = Math.min(...adjusted);
  const avg = adjusted.reduce((a, b) => a + b, 0) / adjusted.length;
  const gap = Math.max(0, max - min);
  // Keep "worst-case" (max) priority, but explicitly penalize friend-to-friend time gap.
  return max + avg * 0.1 + gap * 0.35;
}
