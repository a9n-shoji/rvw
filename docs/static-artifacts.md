# Static HTML artifacts

rvw provides a safe viewport, code references, comments, search, and navigation. It does not prescribe
an artifact design system. Authors own layout, typography, palette, backgrounds, illustrations, and
information density. An editorial essay, a dense dashboard, or a wide comparison may use unrelated
visual styles. The `--rvw-*` theme variables are optional conveniences, not a requirement. Accessibility,
readability, and layouts that work at different pane widths remain author responsibilities.

HTML-only walkthroughs use the available pane width; authored `max-width` controls a narrower report.
Markdown/Mermaid walkthrough widths are unchanged. Keep overflow local to wide diagrams or tables
when appropriate. The iframe has a 20,000px height cap and scrolls internally beyond it.

## Import a standalone document

Import a UTF-8 HTML file. Keep the original HTML document, including `html`, `head`, `body`, inline `style`, CSS selectors and
font declarations. The importer wraps the document in an `html-preview` fence without rewriting it.
Fragments remain supported. Standalone documents retain browser typography defaults unless the
artifact supplies its own CSS; rvw does not impose its font size or color scheme. Only safe charset, viewport, color-scheme and description metadata are
accepted. Scripts, event handlers, frames, forms, external stylesheets, refresh metadata, and active
content produce explicit errors; they are not silently removed. External stylesheets must be inlined
before import. No React/JavaScript runtime or external service integration is involved.

```sh
rvw walkthrough publish --html report.html --assets-dir assets --stdin --json < metadata.json
rvw walkthrough update rvw://walkthrough/WALKTHROUGH_ID --html report.html --assets-dir assets --stdin --json < update-metadata.json
```

`metadata.json` supplies the usual `pullRequest`, `sourceOid`, `title`, and `references`, but omits
`body`. Update metadata omits `pullRequest` too. At least one declared `rvw-ref:` code link is still
required. Example (replace the commit ID, repository path, and PR URL with verified values):

```json
{
  "pullRequest": "https://github.com/owner/repository/pull/7",
  "sourceOid": "0123456789012345678901234567890123456789",
  "title": "Request boundary review",
  "references": [
    {
      "id": "handler",
      "label": "Handler",
      "path": "src/handler.ts",
      "startLine": 1,
      "endLine": 20,
      "description": null
    }
  ]
}
```

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      @font-face {
        font-family: Report;
        src: url(assets/fonts/report.woff2) format("woff2");
      }
      html {
        background: #102a43;
        color: #f0f4f8;
      }
      body {
        font:
          18px/1.6 Report,
          serif;
        margin: 0;
      }
      main {
        max-width: 76rem;
        margin: auto;
        padding: 5vw;
      }
      .cover {
        background-image: url(assets/images/cover.png);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Request boundaries</h1>
      <p><a href="rvw-ref:handler">Inspect the handler</a></p>
      <img src="assets/images/cover.png" alt="Boundary diagram" />
    </main>
  </body>
</html>
```

The corresponding files are `assets/fonts/report.woff2` and
`assets/images/cover.png`. They do not need to exist in Git. With `--html`, bundle paths are relative to the HTML file's directory,
so existing `assets/...` URLs stay unchanged; select a directory inside that tree. Without `--html`,
paths are relative to `--assets-dir` itself. The directory scanner includes supported image/WOFF2
extensions and ignores source/metadata/license files; symlinks are always rejected. Referencing an
ignored or unavailable file is an error, never a request to the filesystem or network. Font licensing is the author's
responsibility. A tested editorial example lives at `test/fixtures/static-artifact/editorial.html`.

## Asset contract and lifecycle

The existing publish/update JSON protocol also accepts an optional `assets` array, independently of
`body`: `{ "path": "fonts/report.woff2", "mediaType": "font/woff2", "base64": "..." }`.
Base64 is a transport encoding for separate asset bytes, not an HTML embedding. The CLI directory
option generates this envelope. Assets are stored as SQLite BLOBs in the same transaction as the
walkthrough. Viewer/get responses return metadata (`path`, `mediaType`, `byteLength`, `sha256`), not
base64. A PR-scoped, hash-checked endpoint supplies the bytes. The parent viewer resolves these to
data URLs inside the sandbox; fonts/images require no OS font installation, CDN or network service.
They survive application restart and can be displayed offline while the local rvw server runs.

- Supported bundles: PNG, JPEG, GIF, WebP, AVIF, WOFF2. The declared MIME must match byte signatures;
  WOFF2 header lengths/table count/decompressed-size bounds are checked. Invalid fonts may still be
  rejected by the browser's font decoder. Use inline SVG for vector art; bundled SVG is not accepted.
- Maximum 32 assets, 5 MiB per asset, 20 MiB total, independently of the unchanged 256 KiB body limit.
  WOFF2 declared decompressed size is capped at 32 MiB. Existing CLI/socket payload limits remain.
- Paths are case-sensitive relative names using ASCII letters, digits, `_`, `-`, `.`, `/`. Absolute
  paths, traversal, percent escapes, URL schemes and symlinks are rejected. No automatic remote fetch.
- CSS URLs must identify bundled assets (relative paths or `rvw-asset:path`) of the appropriate type:
  WOFF2 for `@font-face`, images for other declarations. Internal SVG `url(#id)` remains supported.
  `local()` font sources, `@import`, image-set, executable CSS, and unsupported/unparsed syntax fail
  explicitly. CSS is parsed as syntax, including escaped identifiers, rather than filtered by regex.
- `<img src="assets/images/cover.png">` uses a bundled asset if present, otherwise the existing exact-commit
  repository-image mechanism. `<img src="rvw-asset:images/cover.png">` explicitly requires a bundle.
  CSS image URLs only use bundles; they never fall through to arbitrary filesystem or repository URLs.
- Update without `assets` preserves the bundle; supplying `assets` replaces it completely. An empty
  array removes all assets, provided the new body does not require them. Missing/mistyped resources
  reject the whole update. Use a new path when bytes change: an existing asset path cannot be replaced
  in place. This makes referenced asset changes explicit in the document and its comment hash.
- Deleting the walkthrough (or clearing its PR) cascade-deletes its assets. No historical asset
  archive is retained. Failed writes roll back both metadata and bytes.

## Boundaries and compatibility

The iframe still has no `allow-scripts`. CSP denies network, scripts, frames, forms, workers and
objects; only validated data images/fonts and inline styles are enabled. Parent-only APIs retain the
normal local-server security checks. No upload URL becomes a general-purpose hosting endpoint.

Code-reference chips and comment controls belong to rvw; all other visual design belongs to the
artifact. CSS decoration does not insert nodes into code links, preserving text anchors. Comments
retain exact DOM/text endpoints and the body hash; changed HTML makes precise anchors Outdated.
Search, navigation, code-reference pane behavior, and Markdown/Mermaid compatibility remain intact.
Fonts trigger layout/iframe-height recalculation after loading. Exact appearance can still vary with
browser rendering, and unsupported HTML/CSS or invalid font files must be corrected explicitly.
