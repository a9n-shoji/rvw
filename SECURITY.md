# Security Policy

## Supported versions

公開後は、最新の0.x releaseをbest effortで扱います。古いreleaseへの修正や応答期限は保証しません。

## Reporting a vulnerability

脆弱性の詳細、exploit、credential、private repositoryの情報をpublic Issueへ投稿しないでください。

GitHub repositoryの`Security` tabに`Report a vulnerability`が表示される場合は、GitHub Private
Vulnerability Reportingから報告してください。表示されない場合、現在このrepositoryには公開できる
private連絡先がありません。機密情報をIssueへ移さず、maintainerがprivate reportingを有効にするまで
詳細の送信を控えてください。

報告には、影響、再現条件、影響するversion、可能なら最小の再現手順を含めてください。特に次の境界は
security上重要です。

- local repository、Git object、filesystem path
- GitHub CLI authentication
- `127.0.0.1` serverのHost / Origin検証
- Markdown、HTML、Mermaid、repository内画像のrendering
- SQLite databaseとmigration
- bundled SkillとAgent向けCLI protocol

受領確認、修正、公開のSLAは設けていません。検証中の情報は、修正版または回避策を用意する前にpublicへ
出さないようお願いします。
