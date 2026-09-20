# runtime startup handoff の読書構成案

対象は `c45bc91f4a0cfd071c3be3622eb6418059e236ff..a2f016c5e90886cce769aa0990c6a05c7ce02ae9` 全体。参照座標は変更後の `a2f016c5e90886cce769aa0990c6a05c7ce02ae9` とする。読者はプログラミング、TypeScript、Promise、HTTP、ローカルプロセスを理解しているが、rvw 固有の用語や状態は知らない。

これはソースだけを使った推薦であり、rvw の既存 Artifact は読んでいない。公開・更新・preflight・preview は実施していない。以下の brief は評価用の著者メモで、rvw に保存する新しい形式ではない。ファイルマップの推薦は含むが、保存済みマップの存在や適合は未確認である。

推薦は、1 つのファイルマップ、2 つの小さな Walkthrough、局所条件の直接読解。最初の入口には「PR を調べている間に接続待ちを使い切らない」を勧める。`rvw open` は GitHub PR をローカル HTTP 画面で開くコマンドで、起動済みのプロセスを再利用できる。そのプロセスは画面がなくなると終了するため、次の画面を準備する間も生存を保つ必要がある。この状況なら、予約を作る最初のコードを、内部用語を先に覚えずに読める。

| 推薦する面                                                              | 答える問い                                                                             | 入口と境界                                                                                                                                            |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Walkthrough「PR を調べている間に接続待ちを使い切らない」                | 既存プロセスが open を受理した後、PR の取得待ちとブラウザーの接続待ちをどう区切るか    | `src/cli/main.ts:462–502`。受理した 1 件が予約 ID、URL、HTTP ヘッダーを経て接続記録になるまで。完全な内容候補を `runtime-handoff-after.json` に収録。 |
| Walkthrough「終了中のプロセスから次の open へ進む」                     | 既存プロセスが受理できないとき、新しい呼び出しは何を繰り返し、いつ新規初期化へ進めるか | `src/cli/main.ts:594–633`。既存プロセスの受付停止、ロック保持、解放、次の取得と worker の ready 通知まで。未制作 brief。                              |
| ファイルマップ Structure「open の再試行・予約・接続を実装するファイル」 | ロック、予約、URL、HTTP 接続記録の定義と、それを呼ぶファイルはどこか                   | `src/cli/main.ts` をソース確認の開始候補とする。時間順の説明を入れず、下記の直接関係を示す。未制作 brief。                                            |

受理済みのケースと受理できないケースは、読者が独立に調べられる。前者では予約 ID を追い、後者では同じ database のロック取得結果を追う。これらを 1 本にすると、予約が存在しない枝で予約の説明を中断し、別プロセスの終了と再取得を保持し続ける必要がある。2 本は各自の入口で必要な条件を述べ、互いを前提読書にしない。ファイルマップは実装位置に戻るための別の問いに限定する。通常の behavior Structure は追加しない。今回の重要な関係は「いつ期限を付けるか」「解放前に何を作らないか」という順序であり、同じ内容を別の図にすると重複するためである。

## 内部 brief：PR を調べている間に接続待ちを使い切らない

**著者への指定。** role は `walkthrough`。中心の問いは、受理された既存プロセスへの 1 件の open が、遅い PR 取得でブラウザー接続前に自動終了されない仕組み。ソース座標と読者像は冒頭の指定に従う。最初に、runtime はここでは SQLite と HTTP 画面を持つローカルプロセス、viewer はその画面を開いたブラウザー文書、と必要な分だけ説明する。

ケースは、同じ database のブラウザー連動プロセスが生きており、最後の画面が閉じた後の終了猶予中に新しい `rvw open` が到着し、受付はまだ可能、明示 port の衝突なし、PR の取得は成功するが遅い、という例。具体的な経過秒数を置くなら説明用の仮定と明記する。予約作成→非同期の PR 取得→期限設定→同じ予約 ID を含む URL→ブラウザーのヘッダー→HTTP route→接続記録、という候補経路を調べる。終点は pending の予約が消え、ブラウザー ID と最後の通信時刻が記録されたところ。PR の詳細描画やコメント処理には進まない。

**独立確認する候補主張。** (1) `reserveViewer` は PR 取得より前に呼ばれる。(2) `opening` は開始期限を持たず、終了猶予タイマーも止める。(3) 取得後に同じ ID を `startup` に変え、そこから既定 30 秒を計算する。(4) URL の `viewerLease` がヘッダーに移り、受信 route が lifecycle に渡す。(5) 失敗時は予約を消し、接続がない場合は startup 期限と終了猶予が効く。短いタイマーを使うテストとコードの一般条件を分けて確認する。遅延したタイマーの期限延長を無視して「必ず 30 秒で終了」と書かない。

