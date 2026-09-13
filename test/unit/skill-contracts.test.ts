import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rvwSkill = readFileSync("skills/rvw/SKILL.md", "utf8");
const watchSkill = readFileSync("skills/rvw-watch-comments/SKILL.md", "utf8");
const reviewComposeSkill = readFileSync("skills/rvw-review-compose/SKILL.md", "utf8");
const reviewComposeDescription = reviewComposeSkill.match(/^description: (.+)$/mu)?.[1] ?? "";
const reviewComposeOpenAi = readFileSync("skills/rvw-review-compose/agents/openai.yaml", "utf8");
const walkthroughSkill = readFileSync("skills/rvw-walkthrough/SKILL.md", "utf8");
const walkthroughOpenAi = readFileSync("skills/rvw-walkthrough/agents/openai.yaml", "utf8");
const structureSkill = readFileSync("skills/rvw-structure/SKILL.md", "utf8");
const structureOpenAi = readFileSync("skills/rvw-structure/agents/openai.yaml", "utf8");
const reviewComposition = readFileSync(
  "skills/rvw-review-compose/references/review-composition.md",
  "utf8",
);
const structureAuthoring = readFileSync(
  "skills/rvw-structure/references/structure-authoring.md",
  "utf8",
);
const walkthroughAuthoring = readFileSync(
  "skills/rvw-walkthrough/references/walkthrough-authoring.md",
  "utf8",
);
const structurePresentationContracts = [
  structureSkill,
  structureAuthoring,
  reviewComposeSkill,
  reviewComposition,
];

