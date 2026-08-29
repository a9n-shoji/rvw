import { describe, expect, it } from "vitest";
import { analyzeReferenceMarkdown } from "../../src/application/rvw-service.js";

function bindingKeys(source: string): Set<string> {
  return analyzeReferenceMarkdown(["```mermaid", source, "```"].join("\n")).mermaidNodeIds;
}

describe("Walkthrough Mermaid binding validation", () => {
  it.each([
    {
      diagram: "flowchart",
      source: [
        "flowchart LR",
        "  Controller[Controller] --> Service[Service]",
        "  service --> state --> group --> actor --> participant",
      ].join("\n"),
      expected: ["Controller", "Service", "service", "state", "group", "actor", "participant"],
      excluded: [],
    },
    {
      diagram: "classDiagram",
      source: [
        "classDiagram",
        "  class Controller",
        "  class Service",
        "  Controller --> Service : calls",
      ].join("\n"),
      expected: ["Controller", "Service"],
      excluded: ["calls"],
    },
    {
      diagram: "sequenceDiagram participant and actor",
      source: [
        "sequenceDiagram",
        "  participant C as Controller",
        "  participant S as Service",
        "  actor U as User",
        '  participant API@{ "type": "boundary" } as Public API',
        '  participant DB@{ "type": "database" } as Database',
        "  U->>C: request",
        "  C->>S: execute",
        "  External->>C: implicit participant",
      ].join("\n"),
      expected: ["C", "S", "U", "API", "DB", "External"],
      excluded: ["request", "execute", "implicit", "participant"],
    },
    {
      diagram: "stateDiagram-v2 state",
      source: [
        "stateDiagram-v2",
        '  state "Draft order" as Draft',
        "  state Submitted",
        "  Still",
        "  Draft --> Submitted : submit",
        "  Submitted --> Approved : approve",
      ].join("\n"),
      expected: ["Draft", "Submitted", "Still", "Approved"],
      excluded: ["submit", "approve"],
    },
    {
      diagram: "erDiagram entity",
      source: [
        "erDiagram",
        "  USER ||--o{ ORDER : places",
        "  ORDER ||..|{ ITEM : contains",
        "  ITEM ||.-o{ AUDIT : records",
        "  AUDIT ||-.o{ LOG : emits",
        "  p[Person] {",
        "    string name",
        "  }",
        "  CAR 1 to zero or more DRIVER : allows",
      ].join("\n"),
      expected: ["USER", "ORDER", "ITEM", "AUDIT", "LOG", "p", "CAR", "DRIVER"],
      excluded: ["places", "contains", "records", "emits", "Person", "allows", "name"],
    },
    {
      diagram: "architecture-beta service",
      source: [
        "architecture-beta",
        "  group app(cloud)[Application]",
        "  service database1(database)[My Database]",
        "  service web(server)[Web] in app",
        "  service worker(server)[Worker] in app",
        "  service db(database)[Database] in app",
        "  web:R -- L:db",
      ].join("\n"),
      expected: ["database1", "web", "worker", "db"],
      excluded: ["app", "R", "L"],
    },
  ])("accepts only $diagram node-like IDs", ({ source, expected, excluded }) => {
    const keys = bindingKeys(source);
    expect([...keys].sort()).toEqual([...expected].sort());
    for (const edgeLikeId of excluded) expect(keys.has(edgeLikeId)).toBe(false);
  });
});
