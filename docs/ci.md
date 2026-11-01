# CI execution

The `CI` workflow keeps the full validation scope on every PR. Quality checks and unit/integration
tests run alongside four E2E shards. Windows fixture tests, dogfood smoke, package smoke and CodeQL
retain their existing coverage. Pushes to main still run the three-OS package matrix.

Each E2E shard has its own GitHub-hosted runner, build and pair of fixture servers. Playwright assigns
whole spec files with `--shard=N/4`. `fullyParallel: false` and `workers: 1` deliberately preserve
file-local test order and keep mutable fixture state serial. Do not increase workers without first
isolating the fixture servers and database per worker. All tests are still selected; no path-based
skipping, reduced assertions, additional retries, or cached test results are used.

The existing required check name `test` is an aggregate gate. It runs even when a dependency fails
or is skipped, and succeeds only when quality and every E2E shard succeed. No repository protection
rule change is needed. Matrix fail-fast is disabled so failures in one shard do not hide the others.
Cancelled superseded workflow runs remain cancelled. Failed shards upload traces, screenshots and
error contexts as `e2e-failure-N` artifacts, retained for seven days.

## Reproduce a shard

```sh
pnpm test:e2e --shard=2/4
```

The usual `pnpm test:e2e` still runs the entire suite serially. For an existing build:

```sh
pnpm exec playwright test --shard=2/4
pnpm exec playwright test --list --shard=2/4
```

Concurrent local runs also need separate `RVW_E2E_PORT`, `RVW_REALISTIC_E2E_PORT` and Playwright
`--output` values. Build once before starting them: concurrent builds overwrite the same `dist`.
Local parallel runs share CPU and are not representative of separate GitHub-hosted runner timings.

## Baseline and trade-off

Before sharding, the successful PR #116 CI run `41284308594` took 8m04s in the `test` job: 32s for
quality checks, 36s for unit/integration tests, 9s for browser installation and 6m23s for build + E2E.
The 213 tests ran on one worker. File-level four-way sharding assigns 57/50/59/47 tests; baseline test
body times total approximately 84/130/66/94 seconds respectively. These are estimates, not measured
end-to-end CI durations; runner startup and fixture setup also count.

Four runners increase aggregate setup/build minutes in exchange for shorter feedback time. The
existing pnpm cache is reused; browser download and the small build are not given another cache or
artifact-transfer dependency. Re-evaluate shard balance using the per-file timings in CI logs when
the suite grows. The exact file distribution follows Playwright discovery, not a manually maintained
list that could omit new tests.