**共有語と重複の境界。** `opening` は PR 取得中の予約、`startup` は取得後の接続待ち予約、`viewers` はブラウザー ID と最終通信時刻の表。これらも producer がソースで再確認する。別 Walkthrough がロックを取得し直す枝を説明するので、本稿では stopped により受理されない境界と確認箇所だけ示す。ファイルマップの一覧を再掲しない。

**図の問い。** PR 取得の `await` を挟んで、期限がいつ生まれ、予約 ID がどこへ渡るか。小さな sequenceDiagram が候補。図の participant、呼び出し順、応答、HTTP 転送はすべてソース確認対象。Worker をこの成功再利用ケースに混ぜない。

## 内部 brief：終了中のプロセスから次の open へ進む

**著者への指定。** role は `walkthrough`。中心の問いは、既存プロセスの socket 受付が先に終わり、database のロックがまだ残る期間に新規 open が来たとき、消えた socket を待ち続けず次の取得へ進む方法。ロックは同じ database の runtime を同時に初期化しないためのファイル、と入口で説明する。`owned` は取得できた結果、`reused` は既存プロセスから URL を得た結果と導入する。

同じ database に対する通常の自動 open を例にする。親の再利用試行が未利用または停止中となり worker が始まり、その最初の取得は負ける。旧プロセスが socket 受付を止め、HTTP、Runtime/SQLite を閉じ、ロックを解放する。新しい呼び出しが次の取得で勝ち、Runtime を作り、PR を開き、HTTP を起動して ready の URL を親へ送るところを終点とする。回数は固定しない。別の競合者が勝つ場合、次の試行が `reused` で終わる枝と、database 不一致や停止中以外の例外で終了する枝を添える。

**独立確認する候補主張。** `main.ts:381–410, 574–633, 702–755`、`agent-socket.ts:785–814, 919–951, 1000–1039, 1054–1145` で上記を検証する。毎回 `startRuntimeAgentSocket` を試し、負けた候補を close してから `viewer.open` を送り、既定 50 ms 後に取得から再開する候補。`runtime-stopping` は `PROCESS_FAILED` と details.reason の組み合わせで識別する候補。timeout はループ境界の確認であり、実処理すべてに対する厳密な 120 秒上限と表現しない。`test/unit/agent-socket.test.ts:657–693` は real socket を作るテストの記述として読み、今回実行したとは言わない。`EPERM` 時にテストが戻る条件も保持する。

**共有語と重複の境界。** 受理済みの予約→ブラウザーへの移行は先の Walkthrough が扱う。本稿の主ケースでは旧プロセスに新しい予約が成立したとは置かない。新規起動側の最初の PR 取得は HTTP 起動前なので、再利用側の予約の図を流用しない。図を使うなら、旧プロセスと新しい呼び出しの時間的重なり、ロック解放前後の取得結果を示す小さな sequenceDiagram が候補。順序を一つの常時成立する実行記録に見せない。

## 内部 brief：open の再試行・予約・接続を実装するファイル

**著者への指定。** role は `file-map Structure`。PR の変更領域は同じ open の開始・再利用・接続に限る。全体を一つの runtime 呼び出し木とみなさず、ソース確認の開始候補を `src/cli/main.ts` とする。1 Node は 1 path とし、各 Node は変更後 commit にあるファイル全体を anchor にする。以下の内容と関係は composer の候補であり、producer が用法を独立に検証する。schema の ID はここでは指定しない。

| 候補ファイル                         | この範囲で読む定義・処理                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `src/cli/main.ts`                    | 再利用・取得の試行、予約を挟む PR 取得、URL、worker 通知、終了時の close 順             |
| `src/server/agent-socket.ts`         | database に対応する socket、ロック取得と解放、`viewer.open` の入出力と handler 呼び出し |
| `src/server/start-server.ts`         | HTTP と lifecycle の生成、予約 ID 生成、停止中エラー、close                             |
| `src/server/viewer-lifecycle.ts`     | opening/startup の予約、接続時刻、期限・空状態のタイマー                                |
| `src/application/runtime.ts`         | SQLite・Git・GitHub・service の生成と database close                                    |
| `src/application/rvw-service.ts`     | PR のローカル参照、GitHub 取得、返す PR ID                                              |
| `src/server/app.ts`                  | HTTP ヘッダー検証、heartbeat と release の呼び出し                                      |
| `src/shared/constants.ts`            | URL パラメーターと HTTP ヘッダーの名前                                                  |
| `src/web/viewer-session.ts`          | URL の予約 ID を読み取り、ブラウザー ID と一緒にリクエスト用ヘッダーを作る              |
| `src/web/app/App.tsx`                | 定期問い合わせへ viewerHeartbeatRequest の結果を渡す                                    |
| `test/unit/viewer-lifecycle.test.ts` | 取得中の予約、取得後の期限、呼び出し順、取得再試行を検査する記述                        |
| `test/unit/agent-socket.test.ts`     | socket 受付停止とロック解放を分け、次の取得を検査する記述                               |

