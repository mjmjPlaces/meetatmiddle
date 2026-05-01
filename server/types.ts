export interface FriendInput {
  id: string;
  name: string;
  address: string;
}

export interface Point {
  lat: number;
  lng: number;
}

export interface CandidatePoint extends Point {
  id: string;
  name: string;
  tier?: 1 | 2 | 3;
  isPriority?: boolean;
  shiftedFrom?: string;
}

export interface RouteResult {
  totalMinutes: number;
  transferCount: number;
  raw?: unknown;
}

export interface CandidateEvaluation {
  candidate: CandidatePoint;
  perFriend: Array<{
    friendId: string;
    friendName: string;
    friendAddress?: string;
    startPoint: Point;
    route: RouteResult;
  }>;
  score: number;
  averageMinutes: number;
  maxMinutes: number;
  scoreBreakdown?: {
    baseBalancedScore: number;
    tierAdjust: number;
    commerceAdjust: number;
    expressAdjust: number;
    extremeGapAdjust: number;
    finalScore: number;
    gapMinutes: number;
  };
}

export interface MidpointRequest {
  friends: FriendInput[];
  options?: {
    topN?: number;
    maxCandidates?: number;
    refineCandidates?: number;
    maxApiCalls?: number;
    transferPenalty?: number;
  };
}
