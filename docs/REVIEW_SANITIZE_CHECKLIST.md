# Review Sanitization Checklist

Use this checklist before sharing repository/branch access to external reviewers.

## 1) Secrets and Credentials

- [ ] Ensure these files are NOT shared:
  - [ ] `.env`
  - [ ] `.env.local`
  - [ ] any credentials export / secret backup files
- [ ] Remove or mask any hardcoded values:
  - [ ] API keys
  - [ ] access tokens
  - [ ] webhook URLs
  - [ ] database connection strings
  - [ ] redis connection strings

## 2) Infrastructure Identifiers

- [ ] Mask sensitive internal hostnames if needed
- [ ] Keep only public product domain references when possible
- [ ] Remove internal environment-specific notes that reveal security posture

## 3) User / Location Privacy

- [ ] Do not share raw user addresses from logs/screenshots
- [ ] Keep location precision coarse:
  - [ ] <= 3 decimal coordinates OR
  - [ ] legal-dong level textual region
- [ ] Exclude chat screenshots containing personal info

## 4) Logs and Debug Data

- [ ] Strip stack traces that include secrets/headers
- [ ] Remove request/response dumps with personal payloads
- [ ] Avoid sharing third-party API raw responses if they include user data

## 5) Repository Hygiene

- [ ] Create dedicated review branch (example: `review/opus-sanitized`)
- [ ] Include only files needed for architectural/product review
- [ ] Keep this branch read-only for reviewer if possible

## 6) What is Safe to Share

- [ ] Non-sensitive source code
- [ ] Schema definitions without secrets
- [ ] Aggregated metrics (`p50/p95`, cache hit rates)
- [ ] Product goals and issue statements
- [ ] Sanitized sample payloads

## 7) Final Pre-share Validation

- [ ] Run quick search for risky terms in review branch:
  - `API_KEY`
  - `SECRET`
  - `TOKEN`
  - `PASSWORD`
  - `DATABASE_URL`
  - `REDIS_URL`
  - `WEBHOOK`
- [ ] Verify no real credential-like values remain
- [ ] Confirm reviewers only need architecture/product feedback scope