直接関係の候補と根拠は次のとおり。Node のファイル anchor だけで、関係の証明に代えない。

| from → to                                | 短い述語               | 用法を確認する場所                                                              |
| ---------------------------------------- | ---------------------- | ------------------------------------------------------------------------------- |
| main → agent-socket                      | 取得・送信を呼ぶ       | main:594–629                                                                    |
| main → agent-socket                      | handler を登録する     | main:726–734                                                                    |
| agent-socket → main                      | 登録 handler を呼ぶ    | agent-socket:1085–1094 と main:462–502,734。匿名 handler の登録先まで対照する   |
| main → start-server                      | HTTP を開始する        | main:727–734                                                                    |
| main → start-server                      | 予約を作り期限を付ける | main:481–497 と start-server:78–104                                             |
| main → runtime                           | 生成し閉じる           | main:758,760–763,727,574–589 と runtime:14–25。factory 経由であることを保持する |
| runtime → rvw-service                    | 依存を渡して生成する   | runtime:21–25                                                                   |
| main → rvw-service                       | PR を取得する          | main:481–486                                                                    |
| start-server → viewer-lifecycle          | 生成し予約を操作する   | start-server:36–53,78–107                                                       |
| start-server → app                       | lifecycle を渡す       | start-server:54–58                                                              |
| app → viewer-lifecycle                   | 接続・終了を記録する   | app:159–174                                                                     |
| main → constants                         | URL 名を使う           | main:485–487                                                                    |
| viewer-session → constants               | URL とヘッダー名を使う | viewer-session:9–27                                                             |
| app → constants                          | ヘッダー名を読む       | app:159–166                                                                     |
| App → viewer-session                     | ヘッダーを取得する     | App:47–57                                                                       |
| viewer-lifecycle.test → viewer-lifecycle | 予約期限を検査する     | test:139–159                                                                    |
| viewer-lifecycle.test → main             | 呼び出し順を検査する   | test:416–479,513–564                                                            |
| agent-socket.test → main                 | 再取得を検査する       | test:657–693                                                                    |
| agent-socket.test → agent-socket         | 実 socket を作る       | test:663,670–685                                                                |

この範囲のファイルは上記の関係を方向無視でたどれる一つの集合になる候補。main の他の CLI コマンドは Node の説明へ混ぜない。図の提示は main から socket と HTTP/lifecycle へ伸びる関係を初期の注目候補とする。順序を表す backbone は要求しない。必要なら「新規プロセスの取得」と「URL からブラウザー接続」というまとまりを検討してよいが、正確な Node 所属は producer が決め、無理な Region を作らない。

**除外と直接読解。** `CHANGELOG.md` と更新された 4 文書はソースと照合済みの仕様・説明として直接読む。実装位置を増やす別領域ではないので Node にしない。GitHub/Git の詳細な取得、SQLite migration、PR 描画、コメント、他の Agent 操作、一般の transport fallback はこの map の外。`App.tsx` の HTTP 呼び出しは `api` helper 経由であるため、App → app の直接関係を捏造しない。必要な helper の処理は `src/web/api.ts:43–60` を直接読む。主要な追加領域の見落としを、changed-file 一覧で埋めない。

## 直接コードで残す確認

- port の衝突は `src/cli/main.ts:469–480`、database 不一致は同:621–627。短いガードで、別 Artifact の導入より条件とエラーをそのまま読む方が速い。
- `--foreground` と `--no-open` は同:640–699,888–913,504–572。通常自動 open と違う条件を自分で選んで確認する入口とし、両 Walkthrough に全経路を追加しない。
- timer が遅く発火した場合は `src/server/viewer-lifecycle.ts:132–148`。startup の残り時間の扱いを調べたい場合の局所入口。
- PR 取得が例外で終わる条件は `src/application/rvw-service.ts:556–620`。予約を解除する動作は最初の Walkthrough 内で説明し、Git/GitHub の全失敗原因はそこで列挙しない。

制作時は最初の Walkthrough の検証結果を先に受け取り、残りの brief の用語・重複・境界を再確認してから次へ渡す。マップは前提学習でも制作順の指定でもない。現時点ではすべて未公開で URI はない。コードの根拠はこの commit のソースにあり、推薦順に従うことをレビュー完了とは扱わない。
