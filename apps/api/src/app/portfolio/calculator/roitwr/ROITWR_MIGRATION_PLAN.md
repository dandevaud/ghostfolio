# ROITWR Migration Plan

## Goal

Migrate `RoiTwrPortfolioCalculator` away from legacy symbol metrics helper usage and onto the new `PortfolioCalculator` abstract flow, while preserving legacy ROITWR calculation behavior.

## Constraints

- Keep behavior parity with previous ROITWR calculations as far as possible.
- Use the new base hooks in `portfolio-calculator.ts`:
  - `calculateOverallPerformance`
  - `calculatePerformancePercentages`
  - `calculatePerformancePercentagesForDateRange`
  - `getHoldingPerformance`
- Avoid reintroducing `getSymbolMetrics`-driven flow.

## Work Items

- [x] Create migration plan and track progress in repository.
- [x] Replace ROITWR stubs with implementations that compile against abstract base methods.
- [x] Route holding performance through `getMethodIndependentHoldingPerformance`.
- [x] Reintroduce ROITWR invested-capital computations at holding level.
- [x] Reintroduce ROITWR portfolio invested-capital timeline for percentage calculations.
- [x] Reintroduce ROITWR date-range percentage calculations.
- [x] Add legacy-like date-range basis calculation for `netPerformancePercentageWithCurrencyEffectMap`.
- [~] Validate parity with focused ROITWR tests.
- [ ] Reconcile any parity deltas (especially sell handling and date-range basis).
- [x] Restore ROITWR time-weighted chart fields needed by analysis timeline rendering.

## Notes on Legacy Parity

Legacy helper logic used sell proceeds in some investment basis calculations.  
The migration implementation preserves this via a ROITWR-local series builder over valuation activities.

## Progress Log

### 2026-11-15

- Added this migration plan file.
- Implemented the first migration slice in `roitwr/portfolio-calculator.ts`:
  - Implemented missing abstract methods.
  - Replaced placeholder holding performance path with base method-independent valuation path.
  - Added ROITWR-specific invested-capital timeline logic and date-range basis logic.
  - Restored compile for `api:build`.
- Validation:
  - ✅ `nx run api:build` succeeds.
  - ✅ Fixed ROITWR spec harness issues:
    - updated stale imports to `services/*`
    - fixed `CurrentRateService` constructor usage in specs
    - removed stray `.only` from ROITWR specs
    - aligned ROITWR specs to use `PerformanceCalculationType.ROITWR`
  - ⚠️ Focused ROITWR specs now execute and reveal behavior/expectation deltas:
    - some snapshots expect legacy `timeWeightedInvestment*` fields on positions
    - some snapshots expect old chart field shape (missing dividend fields / expecting time-weighted chart fields)
    - some assertions compare serialized values while runtime now exposes `Big` instances in matched objects

### 2026-11-15 (follow-up)

- Added ROITWR time-weighted timeline fields in
  `calculatePerformancePercentages()` by mapping:
  - `timeWeightedPerformanceInPercentage = netPerformanceInPercentage`
  - `timeWeightedPerformanceInPercentageWithCurrencyEffect = netPerformanceInPercentageWithCurrencyEffect`
- Extended `PerformancePercentages` type to allow optional ROITWR
  `timeWeightedPerformance*` fields.
- This restores the `timeWeightedPerformanceInPercentageWithCurrencyEffect`
  payload expected by client analysis chart logic for ROITWR mode.
- Validation:
  - ✅ `npx nx run client:build`
  - ⚠️ `npx nx run api:test --test-file app/portfolio/calculator/roitwr` still fails on remaining known parity gaps (legacy position `timeWeightedInvestment*` fields and test expectations around `Big`/shape differences), but no new regression from this chart-field fix.

### 2026-11-15 (follow-up 2)

- Reworked ROITWR holding investment accumulation to legacy sell-proceeds
  behavior by replacing `investmentValuesAccumulated*` with ROITWR-specific
  timelines derived from valuation activities.
- Fixed a base timeline compounding bug in
  `PortfolioCalculator.calculateTimeWeightedPerformance()` where `0` was
  treated as "missing previous value" (truthy check). This caused the first
  non-zero step to be dropped and could flatten ROITWR timeline output to zero.
- Validation:
  - ✅ `npx nx run api:build`
  - ⚠️ `npx nx run api:test --test-file app/portfolio/calculator/roitwr`
    remains on the same known parity mismatches unrelated to this chart/timeline
    fix scope.

### 2026-11-15 (follow-up 3)

- Fixed investment timeline aggregation bug in base calculator:
  `investmentValueWithCurrencyEffect` now aggregates per-date investment flows
  (`investmentValuesWithCurrencyEffect`) instead of accumulated balances.
- Extended ROITWR holding migration to restore legacy sell-proceeds flows in
  `investmentValuesWithCurrencyEffect` (not only accumulated values), so
  `/portfolio/investments` and grouped timelines use ROITWR-accurate flows.
- Validation:
  - ✅ `npx nx run api:build`
