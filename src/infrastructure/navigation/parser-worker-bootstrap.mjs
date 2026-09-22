// Development entry only. The published package uses the bundled parser-worker.mjs.
import { register } from "tsx/esm/api";
register();
await import("./parser-worker.ts");
