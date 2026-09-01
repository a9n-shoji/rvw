# Viewer performance characterization

Date: 2026-09-01

This report records the reproducible performance boundary for comment placement and Structure
backlinks. Timings are diagnostic observations from the local Playwright fixture; request and Git-call
counts are the deterministic CI budgets.

## Scenarios

- Empty review and the normal fixture review provide the zero/small control.
- The stress fixture creates 100 repository line comments with a common exact source, opens a
  different repository diff, keeps the comment sidebar collapsed, then expands it.
- The placement integration characterization resolves the same 100 comments at a successor commit,
  first through the compatible one-comment operation and then in one batch with new and old document
  destinations.
- Structure tests cover zero Structures and multiple Structures sharing one source/target commit pair.

## Baseline on `origin/main`

| Scenario                                        |                                                                                                                                      HTTP / Git observation |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------: |
| 100 comments, document placement                | 100 old placement requests for one effective destination; up to 296 requests were observed while mutable PR Markdown and a second document identity settled |
| 100 comments, expanded sidebar                  |                                             100 old placement requests; the complete sidebar did not become ready within the 120 s characterization timeout |
| 100 compatible single-comment commit placements |                                                                                                     `hasObject` 200, `changedFiles` 100, `readDocument` 200 |
| Old browser placement endpoint                  |                                                                                                                           at least 100 requests per surface |

The dominant work was multiplicative: comment count × destination count × commit/document validation.
The sidebar also mounted and rendered every full thread while collapsed. The optimized shell keeps
only lightweight composer, filter, and selection state mounted while gating the list and placement
work on expansion.

## Result and CI budgets

| Scenario                              |                                                                                                                         Budget |                  Observed locally |
| ------------------------------------- | -----------------------------------------------------------------------------------------------------------------------------: | --------------------------------: |
| 100 comments, one document pane       |                                                                                                      1 batch placement request |        1 request, 171 ms to ready |
| 100 visible sidebar comments          |                                                                                                      1 batch placement request |        1 request, 145 ms to ready |
| Reply / resolve / reopen in sidebar   |                                                                                                0 additional placement requests |                                 0 |
| Local comment mutation                |                                                                    0 placement requests; asynchronous comments consistency GET |                   enforced by E2E |
| Repository metadata-only revision     |                                                                                                0 Git-backed document refetches |                   enforced by E2E |
| Repository location change            |                                                                                      cached Git-backed document refetched once |                   enforced by E2E |
| Placement target-set refresh          |                                                               surviving annotations remain; deleted annotation is not retained |                   enforced by E2E |
| Collapsed sidebar                     |                                                                                                    0 commit placement requests |                                 0 |
| Browser old single-placement endpoint |                                                                                                                              0 |                                 0 |
| 100 comments, new + old batch         |                                                                              `hasObject` 2, `changedFiles` 1, `readDocument` 2 |                         2 / 1 / 2 |
| No Structures                         |                                                                            `hasObject` 0, `tree` 0, `changedFilesWithCopies` 0 |                         0 / 0 / 0 |
| Structure reverse index               | `tree` 1, `changedFilesWithCopies` 1 per unique source/target pair, `readDocument` 0; 1 browser request per Structure revision | enforced by integration/E2E tests |

The Playwright timing values are reported but not used as hard CI thresholds. CI enforces network and
Git-call budgets so slower shared runners do not create false failures. The old single-placement
operation remains a semantic parity oracle and an explicit baseline characterization path.
The recorded timing observation is from the final 131-test Playwright run; focused runs varied while
remaining inside the same request-count budgets.

## Query and mutation boundary

- Placement cache identity is comment ID + immutable target + destination, plus PR or Walkthrough
  revision when mutable content participates. Post `updatedAt` and display ordering are excluded; each
  batch uses stable comment-ID order so a thread moving to the front does not invalidate placement.
- Repository document, diff, tree, changed-file, search, repository-file placement, and
  Structure-index queries use infinite freshness only when the key contains their complete immutable
  or revision-qualified identity. Because object availability also depends on repository location, the
  viewer compares
  `localRepositoryPath` and `gitCommonDir` after a scoped Pull Request refetch and invalidates all
  Git-backed queries for that PR only when either value actually changes. A status-only Pull Request
  revision does not trigger this invalidation.
- Comment mutations update the stable Pull Request comment query from the canonical server response.
  They cancel the exact query before the write, propagate the query `AbortSignal` through `fetch`, seed
  an initially missing cache, and preserve server `updatedAt DESC` ordering without replacing unrelated
  thread objects. Success and failure both start a non-awaited comments invalidation as a lightweight
  consistency barrier. There is no client-side revision credit; the GET restores a complete initial
  list and converges external or reversed concurrent mutations to the server snapshot. A later
  heartbeat may revalidate comments again after observing the mutation's domain revision; exactly one
  comments GET is not a budget.
  A PR-wide comment has no document placement identity, so its creation triggers no document or
  sidebar placement request even though it performs the comments consistency GET.
- The one-second poll remains the external synchronization mechanism. Domain revisions prevent a
  comment-only external update from refetching PR documents, Walkthroughs, Structures, or Structure
  backlinks. The initial comments GET waits for the first revision snapshot so a write immediately
  before baseline adoption is included rather than stranded in a stable cache.
- Pull Request metadata and title/body content have separate revisions. A no-op synchronization does
  not advance either revision; status-only changes do not invalidate PR Markdown or search. A location
  change leaves PR Markdown intact but invalidates repository-backed search with the other Git queries.
  Refresh responses atomically publish their revision snapshot to the viewer before PR Markdown is
  invalidated, so content and placement never combine different content revisions.
- Batch comment sync advances the comments revision from the update result, not merely from a non-empty
  requested reply/resolve operation. Replaying the same idempotency key or resolving an already-resolved
  thread therefore does not cause another comments GET.
- A placement batch accepts the complete comment list held by the viewer rather than introducing a
  500-comment product limit. Fixed concurrency and request-scoped caches bound Git subprocess work.
- Sidebar placement uses all non-PR targets independently of the unresolved/resolved filter. Repository
  panes send only repository-file comment IDs, and Pull Request Markdown panes send only PR Markdown
  comment IDs. The Walkthrough revision participates only when the batch contains a Walkthrough target.
  Presentation and unrelated domain changes therefore reuse the existing placement map.
- When a document placement key changes because comments were added or deleted, the pane retains the
  last placement response during the new batch and joins it only against current comment IDs. Existing
  annotations remain visible during the request, while a deleted thread disappears immediately.
- Structure reverse-index queries wait for the Structure list and refresh only when its
  `id:updatedAt` fingerprint changes, including deletion, producing one additional request per Structure
  revision.

## Regression commands

```bash
pnpm exec vitest run test/integration/application.test.ts --testNamePattern "request-scoped Git"
pnpm exec playwright test test/e2e/viewer-performance.spec.ts
pnpm exec playwright test test/e2e/file-structure-references.spec.ts
```
