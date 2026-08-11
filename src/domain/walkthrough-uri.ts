import { RvwError } from "../shared/errors.js";

const prefix = "rvw://walkthrough/";
const walkthroughIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function formatWalkthroughUri(id: string): string {
  return `${prefix}${id}`;
}

export function parseWalkthroughUri(uri: string): string {
  if (!uri.startsWith(prefix)) {
    throw new RvwError("INVALID_INPUT", "walkthrough URIが不正です。");
  }
  const id = uri.slice(prefix.length);
  if (!walkthroughIdPattern.test(id)) {
    throw new RvwError("INVALID_INPUT", "walkthrough URIが不正です。");
  }
  return id;
}
