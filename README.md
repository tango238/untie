# Untie

Untie は、現場担当者が自分の業務を言語化するための業務可視化ツールです。人・作業・情報・ルール・判断をカードにし、図の上で関係を整理します。将来は RDRA モデルに展開して要件定義につなげることを目指しています。

このリポジトリは PoC (概念実証) です。「カードと図で業務要素と関係を編集する体験」を確かめるものです。モデルは JSON ファイルに保存・読み込みできます (「開く」「保存」、Cmd/Ctrl+O・Cmd/Ctrl+S)。起動すると架空の宿泊施設のサンプルが開きます。

![アイコン](assets/icon.svg)

## できること

- 14 種の要素を扱う: アクター / 外部アクター / システム / 帳票 / 業務 / 活動 (BUC) / 作業 (アクティビティ) / 操作 (ユースケース) / コンテキスト / 情報 / 状態 / バリエーション / 条件 / 課題
- **固定ボード** (レイヤーごとに 10 枚): 上位の要素を枠にして下位の要素を自動で並べ、上から順に詳細化する。例: 作業のボードでは活動ごとの枠に作業を足していく。名前で絞り込める。要素の作成・削除、所属と関係の変更はここで行う
- **自由ボード** (いくつでも): レイヤーに関係なく要素を置き、位置と大きさを自由に決める。所属や関係は変えられない (表示だけ)
- 関係は RDRA に沿った型付き。両端の種類から関係が自動で決まり、あり得ない組み合わせは結べない。アクターの担当は線ではなく業務・作業のラベルで出す
- 課題を業務 / 作業 / 操作に紐づけ、重要度順に一覧する
- Undo / Redo (Cmd/Ctrl+Z、Shift+Cmd/Ctrl+Z)

設計の詳細は [docs/design.md](docs/design.md)、データモデルは [schema/untie.schema.json](schema/untie.schema.json) を参照してください。

## インストールと開き方

[Releases](https://github.com/tango238/untie/releases) から、お使いの OS 向けのファイルをダウンロードしてください。アプリは署名していないため、初回起動時に OS の警告が出ます。

### Mac (Apple Silicon)

1. `.dmg` を開き、Untie.app をアプリケーションフォルダにコピーします。
2. Finder で Untie.app を **右クリック (または control キーを押しながらクリック) → 「開く」** を選びます。
3. 「開発元を確認できません」の警告が出たら、もう一度「開く」を押します。2 回目以降は普通にダブルクリックで起動できます。

それでも開けない場合は、ターミナルで次を実行してから開いてください。

```sh
xattr -dr com.apple.quarantine /Applications/Untie.app
```

Intel Mac は対象外です。

### Windows (x64)

1. `.msi` または `-setup.exe` をダウンロードして実行します。
2. SmartScreen の「Windows によって PC が保護されました」が出たら、**「詳細情報」→「実行」** を押します。

## 開発

必要なもの: Node.js 22、pnpm 10、Rust (rustup の stable)。Tauri 2 の前提条件は [Tauri の公式ドキュメント](https://tauri.app/start/prerequisites/) を参照してください。

```sh
pnpm install
pnpm tauri dev      # アプリを起動して開発する
pnpm dev            # ブラウザだけで UI を開発する (http://localhost:1420)
pnpm typecheck      # 型検査
pnpm test           # テスト (Vitest)
pnpm check:types    # スキーマから生成した型が最新か確認する
pnpm tauri build    # Mac 用の .app / .dmg を作る
```

スキーマ (`schema/untie.schema.json`) を変えたら `pnpm gen:types` で `src/model/schema.d.ts` を再生成してください。

アイコンを変えるときは `assets/icon.svg` を編集し、`pnpm tauri icon assets/icon.svg` で各サイズを再生成します。

### リリース

`v*` のタグを push すると GitHub Actions が Mac (Apple Silicon) の `.dmg` と Windows (x64) の `.msi` / `.exe` を作り、GitHub Releases に添付します。Windows 版は CI でしか作れません。

```sh
git tag v0.1.0
git push origin v0.1.0
```

## このリポジトリで扱わないもの

AI による BUC 生成や対話ヒアリング、文章からの要素抽出、矛盾検出、rdra.yml エクスポート、コード署名は別の TODO で扱います。

## ライセンス

MIT
