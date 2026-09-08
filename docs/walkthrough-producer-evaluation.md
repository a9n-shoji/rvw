# Walkthrough producer evaluation

This record evaluates whether the Walkthrough producer builds a small, source-verifiable reading path
and chooses diagrams by the question rather than by a diagram-count target. It separates schema,
source, Mermaid syntax/rendering, binding, producer-generation, and qualitative claims. None of these
examples was published into an rvw review environment.

## Current instruction revision (2026-09-08)

The implementation baseline was `2a2d9dcd4da7b227db4ebc71f297a1e45ba86787`; the evaluated
authoring instruction content was:

- `skills/rvw-walkthrough/SKILL.md` Git-compatible content blob
  `5d62f9a6a7169f3b5a50ca14e6a184076fb22552`
- `skills/rvw-walkthrough/references/walkthrough-authoring.md` Git-compatible content blob
  `b4f55e72bd388c19782a72862bea9afd7321443d`

After those authoring runs, a final contract audit changed only the producer's capability preflight:
new publication no longer requires the unrelated `walkthrough.read` capability, while update and
delete still require a current-value read. The current `skills/rvw-walkthrough/SKILL.md`
Git-compatible content blob is `c8ae134c551457878f7fca25bea948ba98649706`; the authoring guide is
unchanged. The examples were not regenerated after this operation-only correction, so the hashes above
remain the exact instruction revision for their authoring decisions rather than being relabeled as a
fresh generation under the current preflight text.

Four fresh forward cases—review bootstrap, Hide Whitespace, runtime handoff, and Markdown code sizing—
used committed main-line source and producer contexts that had not been told which diagram notation or
count to choose. Each producer read the current Skill and authoring reference, inspected the change plus
surrounding code and tests, authored one content value, and stopped before any rvw Artifact mutation.
The verification-handoff example was authored with the three-surface composition fixture during
implementation and receives the same automated and qualitative checks; it is not claimed as a fifth
fresh-context run. The tracked JSON files are content-only fixtures; a production caller would add its
Pull Request field separately.

| Case                                                                                    | Exact source                               | Producer choice                                  | Question answered                                                                                                              |
| --------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| [Verification handoff](examples/walkthroughs/review-composition-verification-path.json) | `f9416d959dbb79f95dd75d96bafeb6156155f5c8` | `sequenceDiagram`                                | How a bounded composer claim is independently checked by one producer and may return as a correction or conflict.              |
| [Review bootstrap](examples/walkthroughs/review-bootstrap-lifecycle.json)               | `90ce0b8549fd9607526e5181fa3e7e7ae437a582` | partial `stateDiagram-v2`                        | Which initial review-screen condition is visible while dependent requests progress, and why loading/error is not “no commits.” |
| [Hide Whitespace](examples/walkthroughs/hide-whitespace-decision.json)                  | `2a0ea26179cdb15cc90fcd093f39b2be972e809b` | `flowchart`                                      | Which inputs use the normalized comparison branch, and how original source lines return for display.                           |
| [Runtime handoff](examples/walkthroughs/runtime-handoff-lifecycle.json)                 | `a2f016c5e90886cce769aa0990c6a05c7ce02ae9` | `sequenceDiagram` plus partial `stateDiagram-v2` | Who can receive an open during owner drain, separately from when one viewer reservation begins to expire.                      |
| [Markdown code sizing](examples/walkthroughs/markdown-code-fonts.json)                  | `efdff6bcb47d57a3ffab15a8dacf26b8577f8a54` | no diagram                                       | How three local Markdown boundaries inherit body text size while the global code default remains intact.                       |

The table records selected representations, not a golden template. A different change is not expected
to contain the same number or mix of diagrams.

## Qualitative observations

### State/lifecycle

The review-bootstrap producer entered at the query gate and render classifier instead of prefacing the
Walkthrough with the whole screen architecture. It labeled the diagram as a partial explanatory model
of aggregate UI conditions, not a code enum. The arrows distinguish revision wait, dependent Pull
Request wait, initial error, a successful empty result, and a usable selected OID. Nearby references
ground the query guard, classifier order, and tests; background errors remain outside the initial-state
diagram and are explained as a separate post-data boundary.

