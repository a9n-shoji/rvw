# CI execution

The `CI` workflow keeps the full validation scope on every PR. Quality checks, unit/integration tests
and eight E2E shards run independently. Windows fixture tests, dogfood smoke, package smoke and
CodeQL retain their existing coverage. Pushes to main still run the three-OS package matrix.

Each E2E shard has its own GitHub-hosted runner, build and pair of fixture servers. The planner in
`scripts/e2e-shards.ts` discovers spec/test files under `test/e2e`, then assigns the longest estimated
files first to the least-loaded shard. `scripts/e2e-timings.json` contains timing hints in seconds
from successful run `41284308594`; update these from CI logs when the suite changes materially.
New files automatically enter the plan with a 30-second estimate; stale hints for removed files do
not select them. Hints affect balance, never discovery or coverage. Assignment is deterministic
regardless of filesystem listing order, and each shard prints its file list.

`fullyParallel: false` and `workers: 1` deliberately preserve file-local test order and keep mutable
fixture state serial. Do not increase workers without first isolating the fixture servers and
database per worker. All tests are still selected; no path-based skipping, reduced assertions,
additional retries, or cached test results are used. CI downloads only Chromium's headless shell,
which is what the existing headless tests run; it does not need the full headed browser package.

The existing required check name `test` is an aggregate gate. It runs even when a dependency fails
or is skipped, and succeeds only when quality, unit/integration tests and every E2E shard succeed.
No repository protection rule change is needed. Matrix fail-fast is disabled so failures in one
shard do not hide the others. Cancelled superseded workflow runs remain cancelled. Failed shards
upload traces, screenshots and error contexts as `e2e-failure-N` artifacts, retained for seven days.

## Reproduce a shard

In a POSIX shell (PowerShell: set `$env:RVW_E2E_SHARD = '2/8'` first):

```sh
RVW_E2E_SHARD=2/8 pnpm test:e2e
```

Without the environment variable, `pnpm test:e2e` still runs the entire suite serially. For an
existing build, or just to inspect assignment:

```sh
RVW_E2E_SHARD=2/8 pnpm exec playwright test
RVW_E2E_SHARD=2/8 pnpm exec playwright test --list
```

Do not combine this environment variable with Playwright's native `--shard`; the config rejects
that combination to prevent selecting only a fraction of the intended tests. Native `--shard`
remains available without the environment variable, but does not reproduce the balanced CI groups.

Concurrent local runs also need separate `RVW_E2E_PORT`, `RVW_REALISTIC_E2E_PORT` and Playwright
`--output` values. Build once before starting them: concurrent builds overwrite the same `dist`.
Local parallel runs share CPU and are not representative of separate GitHub-hosted runner timings.

## Baseline and trade-off

Before sharding, successful PR #116 CI run `41284308594` took 8m04s: 32s for quality checks, 36s for
unit/integration tests, 9s for browser installation and 6m23s for build + serial E2E (213 tests).
The initial four-way version in run `41285748733` took 3m19s, with the slowest shard at 3m15s and
combined quality/unit at 2m10s. Sum of CI job durations rose from 10m32s to 15m28s (excluding CodeQL).

Simply increasing native sharding to eight gives an empty shard and a 68-test shard because files
are indivisible. Timing-balanced file assignment avoids that skew without breaking fixture order.
The largest spec file remains a lower bound on E2E latency. Separate quality/unit jobs remove their
serial dependency. Runner queueing, Windows setup and CodeQL can still affect the overall wait.

More runners increase aggregate setup/build time in exchange for shorter feedback. The existing
pnpm cache is reused; browser download and the small build do not add another cache or artifact
transfer dependency. These are standard runners on a public repository, so their compute usage is
free under current GitHub pricing; concurrency and resource limits still apply.
