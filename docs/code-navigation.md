# Code navigation

## 採用方式とsource

Tree-sitter WASMと標準言語の構文queryを同梱し、外部LSPや言語環境のsetupを要求しない。
対象は表示中のGit commitのblobのみ。dirty working tree、未追跡file、外部gemやnode_modulesを探索しない。
diff削除側はold sourceOid、追加側はnew sourceOidを使う。

local候補がなければ、commit指定の `git grep -l -z -a -F --no-textconv` で識別子を含むfile名を取得し、
同じ言語familyのGit tree entryへ絞り、Tree-sitterで宣言だけを抽出する。grepの文字列一致自体は候補として返さない。
相対named importの別名では元の名前も検索する。行検索の件数上限による取りこぼしを避けるため、既存の行検索APIとは別にfile名を取得する。
`-a` と `--no-textconv` によりworking treeの属性やtextconv設定を検索結果へ持ち込まない。binaryの除外はblob decoderで行う。

全commitのsnapshot indexは保持しない。blob解析cacheと、そのqueryのsourceOidにおけるpath配置を分離する。
snapshot indexには繰り返す広範な同名探索を高速化する利点があるが、初回に無関係なfileも解析し、別の索引cacheとbuild状態が必要になる。
search-firstは毎回Git検索を行う代わりに、必要なblobだけを解析し、その状態管理を省く。広く現れる名前を繰り返す場合の遅さはこの選択のtrade-off。
方式比較の実測条件・結果はPRの検証記録で扱い、単発の時間を性能保証にはしない。

## 対応言語と精度モデル

| 対象                                               | 構文上の候補                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| Ruby (.rb / .rake / .gemspec / Gemfile / Rakefile) | class、module、method、singleton method、alias、constant、local代入・引数 |
| JavaScript / JSX (.js / .jsx / .mjs / .cjs)        | function、class、method、変数、JSX component、local代入・引数             |
| TypeScript (.ts / .mts / .cts)、TSX (.tsx)         | JSの候補に加えtype、interface、enum                                       |

ReactはJSX/TSXとして扱い、function / arrow componentやmemo等へ代入した変数を探索できる。
RubyとJS familyの同名候補は混ぜない。JS / TS / JSX / TSXは横断する。

- local参照は、最も近い可視scopeの同名代入・引数に絞る。複数代入はすべて候補に残す。
- `import { Button as Action } from "./Button"` のような相対named importは別名も含めてfile候補を優先する。他の同名候補は残す。
- 優先順は相対import先、同じfile、同じ言語設定、同じfamily。型と値の区別を推測して候補を削除しない。
- UIにはlocalの根拠を「同じスコープ」、相対importの根拠を「import先」として表示する。
- 1件でも「定義候補」とし、自動ジャンプやsemanticにexactという扱いはしない。クリックした宣言自身だけを除外する。

default import、namespace import、package import、re-export、tsconfig paths、完全なmodule resolution、
import先のexport検証、型に基づくreceiver解決は行わない。未対応のimport形式は同名探索になるため、別名では候補なしになる場合がある。
実行順・到達する代入・JS var hoisting・Ruby block内の再代入は解析しない。
Rubyの継承、namespace、include順序、visibility、autoloadや、Rails DSLで生成されるmethodは解決しない。
React props/HOCのsemanticな追跡、Find usages、ERB、Vue SFCも対象外。未対応言語の通常Viewer/searchは影響を受けない。

## ViewerとAPI

全文・diffの識別子をCmd/Ctrl+clickすると、宣言preview付きの候補popupを表示する。
Shikiの描画tokenが括弧と名前をまとめていても、文字rangeとクリック位置で名前を選ぶ。DOMを書き換えず通常の選択・コピーを維持する。
symbolかどうかはserverの構文captureで確認する。

候補の通常clickは左、Cmd/Ctrl+clickは右の既存repository-file paneへexact sourceの全文と対象行を開く。
DocumentWorkspaceとreading historyを利用し、専用Viewerや別履歴を持たない。
popupはlayoutを押し広げず、長いpathを折り返し、候補多数ならscrollする。
↑↓ / Home / End / Tab / Enterで選択し、Escapeで閉じて元paneへfocusを戻す。
文書・commitの切替、外側click、scroll、resizeで閉じ、遅延responseで自動移動しない。

`GET /api/pull-requests/:id/definitions?sourceOid=...&path=...&line=...&column=...`
はPRとsource commitを検証し、1-based行・UTF-16列を構文captureと照合する。
結果は `possible / none / unsupported / unavailable`、候補、`partial`、`issues`、`skippedFiles`、`truncated`。
不完全な探索で候補がないことを、定義が存在しないという確定結果にはしない。

## cacheとfailure

`GitCodeNavigation`が言語ID + blob OIDのLRU cacheと同時parseの共有を持つ。
cacheにpathやcommitを入れず、rename/copyでも再利用する。grammarが変わる拡張子変更では再解析する。
queryごとにsource commitのtreeと結合し、SQLiteへ派生索引を保存しない。
Git読み取りはfull OIDとbatch framingを検証し、Viewerと同じUTF-8判定・改行正規化を使う。

