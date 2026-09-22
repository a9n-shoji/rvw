import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { navigationLanguage } from "../../src/domain/code-navigation.js";
import { GitClient } from "../../src/infrastructure/git/git-client.js";
import { GitSymbolIndex } from "../../src/infrastructure/navigation/git-symbol-index.js";
import { ParserWorkerClient } from "../../src/infrastructure/navigation/parser-worker-client.js";
import { extractSymbols } from "../../src/infrastructure/navigation/tree-sitter-tags.js";
import { createGitRepository, commitFile, git } from "../fixtures/git-repository.js";

const repositories: string[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0))
    rmSync(repository, { recursive: true, force: true });
});
function fixture() {
  const repository = createGitRepository();
  repositories.push(repository);
  const extract = vi.fn(extractSymbols);
  return { repository, extract, index: new GitSymbolIndex(new GitClient(), extract) };
}
const document = (sourceOid: string, path: string) => ({
  kind: "repository-file" as const,
  pullRequestId: "fixture",
  sourceOid,
  path,
});

describe("language-independent Git navigation", () => {
  it("selects explicit supported grammars without treating arbitrary files as code", () => {
    for (const file of ["a.js", "a.jsx", "a.cjs", "a.mjs"])
      expect(navigationLanguage(file)).toBe("javascript");
    for (const file of ["a.ts", "a.d.ts", "a.cts", "a.mts"])
      expect(navigationLanguage(file)).toBe("typescript");
    expect(navigationLanguage("a.tsx")).toBe("tsx");
    expect(navigationLanguage("app/Gemfile")).toBe("ruby");
    expect(navigationLanguage("a.vue")).toBeNull();
  });

  it("extracts JS/JSX functions, classes, arrow components, wrapped components and dollar identifiers", async () => {
    const result = await extractSymbols(
      `export function Button() { return <button/>; }
export class Panel extends React.Component { render() { return <Button/>; } }
export const Arrow = () => <Panel/>;
export const Wrapped = memo(() => <Arrow/>);
export const $value = 5;
`,
      "javascript",
    );
    expect(result.partial).toBe(false);
    expect(result.tags.filter((tag) => tag.kind).map((tag) => [tag.name, tag.kind])).toEqual([
      ["Button", "function"],
      ["Panel", "class"],
      ["render", "method"],
      ["Arrow", "function"],
      ["Wrapped", "variable"],
      ["$value", "variable"],
    ]);
    expect(result.tags.some((tag) => tag.name === "Button" && tag.line === 2 && !tag.kind)).toBe(
      true,
    );
  });

  it("extracts TypeScript declarations and keeps TS generic syntax separate from TSX", async () => {
    const result = await extractSymbols(
      `export interface Props { title: string }
export type Name = string;
export enum State { Open, Closed }
export const identity = <T>(value: T): T => value;
`,
      "typescript",
    );
    expect(result.partial).toBe(false);
    expect(result.tags.filter((tag) => tag.kind).map((tag) => tag.name)).toEqual([
      "Props",
      "Name",
      "State",
      "identity",
    ]);
    const tsx = await extractSymbols(
      "export const View = (props: Props) => <UI.Button title={props.title}/>;",
      "tsx",
    );
    expect(tsx.partial).toBe(false);
    expect(tsx.tags.map((tag) => tag.name)).toEqual(
      expect.arrayContaining(["View", "Props", "UI", "Button"]),
    );
  });

  it("finds JSX components across JS and TS, excludes Ruby and comments, and does not invent import alias resolution", async () => {
    const { repository, index } = fixture();
    commitFile(repository, "Button.rb", "class Button; end\n", "unrelated language");
    commitFile(
      repository,
      "Button.jsx",
      "export function Button() { return <button/>; }\n",
      "JS component",
    );
    commitFile(
      repository,
      "Button.tsx",
      "export const Button = () => <button/>;\n",
      "TS component",
    );
    const oid = commitFile(
      repository,
      "App.tsx",
      '<Button/>;\n// Button\n"Button";\nimport { Button as Renamed } from "./Button";\n<Renamed/>;\n',
      "usage",
    );
    const result = await index.definitions(repository, document(oid, "App.tsx"), 1, 2);
    expect(result.targets.map((target) => target.document.path)).toEqual([
      "Button.jsx",
      "Button.tsx",
    ]);
    expect(result.partial).toBe(false);
    for (const [line, column] of [
      [2, 4],
      [3, 2],
      [5, 2],
    ])
      expect(
        (await index.definitions(repository, document(oid, "App.tsx"), line!, column!)).targets,
      ).toEqual([]);
  });

  it("keys blob metadata by grammar and preserves same-language reuse across renames", async () => {
    const { repository, index, extract } = fixture();
    commitFile(repository, "User.js", "class User {}\n", "JS");
    const oid = commitFile(repository, "caller.js", "new User();\n", "usage");
    await index.definitions(repository, document(oid, "caller.js"), 1, 5);
    expect(extract).toHaveBeenCalledTimes(2);
    git(repository, "mv", "User.js", "User.ts");
    git(repository, "commit", "-m", "change grammar");
    await index.definitions(
      repository,
      document(git(repository, "rev-parse", "HEAD"), "caller.js"),
      1,
      5,
    );
    expect(extract).toHaveBeenCalledTimes(3);
    expect(extract.mock.calls.at(-1)?.[1]).toBe("typescript");
    git(repository, "mv", "User.ts", "Renamed.ts");
    git(repository, "commit", "-m", "rename only");
    const result = await index.definitions(
      repository,
      document(git(repository, "rev-parse", "HEAD"), "caller.js"),
      1,
      5,
    );
    expect(result.targets[0]?.document.path).toBe("Renamed.ts");
    expect(extract).toHaveBeenCalledTimes(3);
  });

  it("loads multiple grammars in the isolated worker", async () => {
    const worker = new ParserWorkerClient();
    try {
      for (const language of ["javascript", "typescript", "tsx"] as const) {
        const result = await worker.extract("export function Button() {}", language);
        expect(result.partial).toBe(false);
        expect(result.tags[0]?.name).toBe("Button");
      }
    } finally {
      worker.close();
    }
  });
});
