# 0.x compatibility

`rvw`は0.xの間も、外部ユーザーとAgentが依存する境界を理由なく壊さないことを目標にします。一方で、
初期設計を固定するためのstable 1.0 APIを宣言するものではありません。

互換性を意識するsurfaceは次です。

- `rvw` CLIのcommand、flag、exit status
- `rvw://comment/<uuid>`、`rvw://walkthrough/<uuid>`、`rvw://structure/<uuid>`
- `--json` responseと`rvw protocol --json`が公開するmachine protocol version / capability
- bundled `rvw` / `rvw-review-compose` / `rvw-walkthrough` / `rvw-structure` /
  `rvw-watch-comments` SkillとCLI protocolの組み合わせ
- user dataを新しいversionへ引き継ぐforward migration

machine-readable contractへbreaking changeが必要な場合はprotocol versionを進め、同梱Skillと文書を同じ
releaseで更新します。0.x releaseではCLIやschemaが変わる可能性があるため、自動化側はprotocol versionと
capabilityを確認してください。

最初のpublic compatibility contractはprotocol version 1です。公開前に使用した内部version番号は
互換性保証の対象外であり、現在のschemaを過去のversion 1へ戻すことを意味しません。public release後は
version番号を再利用せず、breaking changeのたびに単調増加させます。

次はpublic APIではありません。

- `src/`内moduleの直接import
- SQLite table、column、migration fileを直接操作すること
- OS user data directory内の内部layout
- `refs/rvw/`を利用者が直接編集すること

SQLiteとGit refはrvwが管理します。downgrade互換や、手作業で変更したDB/refの修復は保証しません。
正式な復旧経路は[利用ガイド](usage.md#最後の復旧手段prをリセットする)とCLIが案内する`rvw pr reset`です。

## Protocol 6: Structure Regionsの撤去

protocol 5の`presentation.regions`を公開入出力から削除します。旧CLI入力は空配列でもstrict validationで拒否し、
同梱の全5 Skillはprotocol 6を要求します。`presentation: null`、start-only、backboneあり、単一Nodeの図は有効です。
既存DBはforward migration 023で`structures.graph_json`内の当該fieldだけを除去し、専用のretired Region ID tableを
削除します。URI、sourceOid、Node／Edge／anchor、残るpresentation、コメントとWalkthroughは保持します。
Node／Edgeのtombstoneとpublish冪等性台帳も保持します。台帳はhashとStructure IDのみを持ち、旧responseは保存していません。
以前のpublish keyを異なるprotocol payloadで再送しても成功へ読み替えず、既存URIを取得して更新してください。
内部socket contractも6へ進め、旧viewerとの混在は再起動を求める既存エラーで拒否します。
