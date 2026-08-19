# Changelog

公開releaseごとの利用者向け変更を記録します。package versionとAgent向けprotocol versionは独立して
管理し、machine contractのbreaking changeはprotocol versionにも明記します。

## [Unreleased]

## [0.2.0] - 2026-08-20

### Added

- Agentが新しい未解決threadを安全なMarkdownで記録できる`comment.create` CLI capability
- browserの戻る／進むで、review scopeやworkspace layoutを変えずに辿れるreading history
- PR commentを継続監視し、重複なく返信できる`rvw-watch-comments` Skill

### Changed

- reviewerの目的とrepository固有の指示に合わせて説明を組み立てるWalkthrough authoring guide

### Fixed

- 不正なMermaidを含むcommentを表示すると、一時的なerror SVGがcomment外へ残りviewer下部を覆う問題

## [0.1.1] - 2026-08-17

### Fixed

- 大規模repositoryでファイルを開閉した際に、非表示のQuick Open候補を二乗時間で再計算してUIが停止する問題

## [0.1.0] - 2026-08-17

### Added

- GitHub Pull Requestのcommit履歴、変更箇所、repository全体を読むローカルWeb viewer
- PR本文、file、code line、Walkthroughへのローカルcommentと未解決／解決済みthread
- Git commitへ固定したMarkdown、code reference、Mermaid bindingのWalkthrough
- Codex / Claude Codeで共通利用する`rvw`と`rvw-walkthrough` Skill installer
- `rvw://`参照を扱うversioned JSON CLI protocol
- CLI、Web assets、database migrations、bundled Skillsを含むglobal-install package

### Security

- localhost限定server、Host / Origin検証、sanitized Markdown / Mermaid rendering
- runtime依存をCLIへbundleし、install時に追加のruntime dependency treeを解決しない配布形式
