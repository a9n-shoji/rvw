# Review-composition three-surface example

These unpublished fixtures describe the same main-line committed change,
`f9416d959dbb79f95dd75d96bafeb6156155f5c8` (`Add adaptive review composition skill (#76)`),
through three different review questions. They are examples for schema, source-exactness, and
qualitative evaluation; they were not sent to an rvw review environment.

| Surface                                                                                    | Central question                                                                                                               | Deliberate boundary                                                                                                                                 |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [File-map Structure](../structures/review-composition-file-map.json)                       | Which repository files own the composer/producer contract, and which files constrain or distribute it?                         | One real file per node with file-level node anchors; only source-verifiable file relations become edges.                                            |
| [Verification-path Walkthrough](../walkthroughs/review-composition-verification-path.json) | How does a candidate implementation claim move from composer brief to independent source verification and back to composition? | One representative sequence with participant bindings; messages and branches use adjacent `rvw-ref` evidence rather than unsupported edge bindings. |
| [Authority Structure](../structures/review-composition-authority.json)                     | Who owns scope, semantic verification, representation rejection, and recomposition?                                            | Conceptual responsibilities use exact line anchors; physical file inventory and prescribed reading order are excluded.                              |

The file map includes the changed composer and producer Skill contracts, their detailed references, the
normative implementation specification, and the static contract test. It also includes
`src/infrastructure/skills/skill-installer.ts`: its canonical list names all three Skills, and its
package-root discovery requires each listed `SKILL.md`, so it is a direct dependency of the documented
native handoff. The unchanged `src/cli/main.ts` is included because it constructs that installer for the
exposed `skill install` and `skill status` commands, preventing the map from collapsing into a changed-files list.
This does not claim a complete impact graph.

Agent metadata, README, changelog, architecture, CLI protocol, compatibility, decisions, package-smoke,
installer tests, protocol tests, and evaluation documents are intentionally absent from the file map.
They expose, restate, package-test, or evaluate the bounded authoring handoff rather than owning it.
Exact transport preflight, publication/update/delete, installer copy and conflict handling, and the rest
of the text-test assertions remain direct-code follow-ups.

The artifacts reuse some source because they ask different questions. The file map uses those ranges to
prove file-to-file relations, the Walkthrough uses them to establish a verification sequence, and the normal
Structure uses them to separate authority and responsibility. None asks the reviewer to memorize the file map
first, and none treats the other two as required reading order.
