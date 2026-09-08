import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const mermaidScriptPath = path.join(
  path.dirname(require.resolve("mermaid/package.json")),
  "dist/mermaid.min.js",
);

const examplePaths = [
  "docs/examples/walkthroughs/review-composition-verification-path.json",
  "docs/examples/walkthroughs/review-bootstrap-lifecycle.json",
  "docs/examples/walkthroughs/hide-whitespace-decision.json",
  "docs/examples/walkthroughs/runtime-handoff-lifecycle.json",
];

function exampleDiagrams(): string[] {
  return examplePaths.flatMap((filePath) => {
    const example = JSON.parse(readFileSync(filePath, "utf8")) as { body: string };
    return [...example.body.matchAll(/```mermaid\n([\s\S]*?)\n```/gu)].map((match) => match[1]!);
  });
}

test("renders every diagram in the Walkthrough producer examples with rvw Mermaid settings", async ({
  page,
}) => {
  const diagrams = exampleDiagrams();
  expect(diagrams).toHaveLength(5);

  await page.addScriptTag({ path: mermaidScriptPath });
  const rendered = await page.evaluate(async (sources) => {
    const mermaid = (
      window as unknown as {
        mermaid: {
          initialize(config: Record<string, unknown>): void;
          render(id: string, source: string): Promise<{ svg: string }>;
        };
      }
    ).mermaid;

    mermaid.initialize({
      startOnLoad: false,
      suppressErrorRendering: true,
      securityLevel: "strict",
      theme: "base",
      flowchart: { htmlLabels: false, curve: "basis" },
      themeVariables: {
        primaryColor: "#eef5ff",
        primaryTextColor: "#24292f",
        lineColor: "#57606a",
      },
    });

    const svgs: string[] = [];
    for (const [index, source] of sources.entries()) {
      const { svg } = await mermaid.render(`rvw-producer-example-${index}`, source);
      svgs.push(svg);
    }
    return svgs;
  }, diagrams);

  expect(rendered).toHaveLength(diagrams.length);
  for (const svg of rendered) {
    expect(svg).toMatch(/^<svg\b/u);
    expect(svg).not.toContain("Syntax error in text");
  }
});
