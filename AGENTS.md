# AGENTS.md

このリポジトリで作業するエージェント (Claude Code など) と開発者のための約束です。詳しい設計は [docs/design.md](docs/design.md) と [docs/collab-design.md](docs/collab-design.md)、使い方とコマンドは [README.md](README.md) にあります。ここには、守らないと壊れるもの・忘れやすいものだけを書きます。

## 構成

pnpm ワークスペース (モノレポ) です。ビルドはせず、Vite・Vitest・Worker が各パッケージの TypeScript を直接読みます。

| 場所 | 役割 |
| --- | --- |
| `schema/untie.schema.json` | モデル (保存する JSON) の JSON Schema。型と検証関数はここから生成する |
| `packages/core` | モデル (型・コマンド・検証・マイグレーション)、サンプル。React にも DOM にも依存しない |
| `packages/api` | サーバーと画面で共有する契約 |
| `packages/collab` | 同時編集 (Y.Doc とモデルの往復、ルームの Durable Object) |
| `packages/ui` | React の画面とストア。Web 版・クラウド版・デスクトップで共通 |
| `apps/web` | Web 版 (ローカル専用)。Cloudflare Pages で配る |
| `apps/cloud` + `apps/server` | クラウド版の画面とサーバー (Cloudflare Worker) |
| `apps/desktop` | デスクトップアプリ (Tauri 2) |

## 変更したら通すもの

```sh
pnpm typecheck     # 型検査 (全パッケージ)
pnpm test          # テスト (全パッケージ)
pnpm check:types   # スキーマから生成した型・検証関数が最新か
pnpm build         # Web 版・クラウド版・デスクトップのフロントの build と、Worker の dry-run
```

CI (`.github/workflows/ci.yml`) も同じものを走らせます。

## JSON Schema を変えるときは、必ずモデルの形式のバージョンを上げる

保存する JSON は `version` にモデルの形式のバージョン (semver の文字列。現行は `0.3.0`) を持ちます。ファイルを開く・取り込むときは `loadModelJson()` (`packages/core/src/model/migrate.ts`) が、古い版の JSON をマイグレーションで現行の版へ自動で変換してから検証します。新しい版の JSON は、古いアプリで開いて壊さないよう断ります。

そのため、`schema/untie.schema.json` を変えるとき (項目を足す・消す・名前や型を変える・必須にする・値の範囲を変える、など保存する JSON の形が変わるすべての変更) は、**必ず**次をまとめて 1 つの変更で行ってください。説明 (`description`) だけを直すときは不要です。

1. **バージョンを上げる**: `packages/core/src/model/types.ts` の `MODEL_VERSION` と、スキーマの `version` の `const` を同じ新しい値にする。互換を壊す変更 (古いアプリで読めなくなる) は minor 以上、足すだけの変更も patch 以上を上げる。
2. **マイグレーションを足す**: `packages/core/src/model/migrate.ts` の `MIGRATIONS` に `{ from: 前の版, to: 新しい版, migrate }` を 1 つ足す。`migrate` は前の版の JSON を新しい版の形へ直す (受け取ったものは書き換えず、新しいオブジェクトを返す)。形が変わらなくても、版をつなぐために空の変換 (`(json) => json`) を足す。
3. **型と検証関数を作り直す**: `pnpm gen:types` (`schema.d.ts` と `schemaValidator.gen.js` が変わる)。
4. **テストを足す**: `packages/core/src/model/__tests__/migrate.test.ts` に、前の版の JSON が変換されて `validateModel` に通ること (と、変換で中身がどう変わるか) を足す。
5. **作るところを合わせる**: サンプル (`packages/core/src/sample/`)・`emptyModel`・Y.Doc からの組み立て (`packages/collab/src/doc/rebuild.ts`) は `MODEL_VERSION` を使っているので、新しい形に合わせて中身を直す。
6. **書く**: `docs/design.md` の 4 章 (データモデル) と、変わった項目の説明を直す。

すでに出した版の `MIGRATIONS` は書き換えず、足していきます (古いファイルを持っている人がいるため)。

## サンプルを足す・直すとき

- サンプルは `packages/core/src/sample/` に置き、ホームの一覧は `SAMPLES` (`index.ts`) に足す。会社名・数・データはすべて架空にする。
- 1 つの業務に結ぶアクターは主担当の 1 人にする (複数いると検証が警告を出す)。ほかの人は作業の担当として作業に結ぶ。
- システムは作業の担当にしない。操作の対象 (操作 → システム・帳票) にするか、画面を通して結ぶ。1 つの操作の対象は、システム・帳票・画面のどれか 1 つだけ。人が担当しない処理は作業にせず、イベントをきっかけにした操作にする。
- サンプルのテストで、検証 (`traceToActors`) のエラーが空で、警告 (`traceWarnings`) のうち業務の主担当の警告が空であることを確かめる。イベントで終わらない連鎖の警告 (`chainEnd`) は、見本のサンプル (ネットショップ) だけ空にし、ほかのサンプルでは残してよい。

## 書き方

- 画面の文言・コメント・ドキュメント・コミットメッセージは日本語で書く。コミットメッセージは「〜する」で終える。
- 振る舞いを変えたら、テストと `docs/` の該当箇所も同じ変更で直す。
