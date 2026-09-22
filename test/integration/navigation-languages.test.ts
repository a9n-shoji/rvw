import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { navigationLanguage } from "../../src/domain/code-navigation.js";
import { GitClient } from "../../src/infrastructure/git/git-client.js";
import { GitCodeNavigation } from "../../src/infrastructure/navigation/git-code-navigation.js";
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
  return { repository, extract, index: new GitCodeNavigation(new GitClient(), extract) };
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

  it("restricts Git grep itself to family extensions and basenames at any depth", async () => {
    const { repository } = fixture();
    mkdirSync(repository + "/nested");
    const ruby = [
      "a.rb",
      "nested/a.rake",
      "a.gemspec",
      "Gemfile",
      "Rakefile",
      "nested/Gemfile",
      "nested/Rakefile",
      "odd:line\n[glob]*?.rb",
    ];
    const js = ["a.js", "nested/a.jsx", "a.mjs", "a.cjs", "a.ts", "nested/a.tsx", "a.mts", "a.cts"];
    for (const file of [...ruby, ...js, "Gemfile.lock", "asset.svg", "vendor.txt"])
      writeFileSync(repository + "/" + file, "Needle");
    writeFileSync(repository + "/asset.bin", Buffer.from("Needle\0binary"));
    git(repository, "add", ".");
    git(repository, "commit", "-m", "families");
    const oid = git(repository, "rev-parse", "HEAD");
    writeFileSync(repository + "/.gitattributes", "* -diff\n");
    git(repository, "config", "color.grep", "always");
    const client = new GitClient();
    expect((await client.navigationPaths(repository, oid, ["Needle"], "ruby")).paths).toEqual(
      new Set(ruby),
    );
    for (const language of ["javascript", "typescript", "tsx"])
      expect((await client.navigationPaths(repository, oid, ["Needle"], language)).paths).toEqual(
        new Set(js),
      );
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

  it("finds JSX components across JS and TS, excludes Ruby and comments, and follows direct named import aliases", async () => {
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
      "Button.tsx",
      "Button.jsx",
    ]);
    expect(result.partial).toBe(false);
    for (const [line, column] of [
      [2, 4],
      [3, 2],
    ])
      expect(
        (await index.definitions(repository, document(oid, "App.tsx"), line!, column!)).targets,
      ).toEqual([]);
  });

  it("keeps Ruby locals inside their method and retains multiple assignments", async () => {
    const { repository, index } = fixture();
    const source =
      "order = outside\ndef create(order)\n order = Order.find(1)\n order.confirm!\nend\ndef other\n order = Other.new\n order.confirm!\nend\n";
    const oid = commitFile(repository, "orders.rb", source, "locals");
    const result = await index.definitions(repository, document(oid, "orders.rb"), 4, 2);
    expect(result.targets.map((t) => t.line)).toEqual([2, 3]);
    expect(result.targets.every((t) => t.evidence === "local-scope")).toBe(true);
    expect(
      (await index.definitions(repository, document(oid, "orders.rb"), 8, 2)).targets.map(
        (t) => t.line,
      ),
    ).toEqual([7]);
    expect(
      (await index.definitions(repository, document(oid, "orders.rb"), 3, 2)).targets.map(
        (t) => t.line,
      ),
    ).toEqual([2]);
  });

  it("prefers the nearest JS block and TypeScript parameters over imports", async () => {
    const { repository, index } = fixture();
    const source =
      'import { Button } from "./Button";\nfunction App(Button: unknown) {\n { const Button = local;\n Button(); }\n Button();\n}\n';
    const oid = commitFile(repository, "App.ts", source, "scopes");
    expect(
      (await index.definitions(repository, document(oid, "App.ts"), 4, 2)).targets.map(
        (t) => t.line,
      ),
    ).toEqual([3]);
    expect(
      (await index.definitions(repository, document(oid, "App.ts"), 5, 2)).targets.map(
        (t) => t.line,
      ),
    ).toEqual([2]);
  });

  it.each(["js", "ts", "tsx"])(
    "keeps inner function bindings ahead of outer locals in %s",
    async (extension) => {
      const { repository, index } = fixture();
      const source = [
        'const choose = () => "outer";',
        "function run() {",
        "  function choose() {",
        '    return "inner";',
        "  }",
        "  return choose();",
        "}",
      ].join("\n");
      const file = `caller.${extension}`;
      const oid = commitFile(repository, file, source, "function shadowing");
      const result = await index.definitions(repository, document(oid, file), 6, 10);
      expect(result.status).toBe("possible");
      expect(result.targets[0]).toMatchObject({
        line: 3,
        kind: "function",
        evidence: "local-scope",
      });
      expect(result.targets.some((target) => target.line === 1)).toBe(false);
      const declaration = await index.definitions(repository, document(oid, file), 3, 12);
      expect(declaration.targets.some((target) => target.line === 3)).toBe(false);
      index.close();
    },
  );

  it("preserves nearest variables and class bindings while keeping uncaptured definitions", async () => {
    const { repository, index } = fixture();
    commitFile(repository, "other.js", "export function choose() {}\n", "ordinary definition");
    const oid = commitFile(
      repository,
      "caller.js",
      [
        "const value = 1;",
        "function run() {",
        "  const value = 2;",
        "  return value;",
        "}",
        "const Model = other;",
        "function create() {",
        "  class Model {}",
        "  return new Model();",
        "}",
        "const choose = unknown;",
        "class Service { choose() {} }",
        "choose();",
      ].join("\n"),
      "mixed bindings",
    );
    expect(
      (await index.definitions(repository, document(oid, "caller.js"), 4, 10)).targets.map(
        (t) => t.line,
      ),
    ).toEqual([3]);
    expect(
      (await index.definitions(repository, document(oid, "caller.js"), 9, 14)).targets[0],
    ).toMatchObject({ line: 8, kind: "class" });
    const mixed = await index.definitions(repository, document(oid, "caller.js"), 13, 1);
    expect(mixed.targets.map((t) => [t.document.path, t.line])).toEqual([
      ["caller.js", 11],
      ["caller.js", 12],
      ["other.js", 1],
    ]);
    index.close();
  });

  it.each(["import", "import type"])(
    "uses %s aliases in type positions without value-local interference",
    async (keyword) => {
      const { repository, index } = fixture();
      commitFile(repository, "model.ts", "export class Model {}\n", "model");
      const oid = commitFile(
        repository,
        "caller.ts",
        [
          `${keyword} { Model as Item } from "./model";`,
          ...(keyword === "import" ? ["const instance = new Item();"] : ["// type-only import"]),
          "let value: Item;",
          "function run(Item: unknown) {",
          "  let nested: Item;",
          "  return Item;",
          "}",
        ].join("\n"),
        "typed aliases",
      );
      const positions = [
        [3, 12],
        [5, 15],
      ];
      if (keyword === "import") positions.push([2, 22]);
      for (const [line, column] of positions) {
        const result = await index.definitions(
          repository,
          document(oid, "caller.ts"),
          line!,
          column!,
        );
        expect(result.status).toBe("possible");
        expect(result.targets[0]).toMatchObject({
          name: "Model",
          evidence: "relative-import",
          document: { path: "model.ts", sourceOid: oid },
        });
      }
      const value = await index.definitions(repository, document(oid, "caller.ts"), 6, 10);
      expect(value.targets[0]).toMatchObject({ line: 4, evidence: "local-scope" });
      index.close();
    },
  );

  it("ranks relative named imports, handles aliases and resolves reused blobs relative to each path", async () => {
    const { repository, index, extract } = fixture();
    mkdirSync(repository + "/a");
    mkdirSync(repository + "/b");
    commitFile(repository, "a/Button.tsx", "export function Button() {}\n", "a");
    commitFile(repository, "b/Button.tsx", "export function Button() {}\n", "b");
    const source = 'import { Button as Action } from "./Button";\n<Action/>;\n';
    commitFile(repository, "a/App.tsx", source, "a usage");
    const oid = commitFile(repository, "b/App.tsx", source, "b usage");
    for (const folder of ["a", "b"]) {
      const result = await index.definitions(repository, document(oid, folder + "/App.tsx"), 2, 2);
      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]).toMatchObject({
        name: "Button",
        evidence: "relative-import",
        document: { path: folder + "/Button.tsx", sourceOid: oid },
      });
    }
    expect(extract).toHaveBeenCalledTimes(2);
    const next = commitFile(
      repository,
      "b/App.tsx",
      'import { Button } from "../a/Button";\n<Button/>;\n',
      "new import",
    );
    const result = await index.definitions(repository, document(next, "b/App.tsx"), 2, 2);
    expect(result.targets.map((t) => [t.document.path, t.evidence])).toEqual([
      ["a/Button.tsx", "relative-import"],
      ["b/Button.tsx", undefined],
    ]);
    expect(
      (await index.definitions(repository, document(oid, "b/App.tsx"), 2, 2)).targets[0]?.document
        .path,
    ).toBe("b/Button.tsx");
  });

  it("does not treat method calls as locals or infer package and default import aliases", async () => {
    const { repository, index } = fixture();
    commitFile(repository, "Button.tsx", "export function Button() {}\n", "component");
    const oid = commitFile(
      repository,
      "App.tsx",
      'import Renamed from "./Button";\nimport { Button as PackageButton } from "package";\n<Renamed/>;\n<PackageButton/>;\n',
      "unsupported imports",
    );
    for (const line of [3, 4])
      expect(
        (await index.definitions(repository, document(oid, "App.tsx"), line, 2)).targets,
      ).toEqual([]);
    const ruby = commitFile(
      repository,
      "call.rb",
      "def confirm!; end\nconfirm = 1\norder.confirm!\n",
      "method",
    );
    expect(
      (await index.definitions(repository, document(ruby, "call.rb"), 3, 7)).targets[0],
    ).toMatchObject({ line: 1, kind: "method" });
  });

  it("prefers the caller's grammar over family type declarations", async () => {
    const { repository, index } = fixture();
    commitFile(repository, "a.ts", "export interface Button {}\n", "type");
    commitFile(repository, "z.js", "export function Button() {}\n", "value");
    const oid = commitFile(repository, "caller.js", "Button();\n", "usage");
    expect(
      (await index.definitions(repository, document(oid, "caller.js"), 1, 1)).targets.map(
        (t) => t.document.path,
      ),
    ).toEqual(["z.js", "a.ts"]);
  });

  it("does not let unrelated alias-name declarations crowd out an imported target", async () => {
    const { repository, index } = fixture();
    commitFile(
      repository,
      "a.tsx",
      "export function Button() {}\n".repeat(150),
      "other declarations",
    );
    commitFile(repository, "z.tsx", "export function Button() {}\n", "import target");
    const oid = commitFile(
      repository,
      "caller.tsx",
      'import { Button as Action } from "./z";\n<Action/>;\n',
      "usage",
    );
    const result = await index.definitions(repository, document(oid, "caller.tsx"), 2, 2);
    expect(result.targets.map((t) => t.document.path)).toEqual(["z.tsx"]);
    expect(result.truncated).toBe(false);
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
