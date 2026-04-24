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
  const avg = adjusted.reduce((a, b) => a + b, 0) / adjusted.length;
  return max + avg * 0.1;
}
