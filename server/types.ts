export type Mode = "balanced" | "majority";

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
    startPoint: Point;
    route: RouteResult;
  }>;
  score: number;
  averageMinutes: number;
  maxMinutes: number;
}

export interface MidpointRequest {
  mode: Mode;
  friends: FriendInput[];
  options?: {
    topN?: number;
    maxCandidates?: number;
    refineCandidates?: number;
    maxApiCalls?: number;
    transferPenalty?: number;
    outlierWeight?: number;
    reducedOutlierCount?: number;
  };
}