parserは遅延起動する専用workerで動かす。timeout、crash、不正replyは実行中のjobだけを失敗させる。
そのworkerを破棄し、未実行のqueueはfresh workerで継続する。異なるblob間にAST状態の依存はない。
serviceのcloseだけは実行中・待機中を全rejectし、Git処理をabortする。idle workerも解放する。

構文エラーは回復できたcaptureとpartialを返す。parse budget到達は恒久cacheせず再試行できる。
検索範囲のbudget到達は部分結果として返すが、同じbudgetで再試行すれば全件に到達するとは保証しない。
Git/worker失敗は明示error、過負荷は429。失敗したparseをcacheしない。

## resource budget

以下は内部の防御・調整値であり、公開APIや言語拡張の固定仕様ではない。
数値の最適性を実証したものではなく、各行のfailure modelに対して有限の上限を設ける。
cacheのbyte数はserialized metadataであり、JS object / WASMの実メモリーそのものの上限ではない。

| 制限                                   | 現在値                        | 理由                                                                                     |
| -------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| file                                   | 1 MiB                         | 既存Viewerと共通。未知の入力のparse・転送量を制限                                        |
| 1探索のsource / 解析走査時間           | 16 MiB / 10秒                 | 広い名前による全repository解析と長時間待機を制限。partialを返す                          |
| blob cache                             | 16 MiB                        | processに残る派生metadataの量を制限。別のentry数上限は持たない                           |
| 同時lookup / worker待機                | 各8                           | Git processの多重起動と未解析textの滞留を制限。共通のconcurrency値                       |
| 表示候補                               | 100                           | 応答とpopupの量を制限。順位付き100件と超過判定用1件だけ保持                              |
| parser協調budget / hard timeout        | 100ms / 5秒                   | 通常の重い構文はpartial、停止不能なWASMや起動障害はworkerごと破棄                        |
| capture / query match state            | tags・context各20,000 / 4,096 | 密な入力のmetadata増幅とTree-sitter内部の同時match stateを制限                           |
| worker V8 old generation / stack       | 128 MiB / 4 MiB               | workerのJS heap・stackのresource exhaustionを抑制。WASM全体のhard memory ceilingではない |
| idle worker                            | 30秒                          | 操作終了後のgrammar/WASMメモリーを解放し、連続操作では起動を再利用                       |
| Git検索stdout / Git検索・batch timeout | 8 MiB / 10秒                  | 巨大なfile名一覧・停止したGit processを制限。stdout上限は既存検索と共通                  |
| Git batch                              | 32 blobs / 4 MiB              | process起動をまとめつつ、同時にbufferするsource量を制限。輸送上の調整値                  |
| 名前 / preview / import source         | 256 / 240 / 4,096文字         | 巨大identifierと宣言行によるmetadata・popupの膨張を防ぐ                                  |

Git tree / document読み取りには既存GitClientのprocess timeout・stdout制限も適用される。
snapshot数、pending snapshot数、file数/定義数のsnapshot上限、snapshot build queueは持たない。
主要budgetは `src/shared/constants.ts`、worker固有値は `parser-worker-client.ts` に置く。

## 標準言語の内部設定と配布

`navigation-packs/*.json` は標準同梱言語の内部dataであり、第三者向け拡張contractではない。
拡張子、family、grammar/query assetをparser・Viewerの対応判定・buildで共用し、設定の重複を避ける。
公開version、任意manifest loader、plugin実行、追加・更新CLIは提供しない。

`local.scope / local.definition / local.reference` と `local.scope-inherits` は公式locals queryの規約を利用する。
`context.nonlocal` はRuby method名等をlocal参照から除外する補助capture。
`import.name / import.local / import.source` と `relativeImportSuffixes` は現在のJS familyのnamed importを表す内部data。
共通coreでscope・相対pathを扱うための最小限の情報であり、ユーザー向け互換性を約束しない。

runtimeとgrammarのversionを固定し、CLIと専用workerへbundleする。WASM/queryとupstream licenseを同梱し、
native binding・prebuild・C sourceは配布しない。grammarのnative install scriptも無効化する。
runtime dependenciesなしのoffline installをpackage smokeで検証し、browserにはparser/WASMを配らない。
配布budgetは圧縮後6 MiB・展開後28 MiB。実際の測定値とtest実行結果はPRの検証記録へ置く。

## ローカルデモ

`pnpm demo:navigation --no-open` で実Git履歴を使うRuby/Reactデモを起動する。
既定portは43119、`RVW_NAVIGATION_DEMO_PORT=0` で自動割当。GitHub metadataだけをfixtureとして与える。

controllerの `order` から代入へ、`Checkout` から同名class候補へ、
Reactの `Button` からimport先を優先した候補へ移動できる。
diffの変更前後、rename、右pane、Backも試せる。実repositoryでの性能・精度保証を目的としたデモではない。
