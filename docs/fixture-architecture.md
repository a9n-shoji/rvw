# Fixture architecture

rvwのfixtureは、失敗原因を局所化できる小さな契約と、ひとつの変更を縦断して読む受入シナリオを
混同しないため、次の4つへ分ける。

| Fixture   | 用途                                                                                                  | 実行場所                                               |
| --------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| contract  | 単一UI/API状態、binary / too-large / missing、comment placement、test-only mutation                   | 通常のPlaywright server。`RVW_FIXTURE_SCENARIO`省略時  |
| realistic | deterministicな注文service PRをPR本文、Git history、source、comment、Walkthrough、Structureとして縦断 | `pnpm demo`と`realistic-fixture.spec.ts`               |
| stress    | 100 comments、long document、20 / 100 / 500-node graphと各graph shape                                 | `viewer-performance.spec.ts`と`stress-fixture.test.ts` |
| dogfood   | 現在のrvw checkoutにあるcommitted Git objectsを読む任意の確認                                         | `pnpm demo:dogfood`のみ                                |

fixture serverは`RVW_FIXTURE_SCENARIO=contract|realistic|dogfood`だけを受け付ける。未知の値はcontractへ
fallbackせず起動時に失敗する。通常のPlaywrightはcontract serverとrealistic serverを起動し、dogfoodは
起動しない。

## Realistic fixture

`test/fixtures/realistic/realistic-fixture.mjs`はOS temporary directoryへSHA-1 repositoryを作る。author名・
email、author / committer date、timezone、line ending、file mode、signingを固定し、networkとrvw repositoryの
HEAD / branch / local refsを参照しない。終了時は生成directoryを削除する。

PRはauthenticated request boundary、order aggregateとpricing、inventory / payment、idempotency、同一
transaction内のorder / outbox永続化、dispatcherとobservability、payment reconciliationという7つのreview
単位で進む。manifestはrepository / diff shape、change kinds、layer、comment state、Walkthrough、Structure、
rename / delete targetsを一箇所に集約する。

fixtureを更新するときは、まずscenarioの意味を保ったままsourceとcommit progressionを変更し、その後に
semantic needleから作られるreferenceを更新する。手書き行番号は追加しない。builderのstartup validationと
`realistic-fixture.test.ts`は次をnamed invariantとして検証する。

- 別temporary directoryで同一commit OID、tree、changed-file manifestになること
- first-parent chain、base / head、file / diff shape、added / modified / renamed / deletedの存在
- Walkthrough reference ID、Mermaid binding、Structure origin / endpoint / source anchorの整合性
- comment targetと作成commit、PR / Walkthrough quote、rename追従、delete後Outdatedの整合性
- 同じsource fileが複数Structure nodeから逆引きできること
- missing pathが明示的にmissingになること

## Contract and stress ownership

contractのorder source / Walkthrough dataは`test/e2e/walkthrough-fixture.mjs`、Structure dataは
`test/fixtures/contract/contract-structures.mjs`に置く。`fixture-server.mjs`はHTTP behavior、selected
repository provider、fresh mutable comments / Walkthroughs / Structuresの橋渡しを担う。contract固有の
mutation endpointやbinary / too-large等のedge caseはrealisticへ複製しない。

stress generatorは`test/fixtures/stress/stress-fixture.ts`に置く。実務narrativeやrealistic manifestの件数を
増やすためには使わない。100-comment placement budgetは通常の`pnpm test:e2e`内、graph size / shapeとlong
document generationは通常の`pnpm test`内で実行され、CIから分離されていない。

## Dogfood mode

`pnpm demo:dogfood`は`createDogfoodFixture`を通して現在のcheckoutのcommitted objectsを読む。これはparserと
Git object readerを手元の実repositoryで確認するmodeであり、realistic acceptance contractではない。file数、
byte数、changed file数、PRの意味をnormal CIで固定assertしない。必要なhistoryがなければ、取得すべきhistoryを
示すerrorを返し、network fetchを暗黙に行わない。
