import { CandidateEvaluation, RouteResult } from "./types.js";

interface ScoreParams {
  transferPenalty: number;
  outlierWeight: number;
  reducedOutlierCount: number;
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

export function scoreMajority(
  candidate: CandidateEvaluation,
  params: ScoreParams
): number {
  const adjusted = candidate.perFriend
    .map((entry) => withTransferPenalty(entry.route, params.transferPenalty))
    .sort((a, b) => b - a);

  const weighted = adjusted.map((minutes, index) =>
    index < params.reducedOutlierCount ? minutes * params.outlierWeight : minutes
  );
  return weighted.reduce((a, b) => a + b, 0) / weighted.length;
}