describe("bundled Skill code-reference guidance", () => {
  it("makes exact code evidence the default for concrete review outcomes", () => {
    expect(rvwSkill).toContain(
      "Use typed references by default whenever a post makes a concrete claim",
    );
    expect(rvwSkill).toContain("Apply the same code-evidence default to synchronized replies");
    expect(watchSkill).toContain("For every concrete claim about code behavior");
    expect(watchSkill).toMatch(
      /follow the code\s+evidence defaults above even though no commit was pushed/,
    );
    expect(rvwSkill).toMatch(
      /Route a Pull Request-wide\s+request for a reading composition to `rvw-review-compose`[\s\S]*`rvw-walkthrough` or\s+`rvw-structure`/,
    );
  });

  it("carries typed references through the watcher worker result", () => {
    const outcomeExample = watchSkill.match(/"outcomes": \[[\s\S]*?\n {2}\]\n}/)?.[0];

    expect(outcomeExample).toBeDefined();
    expect(outcomeExample).toContain('"relatedCommitOid"');
    expect(outcomeExample).toContain('"references"');
    expect(outcomeExample).toContain('"pushStatus"');
    expect(outcomeExample).not.toContain('"commitOid"');
  });

  it("gates HTML preview authoring on capability and keeps visuals static", () => {
    expect(walkthroughSkill).toMatch(
      /Require only the operation capabilities the\s+task uses:[\s\S]*`walkthrough.read` for `get`[\s\S]*new publication does not/,
    );
    expect(walkthroughSkill).toContain("Require `walkthrough.htmlPreview`");
    expect(walkthroughSkill).toContain("Markdown or HTML `rvw-ref:` link");
    expect(walkthroughSkill).toContain(
      'use Markdown links in prose and `<a href="rvw-ref:<referenceId>">` links inside HTML previews',
    );
    expect(walkthroughAuthoring).toContain("```html-preview");
    expect(walkthroughAuthoring).toContain("Never add JavaScript");
    expect(walkthroughAuthoring).toContain("Author an HTML fragment only");
    expect(walkthroughAuthoring).toContain("Put `<style>` directly inside");
    expect(walkthroughAuthoring).toContain("data-rvw-commentable");
    expect(walkthroughAuthoring).toContain("meaningful `aria-label`");
    expect(walkthroughAuthoring).toContain("repository root");
  });

  it("keeps Structure authoring code-centered, source-exact, and identity-stable", () => {
    expect(structureSkill).toMatch(
      /freely explorable spatial explanation whose complete factual graph remains\s+available/,
    );
    expect(structureSkill).toContain("ordered prose and transitions the artifact");
    expect(structureSkill).toContain("connected exact-relation visual backbone");
    expect(structureSkill).toContain("12 derived Nodes and 16 Edges");
    expect(structureSkill).toContain("Do not author backbone layers or stages");
    expect(structureSkill).toContain("primaryBackbone");
    expect(structureSkill).not.toContain("primarySpine");
    expect(structureSkill).toContain("Require `protocolVersion` 5");
    expect(structureSkill).toContain("`structure.presentation`");
    expect(structureSkill).toMatch(
      /Require only the operation capabilities the task uses:[\s\S]*`structure.read` for\s+`get`[\s\S]*`structure.list` for listing or uncertain-publication recovery[\s\S]*`structure.preview` before\s+publish or update/,
    );
    expect(structureSkill).toContain("structure.publish");
    expect(structureSkill).toContain("`structure.preview`");
    expect(structureSkill).toContain("rvw structure preview --stdin --json");
    expect(structureSkill).toContain("nonForwardDirectionalLinkRatio >= 0.25");
    expect(structureSkill).toContain(
      "Do not implement or invoke a separate Skill-side layout preview",
    );
    expect(structureSkill).toContain("Never access SQLite directly");
    expect(structureSkill).toContain("Preserve IDs");
    expect(structureSkill).toMatch(
      /preserve a Region ID while the\s+same comprehension chunk survives/,
    );
    expect(structureSkill).toMatch(
      /source-led request[\s\S]*concrete PR-relevant behavior[\s\S]*factual origin/,
    );
    expect(structureAuthoring).toContain("Explicit directions from the user");
    expect(structureAuthoring).toContain("one exact `sourceOid`");
    expect(structureAuthoring).toContain("Never recycle an ID");
    expect(structureAuthoring).toContain("Node, Edge, or Region");
    expect(structureAuthoring).toContain("all three retired ID kinds");
    expect(structureAuthoring).toMatch(/Stop and recommend a\s+Walkthrough/);
    expect(structureAuthoring).toContain("Do not create giant graphs");
    expect(structureAuthoring).toContain("factual code entrypoint");
    expect(structureAuthoring).toContain("unordered exact-membership set");
    expect(structureAuthoring).toContain("weakly connected");
    expect(structureAuthoring).toMatch(/Parallel\s+or reciprocal/);
    expect(structureAuthoring).toContain("Do not author layers or stages");
    expect(structureAuthoring).toContain("stable-sorted current unique Node IDs");
    expect(structureAuthoring).toMatch(/Region[\s\S]*unique,\s+stable ID/);
    expect(structureAuthoring).toMatch(/summary[\s\S]*contributes to this Structure's thesis/);
    expect(structureAuthoring).toContain("Region membership may be partial");
    expect(structureAuthoring).toMatch(
      /outer `regions` array as unordered sets[\s\S]*Do not author Region-to-Region relations/,
    );
    expect(structureAuthoring).toMatch(
      /runtime entrypoint shared by every file,[\s\S]*contract, configuration,[\s\S]*migration, document, or test/,
    );
    expect(structureAuthoring).toContain("around 20 full-width characters or fewer");
    expect(structureAuthoring).toContain("overlapping or nested Node anchors");
    expect(structureAuthoring).toContain("static inventory");
    expect(structureAuthoring).toContain("deprecated compatibility field");
    expect(structureAuthoring).toContain("Do not set it in new");
    expect(structureAuthoring).toContain("Do not publish");
    expect(structureOpenAi).toContain("Manage behavior maps and PR-scoped file maps");
    expect(structureOpenAi).toContain("read or manage");
    expect(structureOpenAi).not.toContain("to publish one bounded");
  });

  it("keeps Structure truth, presentation, rendering, and reviewer session separate", () => {
    expect(structureAuthoring).toMatch(
      /factual graph[\s\S]*Authorial presentation[\s\S]*Derived rendering[\s\S]*reviewer session/,
    );
    expect(structureAuthoring).toMatch(
      /Regions relationship view[\s\S]*Only the first two are Structure content/,
    );
    expect(structureAuthoring).toMatch(
      /fit Graph or Regions\s+into one screen[\s\S]*Reset, Fit, zoom, and pan[\s\S]*not authoring inputs/,
    );
  });

  it("authors a PR file map as a distinct existing-Structure role", () => {
    expect(structureSkill).toContain("A **PR-scoped file map**");
    expect(structureSkill).toMatch(
      /Both roles use the existing Structure shape; do not add a role field, Node kind, notation,[\s\S]*public schema/,
    );
    expect(structureAuthoring).toMatch(
      /One Node means exactly one repository file[\s\S]*Do not split\s+one path across multiple Nodes and do not combine multiple paths in one Node/,
    );
    expect(structureAuthoring).toMatch(
      /Use a file-level anchor by omitting both\s+`startLine` and `endLine`/,
    );
    expect(structureAuthoring).toMatch(
      /changed files plus any unchanged caller, consumer, dependency, type or contract definition,[\s\S]*needed to understand the\s+change/,
    );
    expect(structureAuthoring).toMatch(
      /An import establishes only an import[\s\S]*Do not infer a runtime call, execution\s+order, data flow, state ownership, or dependency injection/,
    );
    expect(structureAuthoring).toMatch(
      /type dependency, runtime dependency, registration, callback invocation,[\s\S]*test verification/,
    );
    expect(structureAuthoring).toMatch(
      /one-file map[\s\S]*one Node and zero Edges[\s\S]*never add a numerical filler dependency/,
    );
    expect(structureAuthoring).toMatch(
      /genuinely independent change areas require separate file maps[\s\S]*synthetic PR Node or a `same PR` Edge/,
    );
    expect(structureAuthoring).toMatch(/one exact `sourceOid`[\s\S]*deleted file[\s\S]*rename/);
    expect(structureAuthoring).toMatch(
      /file map[\s\S]*origin[\s\S]*need not be a\s+runtime entrypoint shared by every file/,
    );
  });

  it("defaults meaningful behavior changes to a core Walkthrough without making it a fixed slot", () => {
    expect(reviewComposeSkill).toMatch(
      /For a meaningful behavior change, treat one core Walkthrough as the default[\s\S]*Omit it only when the behavior is so local[\s\S]*rebuttable default, not a mandatory slot/,
    );
    expect(reviewComposition).toContain(
      "For a meaningful behavior change, begin with a core Walkthrough as the default candidate.",
    );
    expect(reviewComposition).toMatch(/Do not drop\s+it merely because a file map exists/);
    expect(reviewComposition).toMatch(/does not turn\s+Walkthrough into a required schema\s+slot/);
  });

  it("keeps null and start-only presentations honest instead of forcing an organizer", () => {
    expect(structureAuthoring).toMatch(
      /exact start-only form with `primaryBackbone: null` and `regions: \[\]`[\s\S]*Do not manufacture/,
    );
    expect(structureAuthoring).toMatch(
      /If the thesis or start\s+is not meaningful either, use `presentation: null`/,
    );
  });

  it("keeps the Structure publish example on the protocol-v5 presentation shape", () => {
    const exampleSource = structureSkill.match(
      /rvw structure publish --stdin --json <<'RVW_JSON'\n([\s\S]*?)\nRVW_JSON/,
    )?.[1];
    expect(exampleSource).toBeDefined();
    const example = JSON.parse(exampleSource!) as {
      presentation: {
        primaryBackbone: { edgeIds: string[] } | null;
        regions: Array<{ id: string; label: string; summary: string; nodeIds: string[] }>;
      };
    };
    const [region] = example.presentation.regions;

    expect(example.presentation).toHaveProperty("primaryBackbone");
    expect(region).toBeDefined();
    expect(Object.keys(region!).sort()).toEqual(["id", "label", "nodeIds", "summary"]);
    expect(region!.nodeIds).toEqual([...region!.nodeIds].sort());
  });

  it("contains no obsolete linear-spine or ordered-Region authoring contract", () => {
    for (const contract of structurePresentationContracts) {
      expect(contract).not.toContain("primarySpine");
      expect(contract).not.toMatch(/ordered, named comprehension regions/i);
      expect(contract).not.toMatch(/regions? ordered for spatial/i);
    }
  });
});

