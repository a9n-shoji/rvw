# Contributing

`rvw`は個人で開発・保守しているプロジェクトです。不具合報告や機能の提案は
[GitHub Issues](https://github.com/a9n-shoji/rvw/issues)へお願いします。再現手順、期待した結果、
実際の結果、`rvw --version` と実行環境を書いていただけると調査しやすくなります。
脆弱性の報告は公開Issueへ書かず、[セキュリティ方針](SECURITY.md)に従ってください。

設計や開発範囲、優先順位は保守担当者が判断します。返信や修正の時期はお約束できません。
Pull Requestも受け取れますが、積極的には募集しておらず、
レビューや取り込みを見送る場合があります。forkして変更・再配布することは、[MIT License](LICENSE)の範囲で自由です。

## 開発用の起動と検証

Node.js 24.15.0以上、Git、pnpm 11.21.0を使います。通常テストは実Gitとテスト用のGitHub接続処理を使い、
個人のGitHub認証や実PRを必要としません。

```bash
pnpm install --frozen-lockfile
pnpm demo
```

デモの操作は[利用ガイド](docs/usage.md#デモで同じ疑問を追う)、
デモ・E2Eデータの構成と画面の再撮影は[Fixture architecture](docs/fixture-architecture.md)を参照してください。
現在のrvw checkoutのコミット履歴を読む場合は `pnpm demo:dogfood` を使います。
履歴が足りない場合はエラーになり、暗黙のfetchは行いません。停止はCtrl+Cです。

```bash
pnpm check
pnpm test
pnpm test:dogfood
pnpm exec playwright install chromium
pnpm test:e2e
pnpm build
pnpm test:package
```

`test:package` はビルドしてtarballを作り、一時ディレクトリへインストールして、
checkout外からCLI、migration、画面、同梱Skillを確認します。
PRのCIではLinux、main更新時とリリース時はmacOS / Linux / Windowsでパッケージの動作を確認します。
通常のCIからnpmへ公開することはありません。

未公開の変更を通常のCLIとして試す場合は、ビルド後に `node dist/cli.mjs` を使えます。
グローバルな `rvw` コマンドとして使う必要がある場合だけ `pnpm link --global` を実行してください。
ソースを変更する前に[実装仕様](docs/implementation-spec.md)と[設計](docs/architecture.md)を確認し、
意図的な設計変更は[判断記録](docs/decisions.md)へ残します。

Agent向けコマンドやJSONは[CLI protocol](docs/cli-protocol.md)、説明作成の評価は
[Walkthrough](docs/walkthrough-producer-evaluation.md)、[Structure](docs/structure-producer-evaluation.md)、
[説明の構成](docs/review-composition-evaluation.md)を参照してください。
保守担当者向けのバージョン、タグ、npm公開、障害対応は[リリース手順](docs/releasing.md)にまとめています。
