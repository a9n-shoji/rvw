# Product principles

`rvw`は、AIか人間かに関係なく、実装されたcodeを人間が理解するためのreading interfaceである。
レビュー対象はdiff単体ではない。Pull Requestの意図、commitの並び、それらが作ったrepository
snapshotを合わせた、結果として存在するsoftwareである。Agentとの協業はその理解から次の行動へ
つなぐ一つの経路であって、code reading自体をAI sessionへ従属させない。

## 解く問題

Coding Agentは、人間が影響を再構成するより速く、もっともらしいdiffを生成できる。変更行だけを
読んでも、結果の振る舞いが周辺architecture、caller、test、設定、documentと整合するかは分からない。
diffは編集箇所を見つけるには有効だが、変更後のsoftwareを理解する範囲としては狭すぎる。

`rvw`は、Agentへ次の行動を依頼する前に、人間がその結果を安定した状態で読む場所を提供する。

## Review loop

```text
Agentが実装
    ↓
Git commit / GitHub Pull Request
    ↓
Agentが任意で実装Walkthrough / Structureを提示
    ↓
rvwで意図・説明・変更・結果のrepositoryを読む
    ↓
人間がcontextを辿り、理解し、コメントする
    ↓
Skill + CLI protocol
    ↓
Agentが次の実装へ反映
```

人間は最終的な理解と判断を担い、Agentはauthorizedな実装作業に加え、明示的に依頼されたreviewで見つけた
指摘を通常のcommentとして記録できる。`rvw`はAgent runtimeになることなく、両者の間のreview contextを保持する。

## 原則

### Patchだけでなく、結果のsoftwareを読む

選択commit時点のrepositoryを主要なreading surfaceとする。変更fileは読み始める場所を示す。
全文、変更されていないfile、検索結果、PR本文、関連するopen tabが、振る舞いと影響を理解するための
contextを提供する。

### Diffを境界ではなくlensとして扱う

diffは二つのcommit間で何のtextが変わったかを答えるが、どのcodeがreviewに関係するかは決めない。
利用者は変更行から任意のrepository fileへ移動し、全文を読み、選択範囲で変更されていないfileにも
コメントできる。

### Review historyを発明せず、Git historyを使う

commitと連続commit rangeが実装の変化を記述する。`rvw`は二つ目のcaptureやversion modelを追加しない。
exact commit objectを保持し、current PR historyが変わった後も古いcomment sourceを読めるようにする。

### 人間の判断をdurableかつAgent非依存に保つ

Commentは特定modelやsessionへ結び付いたchat messageではなくreview recordである。stableなcomment
参照、platform非依存の同じSkill、JSON CLI protocolにより、CodexとClaude Codeは同じfeedbackを作成し、
読み、返信し、解決できる。Agent作成commentも人間のcommentと同じ未解決／解決済みthreadであり、
別のAI session stateを作らない。
viewerはAgentを起動せず、codeを編集せず、testを実行せず、actionをautonomous loopへ隠さない。

### Agentの説明と関係mapはnavigation命令ではなく、検証可能なindexにする

Agentが実装やarchitectureを説明する場合、成立を保証するsource anchor付きcode referenceとdiagramを提示できる。
ただしAgentはbrowser、active tab、scroll位置を操作しない。どのclaimをいつ確認するかは人間が選び、
説明tabを残したまま最新HEAD上の対応codeを開き、確実に追跡できない場合だけ明示されたanchor sourceへ戻る。
必要なら人間が二ペインへ並べ、説明とcodeやcallerとdefinitionを
同時に読む。pane配置も開くタイミングもbrowser内の人間の状態であり、Agentへは渡さない。説明は理解の
入口であり、正本はcommit済みcodeである。説明へのfeedbackはstable Walkthrough IDへ結び付け、
必要ならparser由来のMarkdown source line rangeとexact quoteを持つ。DOMや生成SVGのrender位置は
正本にしない。Agentが読むときは現在の本文とcode reference、rvwが導出した配置も同時に渡す。説明は同じIDの
まま改善できるが、独自の版履歴は作らない。不要になった説明とそこだけに属するfeedbackは、明示確認後に
削除できる。

Walkthroughは、人間がmental modelを組み立てるための意図的なpathである。Structureは、boundedな
code-centered subjectのnodeとrelationを任意の方向へ辿るspaceである。Agentはsubjectとscopeを宣言し、
stableなNode / Edge IDとexact source anchorを提示するが、layout、focus、pan、zoom、開く順序は人間の
一時的なreading stateに留める。高次数relationの折りたたみは意味的な重要度を推測せず、stable Edge ID
だけで決めて可逆にする。Structureも独自の履歴やsemantic truthを持たず、claimを検証する正本はGitである。

### 実装が変わってもorientationを保つ

open document、repository path、commit選択、comment anchor、Outdated表示により、人間はreviewを
記憶から再構築せずに次の結果と比較できる。exactな配置を安全に決められなくなってもcommentを残し、
対応関係を失ったことを明示する。

### 理解したように見せず、限界を明示する

Phase 1はGit object、全文検索、全文表示、保守的なline mappingを使う。LSP、code graph、semantic
search、built-in AIによるsemanticな理解を主張しない。未対応documentと曖昧なmappingは、近似して
隠さず明示する。

## Product boundary

`rvw`はIDE、AI chat、autonomous reviewerではなく、forgeの置き換えでもない。共有Pull Requestは
GitHubが持ち、code historyの正本はGit commitが持つ。`rvw`はローカルで人間が読むexperienceと、
local Agentへ渡すstructured review feedbackを担う。

この境界は意図的である。`rvw`の価値は、人間が次に何をすべきか判断できるまでsoftwareを理解する
ことを助ける点にある。