describe("rvw review composition contract", () => {
  it("requires a file map for PR-wide composition while keeping every other surface adaptive", () => {
    expect(reviewComposeDescription).toContain("Pull Request or explicit review subject");
    expect(reviewComposeDescription).toContain("direct code reading");
    expect(reviewComposeDescription).toContain("overall review composition");
    expect(reviewComposeDescription).toContain("always include a PR-scoped file-responsibility");
    expect(reviewComposeSkill).toContain("This Skill owns PR-wide composition");
    expect(reviewComposeSkill).toContain("minimizes the reviewer's total comprehension cost");
    expect(reviewComposeSkill).toContain('"minimum useful" never means "fewest Artifacts."');
    expect(reviewComposition).toMatch(
      /Two independently useful surfaces can\s+beat one overloaded surface; zero can beat both for an explicitly bounded local question/,
    );
    expect(reviewComposeSkill).toMatch(
      /A PR-wide\s+composition is the exception: it always includes at least one PR-scoped file-map Structure/,
    );
    expect(reviewComposition).toMatch(
      /Every PR-wide composition includes at least one file-map Structure[\s\S]*presence in the composition, not a fixed Artifact count, invocation order, or reading order/,
    );
    expect(reviewComposeSkill).toContain(
      "Direct the reviewer to code without creating an Artifact",
    );
    expect(reviewComposeSkill).toContain("Never require a Walkthrough and Structure as a pair");
    expect(reviewComposeSkill).toContain("Never require an overview Artifact");
    expect(reviewComposition).toContain("The required file map is not a first step");
    expect(reviewComposition).toMatch(
      /Never instantiate Overview, State, Flow, Error, Test, and\s+Structure as fixed slots/,
    );
    expect(reviewComposeSkill).toMatch(
      /single-file\s+change still has a one-Node file map and needs no invented Edge/,
    );
    expect(reviewComposeSkill).toMatch(
      /explicitly bounded subject may need one Walkthrough, one behavior Structure, or no Artifact/,
    );
    expect(reviewComposeSkill).toContain("it is never a fixed three-Artifact template");
    expect(reviewComposeOpenAi).toContain("Compose a PR file map and adaptive review paths");
    expect(reviewComposeOpenAi).toContain("recommend its required PR-scoped file responsibility");
    expect(reviewComposeOpenAi).toContain(
      "produce Artifacts only when I explicitly request production",
    );
  });

  it("keeps recommendation read-only unless Artifact production is explicit", () => {
    expect(reviewComposeSkill).toMatch(
      /assess, recommend, plan, audit, or explain a\s+composition is read-only/,
    );
    expect(reviewComposeSkill).toMatch(
      /Invoke a producer for\s+Artifact creation or update\s+only when the user explicitly asks to create, publish, produce, or update\s+Artifacts/,
    );
    expect(reviewComposeSkill).toMatch(
      /Supplying an existing URI or discovering a candidate authorizes contextual reading, not an\s+update/,
    );
    expect(reviewComposeSkill).toMatch(
      /read-only, meaning that it\s+permits no Artifact mutation[\s\S]*matching producer may still perform its normal read\s+operation for an explicitly supplied existing URI/,
    );
    expect(reviewComposition).toContain("When intent is ambiguous, recommend without mutation");
    expect(reviewComposition).toContain("must not fabricate Artifact URIs");
    expect(reviewComposition).toMatch(
      /required PR-wide file map[\s\S]*read-only[\s\S]*explicitly unproduced brief/,
    );
  });

  it("lets an unavailable transport diagnostic override contextual URI reads", () => {
    expect(reviewComposeSkill).toMatch(
      /`selectedTransport` is `unavailable`[\s\S]*overrides the existing-URI read permission[\s\S]*explicitly supplied URI cannot be read/,
    );
    expect(reviewComposeSkill).toMatch(
      /source-only, unproduced briefs[\s\S]*did not evaluate the existing Artifact/,
    );
    expect(reviewComposition).toMatch(
      /contextual-read permission[\s\S]*transport preflight succeeds[\s\S]*diagnostic takes precedence/,
    );
  });

  it("calibrates optional surfaces without turning the required map into a fixed template", () => {
    expect(reviewComposition).toContain(
      "Use these shape checks as counterexamples, not a template or required scenario list",
    );
    expect(reviewComposition).toMatch(
      /linear request → service → repository route[\s\S]*causal transitions[\s\S]*responsibility or dependency/,
    );
    expect(reviewComposition).toMatch(
      /hub\/fan-out or convergence[\s\S]*star or converging backbone, Regions, or only a start/,
    );
    expect(reviewComposition).toMatch(
      /cross-cutting lifecycle[\s\S]*each answers a useful question on\s+its own[\s\S]*one inseparable ordering invariant/,
    );
    expect(reviewComposition).toContain(
      "A local guard, calculation, or code question remains direct reading",
    );
    expect(reviewComposition).toMatch(
      /explicitly bounded local subject may legitimately produce zero, one, or several Artifacts/,
    );
    expect(reviewComposition).toMatch(
      /PR-wide composition produces one or more file maps and only the additional Artifacts justified/,
    );
    expect(reviewComposition).toMatch(
      /user-requested spatial emphasis[\s\S]*does not turn a temporal explanation into a Structure/,
    );
  });

  it("preflights protocol v5 before delegating an Artifact operation", () => {
    expect(reviewComposeSkill).toContain("Require `protocolVersion` 5");
    expect(reviewComposeSkill).toMatch(
      /Immediately\s+before every producer invocation, including contextual discovery or a current-value read, require\s+only the capabilities that invocation actually uses/,
    );
    expect(reviewComposeSkill).toContain(
      "A contextual read may happen before the composition is selected; creation",
    );
    expect(reviewComposeSkill).toContain(
      "and update capabilities are required only after selecting that operation",
    );
    expect(reviewComposition).toMatch(
      /Before each producer invocation, including this contextual read, require only the capability that\s+invocation uses/,
    );
  });

  it("rechecks the complete composition instead of maximizing Artifact count", () => {
    expect(reviewComposeSkill).toMatch(/Artifact count is not\s+a quality measure/);
    expect(reviewComposeSkill).toContain("detailed overlap, terminology drift");
    expect(reviewComposeSkill).toMatch(/missing\s+important boundaries/);
    expect(reviewComposeSkill).toContain("over-fragmentation");
    expect(reviewComposeSkill).toContain("cross-boundary risk");
    expect(reviewComposeSkill).toMatch(
      /Never delete any published Artifact,[\s\S]*normal deletion preview[\s\S]*explicit authorization/,
    );
    expect(reviewComposition).toContain("Count the joins between surfaces");
    expect(reviewComposition).toContain("state authority, lifecycle, async behavior");
    expect(reviewComposition).toContain("output or state produced on one side");
    expect(reviewComposeSkill).toContain("Do not dispatch producer handoffs as a batch");
    expect(reviewComposeSkill).toMatch(
      /After each producer result,[\s\S]*re-evaluate every unpublished brief/,
    );
    expect(reviewComposition).toMatch(
      /including a successful publication that refines a claim[\s\S]*remaining unpublished briefs/,
    );
  });

  it("keeps understanding units and briefs internal without a persistent Set model", () => {
    expect(reviewComposeSkill).toContain(
      "Candidate bounded understanding units are internal reasoning",
    );
    expect(reviewComposeSkill).toMatch(
      /The role and brief are authoring context, not public JSON,[\s\S]*rvw schema/,
    );
    expect(reviewComposition).toContain("Use a flexible note, not a public form");
    expect(reviewComposition).toContain("The examples below are prompts rather than a CLI schema");
    expect(reviewComposition).toContain("as a coverage checklist for the Pull Request");
    expect(reviewComposeSkill).toContain("Do not create a Review Set");
    expect(reviewComposeSkill).toContain("database row, migration, CLI");
    expect(reviewComposeSkill).toContain("Do not publish a duplicate");
    expect(reviewComposeSkill).toContain("page through `walkthrough list`");
    expect(reviewComposition).toContain('"Slice" may be used as private shorthand');
  });

  it("discovers Walkthroughs through list and verifies candidates through get", () => {
    expect(walkthroughSkill).toContain("`walkthrough.list` for discovery");
    expect(walkthroughSkill).toContain("rvw walkthrough list <PULL_REQUEST> --json");
    expect(walkthroughSkill).toMatch(/`page\.hasMore` is true[\s\S]*first page/);
    expect(walkthroughSkill).toMatch(/title alone[\s\S]*`walkthrough get`/);
    expect(walkthroughSkill).toMatch(/Skip list when[\s\S]*exact URI/);
    expect(walkthroughSkill).toMatch(/same explanation subject[\s\S]*different bounded subject/);
    expect(walkthroughSkill).toMatch(
      /List and get are separate reads[\s\S]*Neither successful read\s+authorizes update or deletion/,
    );
    expect(reviewComposeSkill).toContain("`walkthrough.list` for Walkthrough discovery");
    expect(reviewComposeSkill).toMatch(/`hasMore` \/ `nextOffset`[\s\S]*`walkthrough get`/);
    expect(reviewComposeSkill).toMatch(/title alone[\s\S]*same subject/);
    expect(reviewComposition).toMatch(/`walkthrough list`[\s\S]*`walkthrough get`/);
    expect(reviewComposition).toContain("never SQLite, internal file paths, remembered URIs");
  });

  it("delegates to canonical producer Skills through the current host", () => {
    expect(reviewComposeSkill).toMatch(/current\s+host's native Skill mechanism/);
    expect(reviewComposeSkill).toContain("`rvw-walkthrough` for one Walkthrough brief");
    expect(reviewComposeSkill).toContain(
      "`rvw-structure` for one file-map or behavior Structure brief",
    );
    expect(reviewComposeSkill).toContain("unavailable or disabled in the current session");
    expect(reviewComposeSkill).toContain("available Skill inventory");
    expect(reviewComposeSkill).toContain("Skill with the Skill tool");
    expect(reviewComposeSkill).toContain("load the full producer instructions");
    expect(reviewComposeSkill).toMatch(/stop before any\s+Artifact operation/);
    expect(reviewComposeSkill).not.toContain("$rvw-walkthrough");
    expect(reviewComposeSkill).not.toContain("$rvw-structure");
  });

  it("briefs the three surfaces by distinct questions and recomposes sequentially", () => {
    expect(reviewComposeSkill).toMatch(
      /explicit role \(`walkthrough`, `file-map Structure`, or `behavior Structure`\)/,
    );
    expect(reviewComposeSkill).toMatch(
      /verified facts and terminology it should share[\s\S]*which question or\s+explanation another surface already owns/,
    );
    expect(reviewComposition).toContain("role: structure:file-map");
    expect(reviewComposition).toContain("role: structure:behavior");
    expect(reviewComposition).toContain("diagramQuestion:");
    expect(reviewComposition).toContain("diagramCandidate:");
    expect(reviewComposition).toContain("doNotDuplicate:");
    expect(reviewComposeSkill).toContain("Do not dispatch producer handoffs as a batch");
    expect(reviewComposeSkill).toMatch(
      /After each producer result,[\s\S]*re-evaluate every unpublished brief/,
    );
    expect(reviewComposeSkill).toMatch(
      /required file map does not force investigation order, producer invocation order, or human reading\s+order/,
    );
  });

  it("reports reuse, exclusions, direct-code work, and an unmet mandatory map honestly", () => {
    expect(reviewComposeSkill).toMatch(
      /Prefer a still-valid same-subject map at\s+the selected source, then an authorized\s+in-place update, over a duplicate publication/,
    );
    expect(reviewComposeSkill).toMatch(
      /what each file map includes, what it deliberately excludes, and what remains for direct code reading/,
    );
    expect(reviewComposeSkill).toMatch(
      /any required file map that remains unmet,[\s\S]*Never fabricate a Node, Edge, anchor, or URI/,
    );
  });

  it("separates authoring bounds from implementation claims to verify", () => {
    expect(reviewComposeSkill).toContain("authoring bounds separate from its claims-to-verify");
    expect(reviewComposeSkill).toMatch(
      /Pass the subject, review question, purpose or behavior boundary, scope, inclusions, exclusions, and\s+emphasis as authoring authority/,
    );
    expect(reviewComposeSkill).toMatch(
      /Pass `mustEstablish`, a suggested origin, relationship, invariant,[\s\S]*claims to verify independently in committed source and tests/,
    );
    expect(reviewComposition).toContain("Authority over the question is not proof of its answer");
    expect(reviewComposition).toMatch(
      /`mustEstablish` means claims the producer must attempt to verify[\s\S]*not a list of facts the producer may assume or conclusions it must force/,
    );
    expect(reviewComposition).toMatch(
      /Verifying that an\s+anchor exists and its range is valid does not by itself verify the semantic claim/,
    );
    expect(reviewComposeSkill).toMatch(/connected\s+exact-relation visual backbone/);
    expect(reviewComposeSkill).toMatch(
      /new Region by the chunk's meaning, responsibility, and contribution[\s\S]*producer builds the verified graph/,
    );
    expect(reviewComposeSkill).toMatch(
      /attention-start concept to one current Node ID[\s\S]*accepted chunk to exact Node membership[\s\S]*new Region a\s+fresh ID/,
    );
    expect(reviewComposeSkill).toMatch(
      /suggested factual origin[\s\S]*separate claim to verify[\s\S]*not\s+automatically the attention start/,
    );
    expect(reviewComposeSkill).toMatch(
      /Region array order as guidance[\s\S]*Viewer derives\s+cross-Region connections only from verified factual Edges/,
    );
    expect(reviewComposeSkill).toContain("Do not request authored layers or stages");
    expect(reviewComposition).toContain("`primaryBackbone`");
    expect(reviewComposition).toMatch(
      /new Structure,[\s\S]*semantically rather than drafting its protocol payload/,
    );
    expect(reviewComposition).toMatch(
      /composer does not choose a new `startNodeId`,\s+`edgeIds`, `nodeIds`, or Region `id`[\s\S]*producer owns graph identity/,
    );
    expect(reviewComposition).toMatch(
      /attention-start concept to one current Node ID[\s\S]*accepted chunk concepts to exact Node membership[\s\S]*new Region\s+a fresh ID/,
    );
    expect(reviewComposition).toMatch(/retired\s+Node, Edge, or Region IDs must not be recycled/);
    expect(reviewComposition).toMatch(
      /one-screen fit[\s\S]*Region relationship arrows[\s\S]*derived rendering or pane-local\s+reviewer-session concerns/,
    );
  });
});

describe("rvw Walkthrough mental-model and diagram contract", () => {
  it("enters concrete code early and builds small verifiable understanding updates", () => {
    expect(walkthroughSkill).toMatch(
      /begin with a concrete situation or\s+question,[\s\S]*verify the\s+claim in exact committed code,[\s\S]*resulting question to\s+lead deeper/,
    );
    expect(walkthroughAuthoring).toMatch(
      /do\s+not make a large glossary, a repository-wide model, every changed file, or a giant overview diagram\s+mandatory preparation/,
    );
    expect(walkthroughAuthoring).toMatch(
      /For each natural section,[\s\S]*which exact code can confirm or contradict it,[\s\S]*which new\s+question follows/,
    );
    expect(walkthroughAuthoring).toMatch(
      /continue\s+into code with a new question[\s\S]*say why each is worth opening\s+and what uncertainty or boundary it can test/,
    );
    expect(walkthroughOpenAi).toContain("builds understanding through concrete code");
  });

  it("uses a diagram as source-grounded explanation when prose creates reconstruction work", () => {
    expect(walkthroughAuthoring).toMatch(
      /Use Mermaid as a standard explanatory tool when several relationships, actors, states,[\s\S]*working\s+memory from prose/,
    );
    expect(walkthroughAuthoring).toMatch(
      /Rendering successfully proves only that the syntax is\s+accepted; every element and relation remains an authorial claim/,
    );
    expect(walkthroughAuthoring).toContain("Treat one diagram as one central question");
    expect(walkthroughAuthoring).toMatch(
      /do not front-load one architecture diagram containing every file, actor,\s+state, branch, and error/,
    );
    expect(walkthroughAuthoring).toMatch(
      /constant, wording change, or local condition is\s+clearer in a short sentence and exact code/,
    );
    expect(walkthroughAuthoring).toContain(
      "Do not restate the same explanation in prose and several diagrams",
    );
  });

  it("selects flow, state, and sequence notation by the question instead of defaulting to flowchart", () => {
    expect(walkthroughAuthoring).toMatch(
      /Use a `flowchart` when the question is which condition selects a branch,[\s\S]*Do not use one merely as a generic box-and-arrow/,
    );
    expect(walkthroughAuthoring).toMatch(
      /Use `stateDiagram-v2` when the question concerns the states of one identified subject,[\s\S]*Function\s+call order alone is not a state transition/,
    );
    expect(walkthroughAuthoring).toMatch(
      /Use a `sequenceDiagram` when the question concerns who calls or signals whom,[\s\S]*source statement order does not establish\s+asynchronous completion order/,
    );
    expect(walkthroughAuthoring).toMatch(
      /Different diagram types may appear in one Walkthrough when they answer different questions[\s\S]*Do not\s+repeat the same explanation/,
    );
    expect(walkthroughAuthoring).toContain("Do not default every visual question to a flowchart");
  });

  it("binds only supported node-like elements and grounds relation claims beside the diagram", () => {
    expect(walkthroughAuthoring).toMatch(
      /supported binding targets are\s+flowchart nodes, classDiagram classes, sequenceDiagram participants and actors, stateDiagram-v2 states,[\s\S]*architecture-beta services/,
    );
    expect(walkthroughAuthoring).toMatch(
      /Do not bind sequence messages, state transitions, ER relationships, architecture edges\/groups/,
    );
    expect(walkthroughAuthoring).toMatch(
      /participant or state binding does not prove the arrows connected\s+to it[\s\S]*nearby Markdown/,
    );
    expect(walkthroughAuthoring).toMatch(
      /multiple Mermaid fences reuse one source ID, every\s+match opens the same reference/,
    );
  });

  it("distinguishes source facts, tests, and lifecycle boundaries", () => {
    expect(walkthroughAuthoring).toMatch(
      /failure, retry, re-entry, cancellation,[\s\S]*state-update timing/,
    );
    expect(walkthroughAuthoring).toMatch(
      /a test exists; it was executed; that execution\s+passed; and the asserted property is generally guaranteed/,
    );
    expect(walkthroughAuthoring).toMatch(
      /distinguish stated intent, source-established fact,\s+necessary inference, and unknown intent or behavior/,
    );
  });
});

describe("single-Artifact producer composition boundary", () => {
  it("treats upstream authoring bounds as authority without expanding to the Pull Request", () => {
    for (const producer of [walkthroughSkill, structureSkill]) {
      expect(producer).toContain("at most one");
      expect(producer).toMatch(/subject,\s+review\s+question/);
      expect(producer).toContain("inclusions, exclusions");
      expect(producer).toContain("emphasis");
      expect(producer).toMatch(/Inspect broader Pull\s+Request context only/);
      expect(producer).toMatch(/Pull Request's\s+Artifact count/);
      expect(producer).toMatch(/Walkthrough\s+\/ Structure mix/);
      expect(producer).toMatch(/publish\s+companion Artifacts/);
      expect(producer).toContain("Standalone");
    }
    expect(walkthroughSkill).toMatch(
      /Do not broaden\s+the Walkthrough to cover the whole Pull Request/,
    );
    expect(structureSkill).toMatch(/do not publish separate Structures\s+autonomously/);
    expect(structureAuthoring).not.toContain("yields separate Structures");
    expect(structureAuthoring).not.toContain("author that behavior as a separate Structure");
  });

  it("independently verifies upstream claims instead of treating them as facts", () => {
    for (const producer of [walkthroughSkill, structureSkill]) {
      expect(producer).toContain("`mustEstablish`");
      expect(producer).toMatch(/claims? to verify independently\s+in committed source and tests/);
      expect(producer).toMatch(
        /essential claim[\s\S]*unsupported or contradicted[\s\S]*do not\s+publish/,
      );
      expect(producer).toMatch(/report the conflict to the requester or upstream composer/);
    }
    expect(walkthroughSkill).toContain("a valid path or line range alone does not prove");
    expect(structureSkill).toContain("do not mistake a valid anchor for semantic proof");
    expect(walkthroughAuthoring).toContain(
      "Never treat the caller's conclusion as its own evidence",
    );
    expect(structureAuthoring).toContain("Never treat the caller's conclusion as");
    expect(structureAuthoring).toContain("subject authority alone cannot establish it");
    expect(structureAuthoring).not.toContain("or explicit subject authority");
    expect(structureAuthoring).not.toMatch(
      /concept is explicitly established by the authority\s+inputs/,
    );
  });

  it("retains each producer's local representation rejection boundary", () => {
    expect(walkthroughSkill).toMatch(
      /no useful ordered reading path[\s\S]*stop without publishing[\s\S]*recommend `rvw-structure`/,
    );
    expect(structureSkill).toMatch(
      /required reading[\s\S]*stop without publishing[\s\S]*recommend `rvw-walkthrough`/,
    );
    expect(structureSkill).toMatch(
      /no defensible factual entrypoint[\s\S]*generic static architecture,[\s\S]*do not publish a Structure/,
    );
    expect(structureSkill).toMatch(
      /file map[\s\S]*specific Pull Request or declared\s+change scope[\s\S]*may not become a repository-wide architecture diagram/,
    );
    expect(walkthroughAuthoring).toContain(
      "The subject is genuinely clearer as an ordered path; otherwise no Walkthrough was published",
    );
  });
});
