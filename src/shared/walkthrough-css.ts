import type { CssNode } from "css-tree";
import parse from "css-tree/parser";
import walk from "css-tree/walker";
import generate from "css-tree/generator";
import { ident } from "css-tree/utils";
import { RvwError } from "./errors.js";

export interface CssAssetReference {
  path: string;
  kind: "image" | "font";
}
export function bundledAssetPath(value: string): string | null {
  const path = value.startsWith("rvw-asset:") ? value.slice(10) : value.replace(/^\.\//u, "");
  return /^[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$/u.test(path) &&
    !path.split("/").some((part) => part === "." || part === "..")
    ? path
    : null;
}

/** Parse every CSS token; only local manifest assets and SVG fragment URLs may load. */
export function transformWalkthroughCss(
  value: string,
  context: "stylesheet" | "declarationList" | "value",
  assets: CssAssetReference[],
  resolved?: ReadonlyMap<string, string | null>,
): string {
  const fail = (message: string): never => {
    throw new RvwError("INVALID_INPUT", `Unsafe or unsupported CSS: ${message}`);
  };
  let ast: CssNode;
  try {
    ast = parse(value, {
      context,
      parseCustomProperty: true,
      onParseError: (error) => {
        throw error;
      },
    });
  } catch {
    return fail("invalid syntax");
  }
  let fontDepth = 0;
  walk(ast, {
    enter(node: CssNode) {
      if (node.type === "Raw") fail("unparsed syntax");
      if (node.type === "Atrule") {
        const name = ident.decode(node.name).toLowerCase();
        if (
          ![
            "media",
            "supports",
            "container",
            "layer",
            "keyframes",
            "-webkit-keyframes",
            "font-face",
            "property",
            "scope",
            "starting-style",
          ].includes(name)
        )
          fail(`@${name}`);
        if (name === "font-face") fontDepth++;
      }
      if (node.type === "Declaration") {
        const name = ident.decode(node.property).toLowerCase();
        if (["behavior", "-moz-binding"].includes(name)) fail(name);
        if (fontDepth && name === "src") {
          // Variable or local() font sources would bypass deterministic asset resolution.
          walk(node.value, (child) => {
            if (
              child.type === "Function" &&
              !["format", "tech"].includes(ident.decode(child.name).toLowerCase())
            )
              fail("font src must use bundled URL");
          });
        }
      }
      if (node.type === "Function" && ident.decode(node.name).toLowerCase() === "attr") {
        // Untyped attr() produces text. Typed/dynamic forms cannot introduce resource URLs.
        const tokens = node.children.toArray().filter((child) => child.type !== "WhiteSpace");
        if (
          tokens[0]?.type !== "Identifier" ||
          (tokens.length > 1 && !(tokens[1]?.type === "Operator" && tokens[1].value === ","))
        )
          fail("typed attr()");
        node.children.forEach((child) => {
          if (child.type === "Function" || child.type === "Url") fail("typed or dynamic attr()");
        });
      }
      if (
        node.type === "Function" &&
        [
          "expression",
          "image",
          "image-set",
          "-webkit-image-set",
          "paint",
          "element",
          "-moz-element",
          "local",
          "url",
          "src",
        ].includes(ident.decode(node.name).toLowerCase())
      )
        fail(node.name);
      if (node.type === "Url") {
        const url = node.value;
        if (/^#[A-Za-z_][\w:.-]*$/u.test(url) && !fontDepth) return;
        const path = bundledAssetPath(url);
        if (!path) fail(`resource ${url}`);
        assets.push({ path: path!, kind: fontDepth ? "font" : "image" });
        // Never leave an unresolved URL in the sandbox, even before asset fetch completes.
        node.value = resolved?.get(path!) ?? "data:,";
      }
    },
    leave(node: CssNode) {
      if (node.type === "Atrule" && ident.decode(node.name).toLowerCase() === "font-face")
        fontDepth--;
    },
  });
  return generate(ast);
}
