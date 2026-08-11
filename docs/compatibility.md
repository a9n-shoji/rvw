# 0.x compatibility

`rvw`は0.xの間も、外部ユーザーとAgentが依存する境界を理由なく壊さないことを目標にします。一方で、
初期設計を固定するためのstable 1.0 APIを宣言するものではありません。

互換性を意識するsurfaceは次です。

- `rvw` CLIのcommand、flag、exit status
- `rvw://comment/<uuid>`と`rvw://walkthrough/<uuid>`
- `--json` responseと`rvw protocol --json`が公開するmachine protocol version / capability
- bundled `rvw` / `rvw-walkthrough` SkillとCLI protocolの組み合わせ
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
正式な復旧経路はREADMEとCLIが案内する`rvw pr reset`です。
