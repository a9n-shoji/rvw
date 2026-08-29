import { RvwError } from "../shared/errors.js";

const prefix = "rvw://structure/";
const structureIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function formatStructureUri(id: string): string {
  return `${prefix}${id}`;
}

export function parseStructureUri(uri: string): string {
  if (!uri.startsWith(prefix)) {
    throw new RvwError("INVALID_INPUT", "structure URIが不正です。");
  }
  const id = uri.slice(prefix.length);
  if (!structureIdPattern.test(id)) {
    throw new RvwError("INVALID_INPUT", "structure URIが不正です。");
  }
  return id;
}