The runtime example also uses a state diagram, but for a different subject. `opening` and `startup` are
explicit `PendingViewer` variants, while an active browser lease belongs to a separate collection. The
example therefore calls the visual partial and does not present a fictitious single enum. Arm,
cancellation, heartbeat consumption, and startup expiry are labeled transitions with adjacent source
evidence.

### Actor interaction and asynchronous order

The verification-handoff sequence has one composer-to-producer brief. The producer, rather than an
anthropomorphized source repository, compares evidence with the bounded question and may return a
grounded correction or a conflict. Participant bindings are supported; messages and branches rely on
nearby `rvw-ref:` evidence.

The runtime sequence preserves the race that motivates the change. It distinguishes attempting the
current runtime socket, losing the atomic owner election, retrying a stopping or unavailable socket,
and becoming the successor only after ownership is released. It does not assert which contender always
wins or collapse socket acceptance and lock ownership into one event. Its second diagram is not another
view of that sequence: it answers the independent deadline/liveness question.

### Conditional processing

The Hide Whitespace producer chose a flowchart because the central model is a branch followed by a
transformation. It shows the one-sided-file guard, normalization of comparison copies, hunk calculation,
and restoration of original line arrays. The prose then explains why preserving CR/LF keeps indices
aligned and places unit tests beside each boundary. A sequence or state notation would obscure the
condition and data transformation.

### Deliberate no-diagram case

The Markdown typography change remains a short source path. A global `code` default and three local CSS
overrides do not require the reviewer to reconstruct actors, lifecycle, or branching. The producer used
exact selector and computed-style-test references and left Mermaid absent. This is evidence against
treating “standard explanatory tool” as “mandatory field.”

## Validation levels and result

The example test parses every tracked value with the strict production content schema, requires each
`sourceOid` to resolve to a commit in the local Git object store, reads every referenced path from that exact Git object,
checks every inclusive range, requires declared/used reference closure, and permits bindings only for
node-like IDs recognized by the same Markdown analyzer used by rvw. It also preserves the intended
diagram family of each named qualitative example without using diagram count as a general quality
score.

Headless `mermaid.parse` accepted the sequence examples. Flowchart labels and the state-diagram module
require browser DOMPurify behavior that is unavailable in the Node-only parser setup, so their Node
result was not reported as a syntax failure. The tracked
`test/e2e/walkthrough-producer-examples.spec.ts` case loads the repository's installed Mermaid 11.16.1
browser build with the same strict security, flowchart, theme, and suppression settings as rvw and
requires every one of the five example diagrams to render as SVG without a syntax error.
The normal rvw end-to-end fixture also exercises rendering and code-bound interaction for flowchart,
class, sequence, state, ER, and architecture diagrams. The complete branch suite passed all 172 tests
across 18 files on an isolated port; the default port was already owned by an unrelated long-running
local process.

The Hide Whitespace producer additionally ran its four focused unit tests successfully. The other
historical target suites were inspected as source evidence but were not all rerun at each old commit.
A committed test's existence, a focused execution, the branch's final suite result, and a universal
behavior guarantee remain separate claims.

## Mental-model rubric

The qualitative pass asks whether a reviewer can:

- reach the first concrete code check without memorizing a glossary or repository overview;
- answer the diagram's central question without reconstructing several states, actors, or branches
  from prose;
- open exact evidence for the important condition or relation, including evidence for unbindable arrows;
- state what the code check newly establishes and which boundary qualifies it;
- distinguish source fact, test assertion, inference, and unknown intent;
- say why the next suggested source location is worth opening; and
- use multiple diagrams only when each removes a different working-memory burden.

All five examples pass this rubric in qualitative review. That conclusion is an authoring assessment,
not something established by schema validation or Mermaid rendering.

## Unperformed acceptance work

No installed packaged host activated the Skill through its native Skill picker, no real review Artifact
was discovered, published, updated, or read back, and no human usability session measured label size,
zoom, click accuracy, or reading time. The browser render pass establishes accepted syntax and SVG
generation, not semantic truth or visual quality at every viewport. Those remain separate follow-up
acceptance boundaries.
