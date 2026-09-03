import { createRealisticFixture } from "./realistic-fixture.mjs";
import { installFixtureLifecycle } from "../fixture-lifecycle.mjs";

const fixture = createRealisticFixture();
installFixtureLifecycle({ cleanup: fixture.cleanup });
process.stdout.write(`${fixture.repositoryRoot}\n`);
setInterval(() => {}, 1_000);
