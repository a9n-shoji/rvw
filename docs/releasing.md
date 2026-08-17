# npm release runbook

`@a9n-shoji/rvw`はpublic npm packageとして配布する。registryへの書き込みは、初回package作成時の
2FA付きbootstrapと、以後のGitHub Actions OIDC staged publishingだけに限定する。通常CIやlocal
developmentからpublishしない。

## Release invariants

- `package.json`、`src/shared/constants.ts`、Git tag、CHANGELOGのversionを一致させる。
- stable release tagは`v<major>.<minor>.<patch>`とし、prereleaseを`latest`へ公開しない。
- release commitは`main`へmerge済みで、tagはそのcommitを直接指す。
- release checkoutはcleanで、lockfileを変更せずinstallできる。
- `pnpm test:package`が検証した同一tarballだけをregistryへ送る。
- package versionとprotocol versionは独立させる。machine contractのbreaking change時だけprotocol
  versionを単調増加させ、CLI、bundled Skills、contract test、文書を同じreleaseで更新する。
- 公開済みversionは置換しない。問題は新しいpatchでforward-fixする。

## Account and repository setup

初回release前に次を確認する。

1. npmで`a9n-shoji` user scopeまたは同名organizationを管理できることを確認する。
2. maintainer accountで2FAを有効にする。
3. GitHub Private Vulnerability Reportingを有効にする。
4. GitHub Environment `npm-production`を作成し、required reviewerを設定する。
5. branch/tag protectionでrelease tagを作れる主体を制限する。
6. npm CLIで認証を確認する。

```bash
npm login
npm whoami --registry=https://registry.npmjs.org/
```

`npm view @a9n-shoji/rvw`の404はpackageが未作成という意味にすぎず、scopeの所有権を証明しない。
`npm whoami`の結果かorganization membershipを必ず確認する。

## Prepare a stable release

release PRでversionとCHANGELOGを更新する。0.xではcompatible bug fixをpatch、featureまたはbreaking
changeをminorとする。1.0.0以降はSemVerどおりbreaking changeをmajorとする。

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
pnpm build
pnpm test:package
```

PRをmerge後、remote `main`の確定commitへ説明付きtagを作成してpushする。maintainerの署名鍵を
別途設定した場合は`-a`を`-s`へ置き換えてよいが、release automationが一時鍵を生成してはならない。

```bash
git tag -a v0.1.0 -m "rvw v0.1.0"
git push origin v0.1.0
```

## Bootstrap the first package

npmは未作成packageへTrusted Publisherを設定できず、未作成packageをstageすることもできない。そのため
`0.1.0`だけはcleanなtag checkoutで2FA付きdirect publishを行う。この例外は長期tokenを作らず、以後は
再利用しない。

```bash
git switch --detach v0.1.0
pnpm install --frozen-lockfile
RVW_RELEASE_TAG=v0.1.0 pnpm release:verify
pnpm check
pnpm test
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
pnpm test:package -- --pack-destination .release
pnpm exec npm publish .release/*.tgz --access public
```

公開直後にregistryとglobal installを確認する。

```bash
npm view @a9n-shoji/rvw version dist-tags --json
npm install --global @a9n-shoji/rvw@0.1.0
rvw --version
rvw doctor
```

## Enable trusted staged publishing

初回公開後、npm websiteまたは次のCLIでGitHub ActionsをTrusted Publisherへ登録する。workflow fileは
basenameだけを指定し、権限はstage-onlyにする。

```bash
pnpm exec npm trust github @a9n-shoji/rvw \
  --repo a9n-shoji/rvw \
  --file publish.yml \
  --env npm-production \
  --allow-stage-publish
```

npm package SettingsのPublishing accessを`Require two-factor authentication and disallow tokens`へ
変更する。使用していないpublish tokenがあれば削除する。Trusted Publisherのrepository、workflow名、
environment、permissionも確認する。

## Publish subsequent releases

1. release PRをmergeしてstable version tagをpushする。
2. GitHub Actionsの`Stage npm package`を開き、`release_tag`へtag名を入力して実行する。
3. `npm-production` Environmentの実行を承認する。
4. workflowが検証したtarballをstaging areaへ送るまで待つ。
5. staged metadataとtarballを確認し、2FAでapproveする。

```bash
pnpm exec npm stage list @a9n-shoji/rvw
pnpm exec npm stage view <stage-id>
pnpm exec npm stage download <stage-id>
pnpm exec npm stage approve <stage-id>
```

承認後に`npm view`、fresh global install、`rvw doctor`を実行し、同じtagでGitHub Releaseを作成する。

## User upgrades and bundled Skills

```bash
npm install --global @a9n-shoji/rvw@latest
rvw doctor
rvw skill status
```

Skillに差異がある場合は`updateAvailable`、`locallyModified`、`unmanaged-difference`を確認する。
`--force`はlocal customizationを上書きするため、内容を確認した利用者だけが実行する。

## Failed releases and incidents

公開済みversionをunpublishして同じversionを再利用しない。通常は修正版を新しいpatchとして公開し、
問題versionをdeprecateする。

```bash
npm deprecate @a9n-shoji/rvw@0.1.1 "0.1.2へ更新してください"
npm dist-tag add @a9n-shoji/rvw@0.1.2 latest
```

SQLite migration後のdata directoryを古いbinaryが読める保証はないため、`latest`だけを古いversionへ戻す
rollbackは行わない。credential漏洩、malware、機密情報混入時はpublishを止め、npm/GitHub credentialと
Trusted Publisherを監査し、必要な場合だけnpmのunpublish policyとsecurity responseに従う。
