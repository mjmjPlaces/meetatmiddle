# SameMeet Review Objectives and Key Issues

This document defines what external reviewers (for example, Claude Opus) should evaluate first.

## Product Context

- Service: SameMeet (`samemeet.com`)
- Purpose: Recommend fair transit-based meeting points for multiple friends.
- Stack:
  - Frontend: static web + vanilla JS + Kakao Maps SDK
  - Backend: Express + TypeScript
  - Infra: Vercel (frontend), Railway (API), optional Railway Redis, optional Postgres
  - External APIs: Kakao Local, ODsay

## Review Objectives (Priority Order)

1. **Speed and trust**
   - Are current latency optimizations enough for MVP?
   - Is the loading/progress UX trustworthy and clear?
2. **Ranking quality and fairness**
   - Does current scoring over-favor hotspot/commercial candidates?
   - Is dual-candidate mode a good fallback in high-spread cases?
3. **Decision data pipeline robustness**
   - Is the current event/session schema enough for product learning?
   - Are there missing events/fields needed before scale?
4. **Scale and cost safety**
   - Are caching and observability foundations sufficient for early growth?
   - What should be done before raising infra spend?

## Core User Problem to Validate

In 2-origin searches, users occasionally see high travel-time spread in top result.
We introduced a "dual-candidate mode" to keep an open-ended choice and collect behavior data instead of forcing one answer too early.

## Key Issues for Reviewer Feedback

### A. Algorithm / Ranking

- Current score is max-focused with additional adjustments.
- Need critique on:
  - spread handling for 2-user cases,
  - hotspot bias risk,
  - trigger thresholds for dual-candidate mode.

### B. UX / Explainability

- Users need clear rationale for why a place is selected.
- Need critique on:
  - candidate explanation wording,
  - dual-candidate comparison clarity,
  - confusion risk and simplification opportunities.

### C. Data Collection and Analytics Readiness

- Current tracked entities include:
  - share session,
  - selected place and confirmation time,
  - shared status,
  - origin snapshots (coarsened),
  - candidate events (impression and selection paths).
- Need critique on:
  - schema completeness for future model learning,
  - event quality controls and anti-noise strategy,
  - B2B reporting suitability.

### D. Architecture and Ops

- Optional Redis route cache and midpoint perf metrics are in place.
- Need critique on:
  - correctness and leverage of cache hierarchy,
  - p95 monitoring and alert thresholds,
  - next instrumentation to add before traffic growth.

## Expected Output Format from Reviewer

Please ask reviewer to return:

1. Top 5 risks (severity-ranked)
2. Top 5 improvements (effort vs impact)
3. Two-week execution plan
4. Metrics and acceptance criteria for each change
