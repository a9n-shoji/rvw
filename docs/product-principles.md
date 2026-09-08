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

Walkthroughは、順序とprose自体がartifactである意図的な読解pathである。具体的な状況や問いと最初の
code入口から始め、小さな説明または図を得てsourceで確かめ、局所的なmental modelを更新し、次に確認する
問いへ進む。複数の主体、状態、条件、順序、分岐を文章だけから再構成させる場合は、Mermaidを標準的な
説明手段としてその必要地点へ置く。flowchartは分岐、state diagramはstateとtransition、sequence diagramは
主体間interactionと時間順というように、図法は答える問いから選ぶ。図もAgentのclaimであり、矢印、状態、
順序をsourceより整ったモデルへ美化しない。小さな局所変更では図を作らない判断も同じく正当である。

Structureは、PRに関係するboundedなbehaviorまたはreview questionを、stableな全体像とfocus-relativeな
局所lensの間で往復できるspatial explanationである。通常Structureはfactualなcode entrypointから依存、
contract、side effectへ辿る。PR全体のdefault compositionはこれとは別に、実在fileを1 Nodeずつ表し、
その変更を理解するためのfile responsibilityとsource-verifiableなfile間dependencyを示すStructureを必ず持つ。
このファイル地図は変更file一覧でもrepository全体のarchitecture inventoryでもなく、codeを読んだ途中で
「いまの責務はどこに位置するか」へ戻るための土台である。最初に暗記するoverviewでも、mandatoryな
reading orderでもない。Agentはsubject、scope、roleに応じたorigin、stableなNode / Edge ID、exact source
anchorに加え、必要ならthesis、authorial start、optionalなconnected exact-Edge primary backbone、stable IDと
責務summaryを持つcomprehension regionをauthorial semanticsとして提示できる。
これは座標、importance layer、一本道のstepperではない。座標、focus hop、navigation history、pan、zoom、manual
positionは人間の一時的なreading stateに留める。表示範囲を1-hop / 2-hopへ明示的に絞ることはでき、Homeは
authorial start（nullならorigin）のexact 1-hopへ戻る。complete extentはminimap / All / Fitで回収できる。高次数になるsubjectはscopeを分ける。PRで検証するbehaviorに接地しない
静的なarchitecture／責務inventoryは扱わない。PR-scopedなファイル地図だけが、この一般的なinventory拒否の
限定されたauthoring用途である。Structureも独自の履歴やsemantic truthを持たず、claimを
検証する正本はGitである。

Structureはneutralなgraph viewerではなく、Walkthroughやcode readingで形成したmental modelを、変更された
behaviorを成立させる責務とrelationへ位置付け直すreading surfaceである。factual graph、authorial presentation、
derived rendering、ephemeral reviewer sessionを混ぜない。presentationがあればviewerはauthorial start、optionalな
2〜12 Node / 1〜16 Edgeのconnected exact-relation backbone、stableなcomprehension regionをGuide cue、
canonical map、Graph / Regions modeへ反映する。backboneまたはregionがspatial organizerとして存在する場合だけbase mapへ
反映し、start-only presentationと`null`はfactsとentrypointから同じtopology projectionを作る。start-onlyでも
意味のあるthesis、attention start、新規sessionのfocus、exportは失わない。
regionはstable ID、label、thesisへの寄与を述べる責務summary、明示Node membershipを持つnamed comprehension
chunkである。Region arrayにも各`nodeIds`にも順序の意味はなく、stable IDでcanonical化する。membershipは
full label / responsibilityを持つRegions overviewと、Graph上のnamed Region lensによるexact member強調で示し、
stable ID由来の略称を復号させたり、人間が動かしたNodeを囲うgeometryから推測させたりしない。Region間connectionはmember間の
direct factual Edgeから導出し、別のauthorial relation graphを持たない。unassigned Nodeもfirst-classに残す。
primary backboneはこの説明で先に掴む一つのconnectedなexact-relation coreを表し、path、fan-out、convergence、
reciprocal relationを一本道へ歪めない。array順、runtime順、Edge方向、project全体でのarchitectural importance、
completeness、review conclusionは主張しない。長いbackboneはderivedなdistance bandを保ったまま決定的な複数行へ
折り返してよい。そのrowやlayerはauthorが与える意味論ではなく、全体像を読める面へ収めるrenderer detailである。
人間は同じ空間をHome、局所focus、Region、exact source、再俯瞰の間で
往復し、全Node / Edgeとsourceを自由に検証できる。backbone membershipという固定されたauthorial salience、focusからの
hop数、frame中のregionという一時的なreviewer attentionは別のvisual channelで表す。Region frameはmembershipやfocus距離を
書き換えず、そのchunkのmemberと内部relationを読む間だけfull relevanceにする。filterで配置を組み替えず、Home / Back / Allへ
戻ることで局所で確かめたことを同じ全体像へ位置付け直す。全体を自動で一画面へ詰め込まず、読めないscaleでは
secondary detailを省略しても、その存在、件数、inspect方法を隠さない。viewer由来のgeometry、route、semantic zoom、
人間のmanual layout geometryとreviewer sessionはStructureのclaimではない。
Regions overviewはcanonical card geometryをpane幅へ合わせてcompact化しない。初期camera / ResetはStartを含む
責務を読めるscaleへ置き、Fitは全体extentをframeする。独立したzoom / panで両者を往復し、このcameraもGraph viewportとは別の一時的reviewer stateとする。
derived routeはartifact semanticsではないが、relationのsource / targetへvisible boundary portで接続し、distinctな
visible relationが実質的な区間で同一またはほぼ同一のcorridorを通る場合は別laneとして追跡可能にする。parallel /
reciprocal relationは必ずこの対象に含む。normal detailのrelation labelはNodeにも相互にも重ねず、inline配置が
成立しなければleader付きの退避位置を使う。

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
