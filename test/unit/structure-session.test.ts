import { describe, expect, it } from "vitest";
import type { Structure } from "../../src/domain/models.js";
import {
  createStructureSession,
  deleteStructureSessions,
  getStructureSession,
  setStructureSession,
  transferStructureSession,
} from "../../src/web/structure-session.js";

function structure(id: string): Structure {
  return {
    id,
    ref: `rvw://structure/${id}`,
    pullRequestId: "pr-1",
    sourceOid: "a".repeat(40),
    title: "Session boundary",
    scope: "A bounded test Structure.",
    initialFocus: "entry",
    nodes: [{ id: "entry", label: "Entry", description: null, kind: null, anchor: null }],
    edges: [],
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

describe("Structure pane sessions", () => {
  it("moves the current reading state between panes without sharing both entries", () => {
    const value = structure("70000000-0000-4000-8000-000000000099");
    const session = {
      ...createStructureSession(value),
      positions: { entry: { x: 777, y: 333 } },
      viewport: { x: 21, y: 34, scale: 1.4 },
    };
    setStructureSession("left", value.id, session);

    transferStructureSession(value.id, "left", "right");

    expect(getStructureSession("left", value.id)).toBeUndefined();
    expect(getStructureSession("right", value.id)).toEqual(session);
    deleteStructureSessions(value.id);
    expect(getStructureSession("right", value.id)).toBeUndefined();
  });
});
