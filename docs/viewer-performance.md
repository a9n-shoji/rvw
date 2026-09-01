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

| Scenario                              |                                                                               Budget |              Observed locally |
| ------------------------------------- | -----------------------------------------------------------------------------------: | ----------------------------: |
| 100 comments, one document pane       |                                                            1 batch placement request |    1 request, 141 ms to ready |
| 100 visible sidebar comments          |                                                            1 batch placement request |    1 request, 135 ms to ready |
| Collapsed sidebar                     |                                                          0 commit placement requests |                             0 |
| Browser old single-placement endpoint |                                                                                    0 |                             0 |
| 100 comments, new + old batch         |                                    `hasObject` 2, `changedFiles` 1, `readDocument` 2 |                     2 / 1 / 2 |
| No Structures                         |                                  `hasObject` 0, `tree` 0, `changedFilesWithCopies` 0 |                     0 / 0 / 0 |
| Structure reverse index               | `tree` 1, `changedFilesWithCopies` 1 per unique source/target pair, `readDocument` 0 | enforced by integration tests |

The Playwright timing values are reported but not used as hard CI thresholds. CI enforces network and
Git-call budgets so slower shared runners do not create false failures. The old single-placement
operation remains a semantic parity oracle and an explicit baseline characterization path.
The recorded timing observation is from the final 126-test Playwright run; focused runs varied while
remaining inside the same request-count budgets.

## Query and mutation boundary

- Placement cache identity is comment ID + immutable target + destination, plus PR or Walkthrough
  revision when mutable content participates. Post `updatedAt` and display ordering are excluded; each
  batch uses stable comment-ID order so a thread moving to the front does not invalidate placement.
- Repository document, diff, tree, changed-file, search, placement, and Structure-index queries use
  infinite freshness only when the key contains their complete immutable or revision-qualified
  identity.
- Comment mutations update the stable Pull Request comment query from the canonical server response.
  They cancel the exact query before the write and again before the canonical update, propagate the
  query `AbortSignal` through `fetch`, seed an initially missing cache, and preserve server
  `updatedAt DESC` ordering without replacing unrelated thread objects.
  A PR-wide comment has no document placement identity, so its creation triggers no document or
  sidebar placement request and no immediate comments-list refetch.
- The one-second poll remains the external synchronization mechanism. Domain revisions prevent a
  comment-only external update from refetching PR documents, Walkthroughs, Structures, or Structure
  backlinks.
- Pull Request metadata and title/body content have separate revisions. A no-op synchronization does
  not advance either revision; status/location-only changes do not invalidate PR Markdown or search.
- A placement batch accepts the complete comment list held by the viewer rather than introducing a
  500-comment product limit. Fixed concurrency and request-scoped caches bound Git subprocess work.

## Regression commands

```bash
pnpm exec vitest run test/integration/application.test.ts --testNamePattern "request-scoped Git"
pnpm exec playwright test test/e2e/viewer-performance.spec.ts
pnpm exec playwright test test/e2e/file-structure-references.spec.ts
```
