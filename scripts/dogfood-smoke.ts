import assert from "node:assert/strict";
import { createDogfoodFixture } from "./dogfood-fixture.js";

const fixture = createDogfoodFixture(process.cwd());
try {
  assert.equal(fixture.scenario, "dogfood");
  assert.ok(fixture.commits.length > 1, "dogfood fixture requires Git history");
  assert.ok(
    fixture.repositoryEntriesAt(fixture.headOid).length > 0,
    "dogfood fixture requires repository entries",
  );
  assert.ok(fixture.walkthroughs.length > 0, "dogfood fixture requires walkthroughs");
  assert.ok(fixture.comments.length > 0, "dogfood fixture requires comments");
} finally {
  fixture.cleanup();
}
