# Opus Review Prompt (SameMeet)

You are reviewing a production-leaning side project called **SameMeet**.

## Scope

Please review the repository from four perspectives:

1. **Latency/performance realism**
2. **Ranking quality/fairness**
3. **Data pipeline quality for learning**
4. **Scale/cost readiness**

## Product Summary

- Purpose: recommend transit-based meeting points for friends.
- Core flow: user inputs origins -> gets ranked candidates -> reviews details -> shares result.
- Current infra:
  - Frontend: static web + vanilla JS + Kakao Maps
  - Backend: Express + TypeScript
  - Infra: Vercel + Railway
  - Optional components: Redis cache, Postgres session/event persistence

## What was recently added

- Midpoint perf observability:
  - p50/p95 latency and per-request ODsay call metrics
- Optional Redis route cache:
  - memory-first cache, Redis fallback/storage
- Session decision tracking:
  - selected place, shared status, coarsened origins
  - candidate event logging (impressions/selections)
- Dual-candidate mode:
  - when spread is high and top candidates are close, show 2 options for open-ended choice

## Key concern to focus on

In 2-origin searches, some top results still show large travel-time spread.
We want a robust approach that improves fairness without degrading practical usability.

## Constraints

- No secrets are provided.
- Assume coordinates are stored at coarse precision (privacy-aware).
- Recommendations should be implementable with low to moderate ops complexity.

## Requested Output Format

### A. Top risks (severity-ranked)
- Provide top 5 concrete risks.

### B. Improvements (impact vs effort)
- Provide top 8 improvements in this format:
  - change
  - expected impact
  - implementation effort
  - rollout risk

### C. Data model critique
- Evaluate whether current session + candidate event schema is enough for:
  - behavior-based ranking updates
  - B2B analytics
- List missing fields/events if any.

### D. Algorithm critique
- Evaluate current dual-candidate trigger logic.
- Suggest better thresholding or confidence logic.
- Suggest fairness controls for 2-origin edge cases.

### E. 2-week plan
- Provide a strict two-week implementation sequence with:
  - daily/phase tasks
  - KPIs
  - acceptance criteria

## Additional Notes

- Use architecture-level and product-level reasoning.
- Prefer practical, incremental rollout over large rewrites.
