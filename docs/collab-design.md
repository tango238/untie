# Untie クラウド版 (ユーザー・ファイル・権限・同時編集) 設計書

ログインしたユーザーがクラウドにファイルを置き、他のユーザーと共有し、同時に編集できるようにする。あわせて、デスクトップ (Tauri)・Web・共通部分・サーバーをディレクトリで分けて管理する。本文書は [docs/design.md](design.md) の続きで、そこに書いてあることは繰り返さない。12 章の 7 段階はすべて実装済みで、本文はその実装に合わせてある (コードと食い違う記述があればコードが正本)。

## 1. 決めたこと

| 項目 | 決定 |
| --- | --- |
| ファイルの置き場所 | **ローカルファイル** (従来どおりの JSON。ログイン不要) と **クラウドファイル** (サーバーに置く。ログインが要る) の 2 種類。クラウドファイルは常に同時編集できる (1 人でも同じ経路) |
| ユーザー | メールアドレスで識別する。パスワードは持たず、Google でログインする (OIDC)。他のプロバイダーは同じ形で後から足せる |
| セッション | サーバーが発行する不透明なトークン (D1 には SHA-256 だけ置く)。Web は HttpOnly Cookie (SameSite=Lax、状態を変える API には `X-Requested-With` も要る)、デスクトップは OS のキーチェーンに置いて `Authorization: Bearer` で送る (7.2) |
| 権限 | ファイルごとに `owner` / `editor` / `viewer` の 3 役。権限の判定はサーバーで行い、UI は同じ規則で見せ方を変えるだけ |
| 共有 | 所有者がメールアドレスで招待する (editor / viewer)。加えて、所有者が有効にすれば**リンクを知っている人は誰でも閲覧**できる (ログイン不要。3.6) |
| 同期の方式 | Yjs (CRDT)。ルームは `y-partyserver` の `YServer` を継承した Durable Object。1 クラウドファイル = 1 Durable Object |
| 正本 | ローカルファイルは従来のストア (変えていない)。クラウドファイルはルームの Durable Object の Y.Doc で、ストアの `model` はそこから組み立てる |
| 一覧と権限の置き場所 | D1 (SQLite)。ユーザー・セッション・ファイルの一覧・メンバー・招待・リンク。ファイルの中身は Durable Object のストレージ |
| 置き場所の地域 | 日本に寄せる。D1 は `--location apac` で作り、Durable Object は `locationHint: "apac"` で作る (3.7) |
| ファイルの寿命 | 使われないファイルを自動では消さない。消すのは所有者だけ (ゴミ箱に 30 日置いてから完全に消す) |
| 編集 API | 既存の `commands.ts` (純粋関数) をそのまま使う。コマンドの結果と直前のモデルの差分を Y.Doc に書く |
| 保存形式 | JSON ファイルの形式 (`schema/untie.schema.json`、`version: 1`) は変えない。クラウドファイルは同じ JSON に書き出せる |
| 衝突 | 項目ごとに後勝ち (Yjs の Y.Map)。名前と説明は文字単位では合流しない |
| Undo / Redo | クラウドファイルでは使えない。ローカルファイルでは従来のスナップショットの履歴をそのまま使う |
| 参照整合性 | 合流後に壊れた参照 (消えた要素を指す関係など) をサーバーが直す (`repairModel`)。スキーマの文字数の上限を超えた文字列は、要素を外さず切り詰める (6 章) |
| 文字数の上限 | スキーマの `maxLength` (名前 200・説明 4000・状態グループ 200・バリエーションの値 200・分析の各項目 4000・リンクの表示名 200 / URL 2000) を、`packages/core/src/model/limits.ts` に定数で写す。すべてのコマンドが超える入力を `{ ok: false, reason: "名前は 200 文字までです" }` のように断り、入力欄には `maxLength` を付ける。超えたものが Y.Doc に入っても、`readModel` / `repairModel` が切り詰める (6 章) |
| モデルの大きさ | **モデルは 1 MB まで**。取り込み (`POST /files` の `{ model }`) の本文を 1 MB で断る (413 `too_large`)。Durable Object の 1 つの値の上限に備えるため。保存の書き込みが失敗したら `save_failed` で知らせる (7.5) |
| 配信 | クラウド版は、1 つの Cloudflare Worker (`untie-cloud`) がクラウド版の画面 (`apps/cloud`) の静的ファイル・API・Durable Object を持つ。デスクトップ版も同じ Worker につなぐ。ローカル専用の Web 版 (`apps/web`) は別に Cloudflare Pages で配り、サーバーにはつながない (2.3) |
| 登録 | Google のアカウントがあれば誰でもログインできる。ドメインでは絞らない (共有されなければ何も見えない)。絞りたくなったときのために `ALLOWED_EMAIL_DOMAINS` の判定だけ入れてある (空なら制限なし) |
| デスクトップのログイン | 既定のブラウザで Google にログインし、`untie://` の deep link でアプリに戻る。セッションの受け渡しは**引換コード** (5 分・1 回限り。トークンは入れず、AES-GCM で暗号化) と **PKCE** (`code_verifier`) で守る。deep link が開けない環境では、ブラウザの画面に出たコードをアプリに貼る (7.3) |
| トークンの渡し方 | セッションは Cookie か `Authorization` ヘッダー。リンク閲覧・招待のトークンはパスではなく**ヘッダー `X-Untie-Token`** で送る (パスは Workers のログに残るため。7.4)。ルームへの接続は 60 秒だけ有効で**1 回しか使えない**署名付きの**チケット** (7.5) |
| CORS | デスクトップの WebView のオリジン (`tauri://localhost`、`http://tauri.localhost`。`tauri dev` の `http://localhost:1420` は `DEV_LOGIN=true` のときだけ) にだけ許す。credentials は許さない (7.2) |
| 未交換のセッション | デスクトップのログインでできた行は、引換コードを交換する (`activated_at` が入る) まで認証に通らない。交換されないまま 1 時間たった行は cron が消す (7.2) |
| 閲覧専用 | owner / editor 以外の接続からの update は、`y-partyserver` の `isReadOnly` で捨てる。選択 (awareness) は viewer と guest も送れる (7.5) |
| 権限の変更の反映 | **役割が実際に変わったとき**・メンバーを外す・リンクの無効化・ゴミ箱では、Worker がルームの `kick` で接続を閉じる (同じ役割への PUT・招待し直しでは閉じない)。ログアウトも同じ仕組みで、そのセッション (`sid`) またはそのユーザーの接続を閉じる (7.2)。kick は記録して、60 秒使えるチケットでのつなぎ直しも防ぐ (7.5) |
| 保存できないとき | `onSave` が検証に通らない・書き込みに失敗したら、ルームが `save_failed` を全員に流し (あとから入った人にも)、画面は帯「サーバーに保存できていません。JSON に書き出して保存してください」を出す。保存できたら `save_ok` で消す (7.5、8.3) |
| 過去の状態 | 1 時間ごとのスナップショット (3.4) を、owner が共有ダイアログの「過去の状態」から JSON に書き出せる (`GET /files/:id/snapshots` と `…/snapshots/:key`。7.4) |
| 公開のホスト | `APP_ORIGIN` を設定したとき、それ以外のホスト (workers.dev など) への GET は `APP_ORIGIN` の同じパスへ 302 する (`/parties`・`/api/links/*`・`/auth/desktop/exchange` とデスクトップアプリからの呼び出しを除く)。Cookie とログインを 1 つのホストに揃える (7.1、9 章) |
| プレゼンス | awareness (選択・開いているボード・名前・色)。自己申告は偽れるので、画面はサーバーの `presence()` と照らして表示する。権限には使わない (8.3) |
| 保存していない変更 | クラウドファイルは、つながっている間は「未保存」が無い。つながっていない間に溜めた変更だけを、閉じる前の確認の対象にする (5 章、8.3) |
| 自動で消すもの | 期限切れのセッション、交換されないままのデスクトップのセッション、期限が切れて 30 日たった未承諾の招待と受けて 30 日たった招待の行、ゴミ箱に入って 30 日を過ぎたファイルだけ。毎日 03:00 (UTC) の cron (3.4、7.2) |

### 1.1 方式の比較 (同期)

| | Yjs + y-partyserver (採用) | コマンド中継 (サーバーが `commands.ts` を順に適用して配る) |
| --- | --- | --- |
| 合流 | 項目ごとに自動 | サーバーで直列化。楽観的に当てたコマンドの巻き戻し・再適用を自分で作る |
| 再接続・オフライン | ライブラリが持つ | 自分で作る |
| プレゼンス (誰がどこを見ているか) | awareness が持つ | 自分で作る |
| 参照整合性 | 合流後に直す処理が要る | サーバーで常に保てる |
| 閲覧専用 | 受け取った update を捨てる処理を足す | コマンドを拒むだけ |
| 既存コードへの影響 | ストアにクラウド用の経路を足す | コマンドを関数から「名前 + payload」のデータに変える |

### 1.2 方式の比較 (ログイン)

| | 外部 ID プロバイダー (OIDC、採用) | Cloudflare Access | メールのリンク (magic link) | パスワード |
| --- | --- | --- | --- | --- |
| 利用者 | Google / Microsoft のアカウントを持つ人 | 管理者が Access に登録した組織 | メールが届く人なら誰でも | 誰でも |
| デスクトップ | 既定のブラウザでログインして戻る (7.3) | Access の画面を経由する経路を自作する | 同左 | 画面から直接 |
| サーバーの実装 | OIDC のやり取りとセッション | Access の JWT を読むだけ | メール送信サービスが要る | ハッシュ・再設定・漏えい対策が要る |
| ユーザーの一覧・権限 | 自前 (D1) | 自前 (D1)。Access は認証だけ | 自前 (D1) | 自前 (D1) |

まず Google だけで始める。パスワードは持たない (漏えい対策を背負わない)。Cloudflare Access は Worker の前にさらに置けるが、ログイン自体の仕組みにはしない。Microsoft Entra ID と magic link (メール送信サービスが要る) は、同じ `IdentityProvider` の形で後から足す (12 章の「あとで」)。開発用の `dev` プロバイダー (メールを打つだけ。ローカルのホストだけ) は同じ形で実装してあり、Google の設定なしに手元で試せる (7.6)。

## 2. ディレクトリ構成 (pnpm ワークスペース)

```
untie/
├ packages/
│  ├ core/        @untie/core    … モデル (型・スキーマ・id・関係ルール・コマンド・検証・固定ボード・分析・トレース)、サンプル
│  │                               DOM にも React にも依存しない。サーバーもここを使う
│  ├ api/         @untie/api     … サーバーと画面で共有する契約。DTO の型、役割と権限の規則 (`can(role, action)`)、
│  │                               URL の形、fetch のクライアント (`UntieApi`)。zod でリクエストを検証する
│  ├ collab/      @untie/collab  … 同時編集のうち DOM に依存しない部分。core と api にだけ依存する
│  │  ├ src/doc/                  … Y.Doc ⇄ UntieModel の橋渡し (`loadModel`・`readModel`・`rebuildModel`・`applyModelDiff`・`observeModelChanges`)、`repairDoc`、順序キー
│  │  └ src/room/                 … `UntieRoom` (YServer を継承した Durable Object)、接続の状態 (`ConnectionState`)、閲覧専用の扱い、永続化、D1 への反映、kick。`@untie/collab/room` として別に取り込む
│  └ ui/          @untie/ui      … React の画面と zustand ストア、io (ローカルファイル)、ai、cloud (API クライアントの束・セッション・ファイル一覧・ルームへの接続とプレゼンス)。Web とデスクトップで共通
│                                   プラットフォーム依存の処理は `Platform` インターフェースで受け取る (2.1)
├ apps/
│  ├ server/                      … Cloudflare Worker。Hono のルート (`auth/`、`api/` の files・members・invitations・links)、D1 (`db/`、`migrations/`)、
│  │                                 cron (`jobs/purgeTrash.ts`)、UntieRoom のマウント、`apps/cloud/dist` の静的配信。wrangler.jsonc はここ
│  ├ cloud/                       … クラウド版の画面の Vite のエントリ。web の Platform を `cloud: true` で使う。ビルド結果を server が配信する
│  ├ web/                         … Web 版 (ローカル専用) の Vite のエントリと、Platform のブラウザ実装 (cloud と共用)。Cloudflare Pages で配る
│  └ desktop/                     … Vite のエントリ + src-tauri (Rust)。Platform の Tauri 実装 (キーチェーン・deep link)
├ schema/untie.schema.json        … 変えない (core が参照)
├ docs/                           … design.md (元の設計)、collab-design.md (本文書)
└ pnpm-workspace.yaml, package.json (ルートは scripts と devDependencies だけ), tsconfig.base.json, tsconfig.json, vitest.config.ts
```

共通部分は `core`・`api`・`ui` の 3 つに分けた。サーバー (Worker) が core と api を取り込むので、そこに React や DOM が入っていると Worker のバンドルに引きずられる。画面は `ui` に置き、Web とデスクトップはどちらも `ui` を使う。

モノレポ化で、もとの `src/` から次のように移した:

| いま | 移動先 |
| --- | --- |
| `src/model/`、`src/sample/` | `packages/core/src/` |
| `src/components/`、`src/store/`、`src/ai/`、`src/io/`、`src/styles/`、`src/App.tsx` | `packages/ui/src/` |
| `src/io/file.ts`・`recent.ts`・`useCloseGuard.ts`・`ai/keys.ts` の `isTauri()` 分岐 | `apps/web/src/platform.ts` と `apps/desktop/src/platform.ts` に分割 |
| `src/main.tsx`、`index.html`、`vite.config.ts` | `apps/web/` と `apps/desktop/` にそれぞれ |
| `src-tauri/` | `apps/desktop/src-tauri/` |
| `public/_headers` | Web 版は `apps/web/public/_headers` (Pages が付ける)、クラウド版は `apps/server/public/_headers` (`copy-headers.mjs` が配信前に `apps/cloud/dist/` へ写す) |
| `scripts/gen-validator.mjs`、`gen:types` | `packages/core/` の scripts |

### 2.1 Platform インターフェース (ui が受け取る)

```ts
export interface Platform {
  kind: "web" | "desktop";
  openTextFile(): Promise<OpenedFile | null>;
  saveTextFile(text: string, path: string | null, suggestedName: string): Promise<SavedFile | null>;
  /** ファイルを開き直せるか (Web は File System Access API のあるブラウザだけ。最近開いたファイルの可否に使う) */
  canReopenFiles(): boolean;
  confirmDiscard(message: string, okLabel?: string): Promise<boolean>;
  openExternalUrl(url: string): Promise<void>;
  /** 閉じる前の確認。Web の beforeunload は同期でしか止められないので、確認ではなく「変更があるか」を渡す。戻り値で登録を外す */
  onCloseRequested(hasUnsavedChanges: () => boolean): () => void;
  secrets: {
    get(key: string): Promise<string | null>;
    /** remember は Web だけ: true ならこのブラウザ (localStorage) にも置き、false ならこのタブの間だけ覚える */
    set(key: string, value: string, options?: { remember?: boolean }): Promise<void>;
    delete(key: string): Promise<void>;
    /** ブラウザに保存しているか (デスクトップは常に false) */
    isRemembered(key: string): boolean;
  };
  recentFiles: RecentFileStore;
  /** サーバーの URL (Web は自分のオリジン、デスクトップは設定したもの)。空文字ならサーバー未設定で、クラウドの機能は使えない */
  serverOrigin(): string;
  /** ログイン。Web は同じタブで /auth/login へ移り、returnTo (`#/...` のハッシュ) の画面へ戻る。デスクトップは既定のブラウザを開いて deep link で戻る (7.3)。ProviderId は `@untie/api` の `"google" | "dev"` */
  login(provider: ProviderId, returnTo: string): Promise<void>;
  /** セッションの送り方。Web は Cookie (何もしない)、デスクトップはキーチェーンのトークンを Authorization に付ける */
  authorize(request: RequestInit): Promise<RequestInit>;
  /** 手元のセッションを消す (ログアウトのあとに呼ぶ)。Web は何もしない (Cookie はサーバーが消す)。デスクトップはキーチェーンの `session` を消す */
  clearSession(): Promise<void>;
  /** 以下はデスクトップだけ (Web は未定義)。サーバーの URL を変える (検めて保存し、`session` を消す)。不正な URL は Error */
  setServerOrigin?(url: string): Promise<void>;
  /** ブラウザのログインが deep link か引換コードで終わった知らせ。画面は戻り先へ移って `session.load()` する。失敗 (state の不一致・期限切れ) は `{ ok: false, message }` */
  onLoggedIn?(listener: (result: { ok: true } | { ok: false; message: string }) => void): () => void;
  /** 引換コード (または deep link の URL) を貼ってログインを終える。deep link が開けない環境向け。失敗は Error */
  completeLoginWithCode?(code: string): Promise<void>;
}
```

`ui` のエントリは `createApp(platform)` で、`apps/web/src/main.tsx` (`webPlatform()`)・`apps/cloud/src/main.tsx` (`webPlatform({ cloud: true })`)・`apps/desktop/src/main.tsx` がそれぞれの実装を渡す。かつての `isTauri()` 分岐はすべてこの実装側にある。

### 2.2 パッケージ間の依存

```
apps/web ──────> ui ─┬─> core
apps/cloud ─┬──> ui  ├─> api
            └──> web (Platform のブラウザ実装だけ。`@untie/web/platform`)
apps/desktop ──> ui  └─> collab (doc) ─> core, api
apps/server ─┬─> core
             ├─> api
             └─> collab (room)
```

### 2.3 Web 版とクラウド版

ブラウザで使う版は 2 つに分け、配信先も分ける。画面は同じ `ui` で、`Platform.cloud` で出し分ける。

| | Web 版 (`apps/web`) | クラウド版 (`apps/cloud` + `apps/server`) |
| --- | --- | --- |
| `Platform.cloud` | `false` | `true` (デスクトップも `true`) |
| `serverOrigin()` | `""` (サーバーを持たない) | 自分のオリジン |
| ホーム | 「ローカル」だけ。「クラウド」の欄・ログインのボタンを出さない | 「ローカル」と「クラウド」 |
| `#/f`・`#/invite`・`#/link` | ホームを出す (`Root`) | それぞれの画面 |
| 配信 | Cloudflare Pages (プロジェクト `untie`、`apps/web/dist`) | Cloudflare Worker (`untie-cloud`、`apps/cloud/dist` を assets で配る) |
| 開発 | `pnpm dev` (5174) | `pnpm dev:cloud` (5173 + wrangler dev 8787) |

Web 版は `serverOrigin()` が空なので、起動時のセッションの確認 (`session.load`) もサーバーに問い合わせない。ローカルの編集・AI・書き出しは両方で同じに動く。

`collab` は `exports` で `.` (doc) と `./room` を分け、`./room` だけが `partyserver` / `y-partyserver` / `cloudflare:workers` に依存する。`ui` から `./room` は取り込まない。ルームへの接続 (`YProvider`)・プレゼンスは DOM とストアに触れるので `collab` ではなく `ui` の `cloud/collab.ts` に置く (8.3)。`api` は DOM にも Worker にも依存しない (fetch だけ)。

## 3. ユーザー・ファイル・権限

### 3.1 概念

| 概念 | 内容 |
| --- | --- |
| ユーザー | メールアドレスで一意 (ASCII のみ。招待で受けるのも ASCII の形で、Unicode のアドレスは 400)。表示名とアイコンは ID プロバイダーからもらう。ログインのたびに、`identities` の (provider, subject) で見つかればそのユーザー、無ければメールで既存のユーザーに結び (同じメールで別のプロバイダーからログインしても同じユーザー)、どちらも無ければ作る。同じメールアドレスが別の人に再割り当てされたケースは区別しない (PoC) |
| ローカルファイル | 従来の JSON ファイル。ログインしなくても使える。サーバーは関与しない |
| クラウドファイル | サーバーに置くファイル。id は `nanoid` 21 文字。中身は Durable Object (ルーム) に、名前・所有者・メンバーは D1 に置く。開くと常に同時編集の経路になる |
| メンバー | ファイルに付いたユーザーと役割。所有者は 1 人 (作った人。譲れる) |
| 招待 | まだユーザーでないメールアドレスへの共有。招待の URL (`/#/invite/<トークン>`) を開いてログインし、そのメールで招待を受ける画面で明示的に受けると、メンバーになる (ログインしただけでは受理しない。メールが違えば拒む) |
| リンク閲覧 | 所有者が有効にしたファイルは、リンク (`/#/link/<トークン>`) を知っている人なら誰でも、ログインせずに閲覧できる。ゲストとして viewer 相当になる (3.6) |
| ゴミ箱 | 消したファイルは 30 日残し、所有者が戻せる。30 日で中身ごと消す |

### 3.2 役割と権限

| 操作 | owner | editor | viewer | リンク閲覧 (ゲスト) |
| --- | --- | --- | --- | --- |
| 開く (読む)、プレゼンスに出る | ○ | ○ | ○ | ○ (「ゲスト」として) |
| 編集する (コマンド、ドラッグ、AI エージェント) | ○ | ○ | × | × |
| JSON に書き出す | ○ | ○ | ○ | ○ |
| 複製して自分のファイルにする | ○ | ○ | ○ | ログインすれば ○ |
| 名前を変える | ○ | ○ | × | × |
| メンバーを足す・役割を変える・外す、招待する | ○ | × | × | × |
| リンク閲覧を有効・無効にする、リンクを作り直す | ○ | × | × | × |
| 所有者を譲る | ○ | × | × | × |
| ゴミ箱に入れる・戻す・完全に消す | ○ | × | × | × |
| 過去の状態 (1 時間ごとのスナップショット) の一覧と書き出し | ○ | × | × | × |
| 自分をメンバーから外す (共有をやめる) | × (譲ってから) | ○ | ○ | × (メンバーではない) |

役割の型は `Role = "owner" | "editor" | "viewer" | "guest"` で、リンク閲覧は `guest` として扱う (viewer との違いは複製とメンバー一覧の表示だけ)。規則は `packages/api/src/permissions.ts` の純粋関数 `can(role, action)` に 1 か所で書く。サーバーは API ごとにこれで判定し、画面はこれでボタンの表示と無効化を決める。画面側は見せ方だけで、サーバーの判定が正本。

### 3.3 D1 のテーブル

```sql
create table users (
  id          text primary key,           -- usr_ + nanoid
  email       text not null unique,       -- 小文字に正規化
  name        text not null,
  avatar_url  text,
  created_at  integer not null,
  last_login_at integer
);
create table identities (                  -- どのプロバイダーの誰がこのユーザーか
  provider    text not null,               -- 'google' (将来 'microsoft' など)
  subject     text not null,               -- プロバイダー側の id (sub)
  user_id     text not null references users(id),
  primary key (provider, subject)
);
create table sessions (
  id          text primary key,           -- トークンの SHA-256。トークン自体は保存しない
  user_id     text not null references users(id),
  kind        text not null,               -- 'web' | 'desktop'
  created_at  integer not null,
  expires_at  integer not null,            -- web 30 日、desktop 90 日。使うたびに延ばす
  last_seen_at integer not null,
  user_agent  text,
  activated_at integer                     -- desktop の引換コードを交換した時刻 (7.3)。null の desktop の行は認証に通らない。web は常に null (0003)
);
create table files (
  id          text primary key,           -- nanoid 21 文字 (= ルーム名)
  name        text not null,               -- モデルの meta.name の写し (3.5)
  owner_id    text not null references users(id),
  created_at  integer not null,
  updated_at  integer not null,            -- ルームが onSave で更新する
  deleted_at  integer,                     -- ゴミ箱に入れた日時。null なら生きている
  link_token  text unique                  -- リンク閲覧のトークンの SHA-256。null なら無効 (3.6)
);
create table file_members (
  file_id     text not null references files(id),
  user_id     text not null references users(id),
  role        text not null,               -- 'owner' | 'editor' | 'viewer'
  added_by    text references users(id),
  added_at    integer not null,
  primary key (file_id, user_id)
);
create table invitations (
  id          text primary key,           -- トークンの SHA-256
  file_id     text not null references files(id),
  email       text not null,
  role        text not null,               -- 'editor' | 'viewer'
  created_by  text not null references users(id),
  created_at  integer not null,
  expires_at  integer not null,            -- 14 日
  accepted_at integer
);
create index files_owner on files(owner_id, deleted_at);
create index file_members_user on file_members(user_id);
create index invitations_email on invitations(email, accepted_at);
create index sessions_user on sessions(user_id);                 -- すべての端末からログアウト
create index sessions_expires on sessions(expires_at);           -- 期限切れの掃除
create index files_deleted on files(deleted_at);                 -- ゴミ箱の掃除
create index invitations_file on invitations(file_id, accepted_at);   -- (0002) ファイルごとの未承諾の招待
create index sessions_unactivated on sessions(created_at) where kind = 'desktop' and activated_at is null;   -- (0003)
create index invitations_expired on invitations(expires_at) where accepted_at is null;                    -- (0004) 古い招待の掃除
create index invitations_accepted on invitations(accepted_at) where accepted_at is not null;              -- (0004)
```

- 所有者は `files.owner_id` と `file_members` の `role = 'owner'` の両方に書く。前者で「自分のファイル」を速く引き、後者で権限判定を 1 本にする。譲るときは 1 トランザクションで両方を書き換える。
- 「共有されたファイル」は `file_members` を `user_id` で引いて `role != 'owner'` のもの。
- マイグレーションは `apps/server/migrations/` に番号順に置き (`0001_init.sql`: 表と基本の index、`0002_invitations_index.sql`: 招待の index、`0003_desktop_sessions.sql`: `sessions.activated_at` と部分 index、`0004_invitations_cleanup.sql`: 古い招待の掃除に使う部分 index)、`wrangler d1 migrations apply` で当てる (開発は `pnpm dev:cloud` が毎回ローカルの D1 に、本番は `pnpm --filter @untie/server d1:migrate`)。スキーマを変えるときは `0005_<内容>.sql` のように次の番号のファイルを足す。当てたものは書き換えない。

### 3.4 ファイルの中身の置き場所 (Durable Object)

| キー | 中身 | 用途 |
| --- | --- | --- |
| `ydoc` | Yjs の状態 (`Y.encodeStateAsUpdate`) | 次に誰かが入ったときに `onLoad` で戻す |
| `snapshot` | JSON 形式のモデル (`rebuildModel` の結果) | 書き出し、複製、壊れたときの戻し先 |
| `snapshot:<日時>` | 1 時間ごとの `snapshot` の写し (直近 24 件。キーの日時は `2026-10-31T10:00:00.000Z` の形)。その時間の**最初の保存の直前の状態** (上書きする前の `snapshot`) を入れ、同じ時間の 2 回目以降は上書きしない | 誤って消したときに、消す直前の状態の JSON を取り出す (クラウドファイルには Undo が無い)。owner が `GET /files/:id/snapshots` (キーの一覧) と `GET /files/:id/snapshots/:key` (JSON。`export` と同じ形) で取り出し、共有ダイアログの「過去の状態」から書き出せる (7.4、8.1) |
| `revoked:*` | kick の記録 (`revoked:user:<userId>`・`revoked:sid:<sid>`・`revoked:link`・`revoked:all`)。5 分で消す | kick のあとのつなぎ直しを防ぐ (7.5) |
| `ticket:<jti>` | 使用済みのチケットの記録 (値はチケットの期限)。期限を過ぎたら次の接続で消す | チケットを 1 回しか使えなくする (7.5) |

- 1 クラウドファイル = 1 Durable Object なので、ファイルの中身はその中で閉じる。**モデルは 1 MB まで**: 取り込みの本文を 1 MB で断り (`limitBody`。413 `too_large`)、Durable Object の 1 つの値の上限に備える。それでも `onSave` の `put` が失敗したら `console.error` に残し、`save_failed` で知らせる (7.5)。R2 は使わない。
- Worker からルームへは `getServerByName(env.UntieRoom, fileId, { locationHint: "apac" })` で RPC を呼ぶ: `importModel(json)` (作成・複製)、`exportModel()` (書き出し。接続せずに読む)、`rename(name)`、`destroy()` (完全に消す)、`listSnapshots()` / `getSnapshot(key)` (過去の状態。7.4)。
- ゴミ箱に入れても Durable Object は残す (戻せるように)。30 日経ったら Worker の cron (`scheduled`、毎日 03:00 UTC。`jobs/purgeTrash.ts`) が D1 から探して `destroy()` し、行を消す (1 回に 50 件まで。失敗したファイルは行を残して次の日にやり直す)。同じ cron が期限切れのセッションと、交換されないままのデスクトップのセッション (7.2)、期限が切れて 30 日たった未承諾の招待 (`accepted_at is null and expires_at < now - 30 日`) と受けて 30 日たった招待 (`accepted_at < now - 30 日`) の行も消す。

### 3.5 名前と更新日時

- 名前の正本はモデルの `meta.name` (Y.Doc の `meta`)。一覧の `files.name` はその写し。
- ルームが `onSave` で `files.name` と `files.updated_at` を D1 に書く (ルームにも D1 のバインディングを渡す)。
- 一覧から名前を変えるときは `PATCH /api/files/:id` がルームの `rename` を呼び、ルームが `meta.name` を書いて `onSave` で D1 に反映する。エディタで `meta.name` を変えたときも同じ経路で D1 に届く。

### 3.6 リンクを知っている人の閲覧

- 所有者が共有ダイアログで「リンクを知っている人が閲覧できる」を有効にすると、サーバーが 32 バイトの乱数のトークンを作り、SHA-256 を `files.link_token` に置く。URL は `https://<host>/#/link/<トークン>` (画面側はハッシュでルーティングするため、`#` が要る)。トークンは D1 に平文で持たないので、URL を返すのは有効にした・作り直した応答 (`PUT /api/files/:id/link`) だけで、`GET /api/files/:id` の `link` は `{ enabled }` だけ。すでに有効なときの `PUT` (作り直しでない) は何も変えず URL も返さない。
- 無効にすると `link_token` を null にする。「リンクを作り直す」は新しいトークンに置き換える (前のリンクは使えなくなる)。
- リンクを開いた人は、ログインしていなくても閲覧できる。`POST /api/links/ticket` はセッションが無くても通り、`{ fileId, userId: null, name: "ゲスト", role: "guest", via: "link" }` のチケットを返す。ログインしていて、かつそのファイルのメンバーなら、メンバーの役割のチケットを返す (editor がリンクから開いても編集できる)。
- ゲストはプレゼンスに「ゲスト」と出る (画面は awareness に自分で「ゲスト」と載せ、他の人の表示もサーバーの一覧と照らして「ゲスト」にする。「ゲスト N」の番号は、サーバーの `presence()` の名前としてだけ現れる。8.3)。書き出し (`GET /api/links/export`) はできる。複製はログインしてから (`POST /api/links/duplicate`。「複製するにはログイン」を出す)。
- 無効にした・作り直したときは、Worker がルームの `kick({ via: "link" })` を呼び、リンクで入っている接続を閉じる。つなぎ直しはチケットの取得で 404 になり、画面は「このリンクは無効です」(サーバーの文言) を出してホームへ戻す。閉じられたときは「リンクが無効になりました」(閉じる理由)。
- リンクのトークンは URL に出るので、Referrer を外に漏らさないよう `_headers` の `Referrer-Policy: no-referrer` を保つ。ゴミ箱の中のファイルはリンクでも開けない。
- 編集できるリンク (誰でも editor) は作らない。編集は招待したメンバーだけ。

### 3.7 データの置き場所の地域

- D1 は `wrangler d1 create untie --location apac` で作る (作ったあとは動かせない)。
- Durable Object は作るとき (`POST /api/files` の `importModel`、7.5 の `routePartykitRequest`) に `locationHint: "apac"` を渡す。Durable Object は最初に作られた場所に留まるので、作成の経路すべてで付ける。
- `locationHint` は希望で、保証ではない (Cloudflare の `jurisdiction` は EU と FedRAMP だけで、日本は無い)。データの所在を約束する必要が出たら、R2 (`location: apac`) への書き出しと合わせて検討する。
- Worker 自体は利用者に近い場所で動く。日本の利用者なら日本のデータセンターで動き、D1 と Durable Object へは apac の中で届く。

## 4. データの表現 (Y.Doc)

### 4.1 Y.Doc の形

```
doc
├ meta:      Y.Map { name, description }
├ elements:  Y.Map<id, Y.Map>   … kind, name, description, 種類固有の項目, order
├ relations: Y.Map<id, JSON>    … { kind, sourceId, targetId, access?, alternate? } (値ごと置く。取得・保存の区別 access と、代替パターン alternate (0.6.1) を変えるときも、値ごと置き直す。同じ関係を同時に直すと後勝ち)
├ boards:    Y.Map<id, Y.Map { name, order,
│                              nodes: Y.Map<elementId, { x, y, width?, height? }>,
│                              edges: Y.Map<relationId, { sourceSide, targetSide }> }>
├ designs:      Y.Map<`${systemId}/meta` → JSON { databaseIds, order },
│                    `${systemId}/layout` → JSON { shell, header? }>
├ designScreens:     Y.Map<DesignScreen.id → JSON { systemId, id, source, view?, bindings?, order }>
├ designTransitions: Y.Map<Transition.id → JSON { systemId, id, from, to, via?, label?, order }>
├ designNav:         Y.Map<グループの id → JSON { systemId, id, group, items, order }>
├ databases:    Y.Map<`${id}/name` → string, `${id}/dsl` → string, `${id}/tables` → JSON, `${id}/order` → string>
└ domain:       Y.Map<部品の id → JSON { part, id, ...部品の項目, order }、`x:` + 候補のキー → JSON { part: "excluded", key, order }>
```

- **設計データ** (`designs`・`designScreens`・`designTransitions`・`designNav`・`databases`。モデルの形式 0.5.0、設計書 4.0・5.7 章): **入れ子の Y.Map を使わず、ルートごとに平らな「キー → JSON の値」で置く**。決まったキーに Y.Map を新しく `set` する作りだと、2 人が同時に設計 (`ensureDesign`) や既定のデータベースを作ったとき、後から作った Y.Map ごと片方が消える。値だけなら、別々のキーに足したものは両方残り、同じキーへの同時の書き込みは後勝ちで 1 つになる。設計があるかは `${systemId}/meta` の有無、データベースがあるかは `${id}/name` の有無で決める。画面・遷移・ナビのグループ (`layout.navigation[]`。そのため `id` を持つ) は、設計を持つ `systemId` を値に入れた別のキーに置くので、同じ設計に 2 人が別々の画面・グループを足しても両方残る (画面・遷移・グループの id は設計をまたいで一意)。画面ごとのレイアウトの上書き (`shell`。0.5.1) も画面の値の中に載る (列挙の外の値は読むときに項目だけ落として画面は残す)。画面 UI (`view`) は画面の値の中の 1 つの JSON で、同じ画面の UI を同時に変えたときは後勝ち。データベースの `dsl` は 1 つの文字列で、文字単位では合流しない。設計・データベース・画面・遷移・グループにも `order` を持たせ、組み立てるときに並べて落とす。レイアウトが壊れている・無いときは既定値 (`shell`) で補い、画面と遷移は残す。**読むとき**はスキーマの検証関数 (`designScreen`・`transition`・`navGroup`・`layout`・`database`。`isValidDesignShape`) で部品ごとに検査し、合わないもの、設計 (`/meta`) が無い (消えた) システムの画面・遷移・ナビは読み飛ばす (要素の `isValidElementShape` と同じ流儀。長すぎる文字列は切り詰めた写しで検査する)。`rebuildModel(doc, prev)` は設計の画面・遷移・グループを id ごとに参照を共有する (`shareDesign`)。`observeModelChanges` は変わった `designs`(systemId)・`databases`(id) も知らせる。壊れた参照 (消えたシステム・画面・情報・データベースを指す設計データ) は `repairModel` が `removeElement` の連鎖と同じ範囲で外し、長すぎる設計の文字列は `truncateModelStrings` が切り詰める
- **ドメインモデル** (`domain`。モデルの形式 0.6.0、設計書 4.6 章): 設計データと同じく、**入れ子の Y.Map を使わず、1 つのルートに平らな「キー → JSON の値」で置く**。部品 (境界づけられたコンテキスト・集約・コマンド・イベント・ポリシー・コンテキスト間の関係・用語) は id をキーにし、値に部品の種類 `part` (`context` / `aggregate` / `command` / `event` / `policy` / `relation` / `term`) と並びの `order` を持つ (id は種類をまたいで一意なので、1 つの Y.Map に置ける)。親 (集約のコンテキスト、コマンドの集約) は値の中の id で指すので、付け替えてもキーは変わらない。別々の部品を 2 人が同時に直せば両方残り、同じ部品への同時の書き込みは後勝ちで 1 つになる。集約の中の情報 (`memberInformationIds`)・不変条件 (`invariants`) は集約の値の中の JSON なので、**同じ集約を 2 人が同時に直すと後勝ち** (画面の `bindings` と同じ扱い)。コマンドとイベントを集約の値の中に入れないのは、AI と人が同じ集約を同時に直したときに、コマンドがまとめて消えてポリシーの参照が宙に浮くのを避けるため。外した候補 (`excluded`) は 1 件 1 キー (`x:` + 候補のキー。部品の id は `[A-Za-z0-9_-]` だけなので重ならない)。読むときは、形の壊れた部品 (`part` が分からない、スキーマに合わない) を読み飛ばし、長すぎる文字列・形の合わない英語名・列挙の外の分類は直した写しで形を検査する (`cleanDomainPart`。部品は残す)。消えた集約を指すコマンドなどの壊れた参照は、表示用の組み立て (`rebuildModel`) が `repairModel` で外し、サーバーの `repairDoc` が Y.Doc からも消す (6 章)。`shareModel` はドメインモデルの部品も id ごとに参照を使い回す (ドメインモデルだけが変わった更新も画面に届く)。`observeModelChanges` は `domain: boolean` で知らせる。ルームは版で接続を断らないので、0.5.4 までの古いタブはこのルートを読まず、そのタブから JSON に書き出すと `domain` の無い (古い版の) ファイルになる (開けば空のドメインモデルが足される)。
- 要素の項目 (`name`、`description`、`bucId`、`contextId`、`severity`、`hours`、`verification`、`triggerNote`、`values`、`targetIds`、`links`、`analysis`) は Y.Map の値ごとに後勝ち。`values`・`targetIds`・`links` は小さな配列なので丸ごと 1 つの値として置く。
- `elements` と `boards` の配列の順番は、固定ボードの並び (`fixedBoards.ts` の index による tie-break) に効いている。配列は合流に向かないので、各要素に順序キー `order` (fractional index の文字列) を持たせ、組み立てるときに `order` で並べる。JSON に書き出すときは並べた順の配列にし、`order` は落とす。読み込むときは配列の順に `order` を振る。
- ノードの座標 `{x, y, width, height}` は 1 つの値として置く (ドラッグの確定は座標とサイズをまとめて 1 回で書く)。
- **関係・ノード・線の値にも `order` を持たせる**。関係 (`relations`)、ボードの `nodes`、`edges` も配列の順に意味があり (`setEdgeSides` は線の並びを変える)、Y.Map の反復順は端末ごとに揃わないため、値の中に `order` を入れる (`{ kind, sourceId, targetId, order }`、`{ x, y, width?, height?, order }`、`{ sourceSide?, targetSide?, order }`)。組み立てるときに落とす。
- 課題の `analysis` (現象・所在・理由・影響) は項目ごとに別の人が埋めることがあるので、Y.Map にして項目ごとに後勝ちにする。**課題には `analysis` の Y.Map を、ボードには `nodes` と `edges` の Y.Map を、空でも常に作る**。最初の項目を別々の人が同時に書いたとき、後から作った Y.Map ごと負けて片方の書き込みが消えるのを防ぐ。`analysis` が無くなるときも Y.Map は残して項目だけ消し、組み立てるときは空の `analysis` を出さない。
- **順序キー**は `fractional-indexing` で作り、同じ隙間に同時に足した 2 人のキーが同じにならないよう、末尾に 5 文字の乱数を後ろ付けする (前後のキーの間に収まるときだけ)。並びは **`(order, id)` の順**で決める (重複があっても全端末で同じ並びになる)。順番が入れ替わったとき振り直すのは、新しい並びで厳密に増える最長の列 (最長増加列) から外れた項目だけ。形の不正なキーは「キーが無い」ものとして振り直す。

### 4.2 UntieModel との往復

`packages/collab/src/doc/` に純粋関数を置く。

| 関数 | 内容 |
| --- | --- |
| `loadModel(doc, model, origin?)` | JSON から読んだモデルを空の Y.Doc に 1 トランザクションで入れる (順序キーを振る)。`origin` は省略可 (サーバーの `importModel` 用)。`$schema` は入れない |
| `readModel(doc)` | Y.Doc の中身をモデルにする。壊れた参照は外さず、ボードが 0 枚でも補わない。ただし形の壊れた要素・ノード・関係・線は外す。**文字列がスキーマの上限を超えているだけの要素は外さず、上限に切り詰める** (形の検査 `isValidElementShape` の前に切り詰める) |
| `readRawModel(doc)` | `readModel` と同じだが、長すぎる文字列も切り詰めずにそのまま返す。サーバーが「直す前」の状態を読むのに使う (切り詰めた結果との差分を Y.Doc に書くため) |
| `rebuildModel(doc, prev?)` | `readRawModel` に `repairModel` (壊れた参照の修復と文字列の切り詰め) を当てた、表示用のモデル。`prev` を渡すと、内容が同じ要素・関係・ボード・ノード・線は `prev` の参照を使い回す (React のメモ化と `===` 比較を生かす)。全部同じなら `prev` 自体を返す |
| `applyModelDiff(doc, before, after, origin)` | 2 つのモデルを id 単位で比べ、違う項目だけを 1 つのトランザクションで Y.Doc に書く |
| `repairModel(model)` | 壊れた参照を見つけ、直したモデルと変更の一覧を返す (6 章。core にあり、Y.Doc を知らない) |
| `repairDoc(doc, origin)` | サーバーだけが呼ぶ。`readRawModel` の結果に `repairModel` を当て、差分を `applyModelDiff` で `origin` 付きに書き (長すぎる文字列は切り詰めて書き戻す)、変更の一覧を返す。壊れていなければ何も書かない |
| `observeModelChanges(doc, callback)` | 変わった id (`elements` / `relations` / `boards` / `designs` / `databases` / `meta`) を、**トランザクションごとに 1 回**、`origin` 付きで知らせる (`observeDeep` を包む)。戻り値は解除 |

読み込んだあとのストアは、入れたモデルではなく **`rebuildModel` の結果**を使う。Y.Doc を通すと `$schema`、空の `edges: []`、空の `analysis: {}` は落ちる (コマンドはどれも作らないので、通常の編集では起きない)。

往復の性質 `rebuildModel(applyModelDiff(doc, a, b)) ≡ b` をテストで固める (サンプルと、コマンドをランダムに当てたモデルで)。これが崩れると、自分の画面とほかの人の画面がずれる。

## 5. 編集の流れ (クラウドファイル)

```
コマンド (純粋関数)            Y.Doc (正本)                    ストア (表示用)
dispatch(cmd)
 ├ after = cmd(model)          applyModelDiff(before, after, origin=local)
 └ model = rebuildModel(doc, after) <───────────────────────── 表示に出す (Doc を通した結果)
                               ← 他の人の update / repair
                               observeModelChanges → rebuildModel(doc, model) ─> applyRemoteModel(model)
```

- **dispatch**: コマンドを手元のモデルに当て、成功したら差分を `origin = local` のトランザクションで Y.Doc に書き、**そのあと `rebuildModel(doc, after)` を表示のモデルにする** (Doc が正本。コマンドの結果をそのまま出すのではない)。同時に届いていた他の人の変更も、消した側が勝つ規則も、ここで Doc の側で揃う。失敗 (`ok: false`) はいままでどおり何もしない（文字数の上限を超える入力も、「名前は 200 文字までです」のような理由で失敗にする。1 章。画面はトーストに出し、AI エージェントの道具は理由をそのまま AI に返す）。`viewer` のときは `dispatch` が何もせず `{ ok: false, reason: "閲覧専用です" }` を返す。
- **他の人の変更**: `observeModelChanges` が `origin` が自分以外のトランザクションを知らせるたびに、**変わった id だけではなく毎回 `rebuildModel(doc, prev)` で全体を組み立て直す** (届く id と組み立て直して変わる範囲が一致しないため。6 章)。`prev` を渡すので、内容が同じ要素・関係・ボード・ノード・線は参照が使い回され (構造共有)、React の再描画は変わった分に絞られる。`reconcileUi` で選択やボードの参照先が消えていたら外す (既存の処理)。
- **ドラッグ中** (`previewNode` / `previewCommand`): Y.Doc には書かず表示だけ動かす。ドラッグ中に届いたリモートの変更は後回しにし (`pendingRemote`)、`commitDrag` / `cancelDrag` のあとで Doc から組み立て直す。`commitDrag` が書くのは `dragBase` と確定後の差だけなので、他の人の変更は消さない (同じノードを他の人が動かしていたら、確定時に自分の座標で上書きする。後勝ち)。`dispatch` と `agentApply` は、ドラッグ中なら先に `commitDrag` する (`before` が Doc とずれないように)。
- **AI エージェント** (`beginAgentEdit` 〜 `endAgentEdit`): 途中の `agentApply` は Y.Doc に書く (他の人にも見える)。クラウドでは `beginAgentEdit` の間だけ書ける (開く前から走っていたローカルのエージェントを通さないため)。`viewer` は使えない。
- **Undo / Redo**: クラウドファイルでは使えない。開いたときに履歴を捨て、ツールバーのボタンを無効にし、Cmd/Ctrl+Z・Shift+Cmd/Ctrl+Z・Ctrl+Y を無視する。
  - 理由: 共有中の Undo は「自分の変更だけを戻す」ことになるが、他の人の変更と絡むと結果が読めない (自分が足した作業を戻したら、他の人がそこに付けた課題の対象や関係が消える、など)。PoC では入れない。
  - 誤って消したときの戻し先は、書き出した JSON と、サーバーのスナップショット (3.4)。
- **ローカルファイルは従来のまま**: Y.Doc を持たない。`dispatch`・履歴・保存していない変更の判定 (`model === savedModel` の参照比較) は、従来のコードを変えていない。ストアに `UntieDoc` が付いているときだけ、上の経路を通る。
- **保存していない変更**: クラウドファイルはサーバーが正本なので、つながっている間は「未保存」の概念が無い。Cmd/Ctrl+S は「JSON に書き出す」になる。つながっていない間の変更は手元の Y.Doc に溜まり、つながると合流する。**その溜まった分はタブを閉じると失われる**ので、「最後の同期のあとに、つながっていない間に自分が書いた変更がある」ときだけ、閉じる前の確認とホームへ戻る確認の対象にする (8.3)。

## 6. 参照整合性

Yjs は「要素 A を消す」と「A への関係を足す」を両方受け入れるので、合流後に壊れた参照が残りうる。

- `repairModel` (core、純粋関数) が、`validateModel` の参照整合性検査と同じ規則で壊れた箇所を見つけ、直し方を返す。
  - **持っている規則**: 消えた要素を指す関係・ノード・`targetIds` は消す。消えた BUC を指す `bucId` と消えたコンテキストを指す `contextId` は `null` にする (「無い」ものと「種類が違う」ものを分けて報告する)。業務が消えた BUC は消す。業務の既定の活動はちょうど 1 個にする (無ければ作る。id は `buc_<業務の id>` で、どの端末で直しても同じ。複数なら最初を残し、他の既定の活動の作業は残した方へ付け替えて消す) 。既定の活動の名前を業務名に揃える。自己参照の関係と、両端の種類から決まる kind と合わない関係は消す。置けない要素 (課題・既定の活動) のノードは消す。枠 (業務・BUC) のノードに `width` / `height` が無ければ既定の大きさを補う。関係が消えたボードの線の設定は消す。ボードが 0 枚なら「ボード 1」を作る。
  - **長すぎる文字列は切り詰める**: スキーマの上限 (`limits.ts`。1 章の表) を超えた名前・説明・状態グループ・値・分析の項目・リンクの表示名と URL・ボード名・ファイル名は、要素ごと外さず上限の文字数 (コードポイント) に切り詰める (`truncate.ts`)。外すと、その要素が全員の画面から消え、関係もサーバーに消されるため。コマンドが上限を超える入力を断る (1 章) ので、通常の編集では起きない。古い版のクライアントや壊れた update が書いたときの備え。
  - **設計データ (0.5.0)**: システムが消えた設計、元の画面が同じシステムの画面でなくなった設計の画面、画面が消えた遷移とナビゲーションの項目、同じ元の画面を指す画面が 2 つ以上あるときの後のもの (2 人が同じ画面を足したとき。それを指す遷移・ナビの項目も消す)、同じ from / to の遷移が 2 本以上あるときの後のもの、データベースが消えた使用指定と項目の対応、情報が消えたテーブルの対応は消す・外す (データベース自体は消さない。`removeElement` の連鎖と同じ範囲)。データベースの名前と DSL の長すぎる文字列は切り詰める。
  - **ドメインモデル (0.6.0)**: 消えた情報をルートにする集約 (とそのコマンド)、コンテキストが消えた集約・イベント・関係、集約が消えたコマンド、イベントかコマンドが消えたポリシーは消し、消えた要素への参照 (中の情報・実装先のシステム・出どころの操作・もとの条件など) は外す。同じ候補を 2 人が同時に採用して重なったコマンド・イベントは後のものを消す。規則は `inspectDomain` (設計書 4.6)。
  - **画面 UI の上限 (0.5.0)**: 設計の画面の `view` が、JSON にして `VIEW_JSON_MAX_LENGTH` (200000) 文字を超える・入れ子が `VIEW_MAX_DEPTH` (64) 段を超える・節 (オブジェクト・配列・値) が `VIEW_MAX_NODES` (50000) 個を超える・`__proto__` / `constructor` / `prototype` のキーを含むときは、**画面は残して `view` と `bindings` を捨てる** (changes は画面の id だけ)。コマンド (`setDesignScreenView`) は同じ上限で断るので、通常の編集では起きない。古い版のクライアントや壊れた update の備え。サーバーの `repairDoc` も、クライアントの `rebuildModel` (表示から外す) も `repairModel` を通るので同じ。同じ画面の `view` は 1 つの値として持つので、同時に直したときは丸ごと後勝ちになる。
  - **同じ関係の重複**は `sameRelation` で畳み、**`(order, id)` で先頭のものを残す**。畳んだ関係の線の設定も消す。
  - **changes の文言**は id・種類・項目名・件数だけで、業務名などの中身を含まない (`作業 act_x の説明が長すぎたので切り詰めた`、`ボード board_x のノード … を消した`)。ルームの `console.log` がそのまま出すため。
  - **持っていない規則 (対象外)**: 要素・関係・ボードをまたいだ id の重複、`hours` の小数点の桁、課題の対象の混在。`validateModel` は検査するが、同時編集では起きにくいので直さない (起きたら `onSave` の検証で見つけて記録し、`save_failed` で知らせる。7.5)。
- **直すのはサーバーだけ** (`UntieRoom` が update を受けるたびに、debounce して `repairDoc(doc, "repair")` を呼ぶ)。全員が直すと同じ修正が何度も流れる。
- クライアントの `rebuildModel` は、直されるまでの間 UI が壊れないよう、壊れた参照を表示から外す (Y.Doc は変えない)。**外すもの**は `repairModel` の規則に加えて、形の壊れた要素・ノード・関係・線 (項目が欠けた課題など。1 つで全員の組み立てが落ちるのを防ぐ。core の生成済みの要素単位の検証を使う) と、種類の分からない要素。文字列の長すぎるものは外さず切り詰める (上記)。
- **ボードが 0 枚**のとき、表示用に `board_main` の「ボード 1」を補う (Y.Doc は変えない)。補ったボードへの編集が消えないよう、Y.Doc のボードが 0 枚のときに限り、`applyModelDiff` が `board_main` を Y.Doc に作る。サーバーの修復と同じ固定 id なので、両方が作っても 1 つのボードに合流する (同時に作った内容は後勝ちで、片方は残らない)。
- `addRelation` の重複検査など、コマンド側の検査はいままでどおり自分の手元のモデルに対して行う。同じ関係を 2 人が同時に足すと id が違う重複が残る。表示は 1 本に畳まれるが、見えている方を消すと隠れていた方が現れてしまう。そのため `applyModelDiff` は関係を消すとき、Y.Doc に残っている `sameRelation` の重複と、その線の設定も同じトランザクションで消す。
- **衝突の非対称**: 要素と、ボード・関係のように Y.Map のキーで持つものは「消した側が勝つ」(消された要素への更新は、書き込む先が無いので捨てる)。一方、値ごと置く項目 (ノード・線・関係) は、同時の更新が消去に勝って復活しうる。ストアは `dispatch` の前に、リモートの変更の組み立て直しを済ませておく (ドラッグ中は `commitDrag` が先に組み立て直す。8.2。手元の `before` が Y.Doc とずれると、消えたものを復活させる)。`applyModelDiff` は、変えた項目が Y.Doc に無いときは書かない。
- **`observeModelChanges` で届く id と、組み立て直して変わる id は一致しない**。たとえば BUC が消えると、その BUC を指す作業の `bucId` が (`repairModel` により) 変わるが、届くのは BUC の id だけである。部分的な組み立て直しはせず、`rebuildModel(doc, prev)` で全体を組み立てて構造共有に任せている。
- id は `kind_` + 6 文字 (36^6 ≈ 22 億通り) だったが、同時編集では別々の端末で同じ id を引く恐れがわずかにあるので **8 文字**にした (36^8 ≈ 2.8 兆通り。JSON の形式は変わらない。既存の 6 文字の id はそのまま使える)。

## 7. サーバー (apps/server)

### 7.1 構成

```ts
// apps/server/src/index.ts (要点)
export { UntieRoom } from "@untie/collab/room";
const app = new Hono<AppEnv>();
app.use("*", redirectToAppOrigin);     // APP_ORIGIN 以外のホストへの GET は APP_ORIGIN の同じパスへ 302 (下の表の vars)
app.use(path, desktopCors);            // /api/*・/auth/providers・/auth/desktop/exchange・/auth/logout・/auth/logout-all。7.2
app.use(path, requireConfig);          // /api/*・/auth/*・/parties/*。SESSION_SECRET・TICKET_SECRET が 32 文字未満なら 503 misconfigured
app.route("/auth", authRoutes);        // 7.3
app.route("/api", apiRoutes);          // 7.4。/api/links/* 以外は requireSession を通す
app.all("/parties/*", ...);            // 7.5。チケットを検めて routePartykitRequest に渡す
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));  // apps/cloud/dist (SPA)。/api と /auth の存在しないパスは JSON の 404
export default { fetch: app.fetch, scheduled: purgeTrash };   // cron: ゴミ箱と期限切れのセッションの掃除 (3.4)
```

| バインディング | 用途 |
| --- | --- |
| `ASSETS` | `apps/cloud/dist` の静的配信 (`not_found_handling: "single-page-application"`) |
| `DB` (D1) | 3.3 のテーブル |
| `UntieRoom` (Durable Object、`new_sqlite_classes`) | ファイルの中身 |
| vars (`wrangler.jsonc`) | `ALLOWED_EMAIL_DOMAINS` (空なら制限なし)、`DEV_LOGIN` (本番は `"false"`)、`APP_ORIGIN` (公開の URL。本番で書き換える。空ならリクエストのオリジン)。`APP_ORIGIN` があるとき、それ以外のホスト (workers.dev など) への **GET / HEAD は `APP_ORIGIN` の同じパス・クエリへ 302** する (`apps/server/src/redirect.ts`)。移さないもの: `/parties`・`/api/links/*`・`/auth/desktop/exchange`、デスクトップアプリからの呼び出し (Origin が WebView のもの、または `Authorization: Bearer` 付き。アプリは設定した URL へ直接つなぐため)、GET / HEAD 以外 (302 だと本文が落ちる)、ループバックのホスト (`wrangler dev` はリクエストのオリジンを常に `http://localhost:8787` と見るので、`APP_ORIGIN` が 5173 だと無限に移ってしまう)。ページ (`/`・`/index.html`) も Worker が受けるよう、`assets.run_worker_first` に含めてある (9 章) |
| secrets (`wrangler secret put`。開発は `.dev.vars`) | `SESSION_SECRET` (`untie_auth` Cookie = ログイン途中の state などの署名。セッションの Cookie は乱数のトークンで、署名ではない。**32 文字以上が必須**)、`TICKET_SECRET` (7.5 のチケットの署名と、引換コードの暗号鍵の元。**32 文字以上が必須**)、`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`。どちらかが足りない（空・短い）と、Worker は最初のリクエストで原因（秘密の名前だけ。値は出さない）を `console.error` に 1 回残し、`/api/*`・`/auth/*`・`/parties/*` に **503 `misconfigured`** を返す（500 にしない。静的ファイルは配る）。`secretIsStrong` を TICKET_SECRET と共用 (`apps/server/src/config.ts`) |
| `triggers.crons` | `0 3 * * *` (毎日 03:00 UTC。ゴミ箱の掃除) |

### 7.2 セッション

- ログインが済むと `sessions` に行を作り、トークン (32 バイトの乱数、base64url) を返す。D1 にはその SHA-256 だけを置く。
- **Web**: `Set-Cookie: untie_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/`。`Secure` は**リクエストが https のとき**に付ける (`APP_ORIGIN` の設定には頼らない。http://localhost の開発では付かない)。Cookie は `kind = web` のセッションだけ、Bearer は `kind = desktop` のセッションだけを受ける。ログインし直したときは、持っていた Cookie のセッションの行を消す。開発用ログイン (`DEV_LOGIN=true`) は、リクエストのホストが localhost / 127.0.0.1 のときだけ効く (本番で誤って true にしても効かない)。API は Cookie で認証する。CSRF は SameSite=Lax に加え、状態を変える API は `X-Requested-With: untie` ヘッダーを要求する (フォームからは付けられない)。
- **デスクトップ**: トークンを `Authorization: Bearer <token>` で送る。キーチェーンに `session` として置く (`keyring` のコマンド `get_secret` / `set_secret` / `delete_secret`。名前は `claude`・`codex`・`gemini`・`session` だけ受ける)。作った直後の desktop のセッションは `activated_at` が null で、**引換コードを交換する (7.3) まで認証に通らない**。交換されないまま 1 時間以上たった行は毎日の cron が消す(`delete … where expires_at < ?` と `delete … where kind = 'desktop' and activated_at is null and created_at < ?` の 2 本。前者は `sessions_expires`、後者は 0003 の部分 index `sessions_unactivated` を使う)。
- **期限切れ・未交換のセッションの掃除は接続を閉じない**: cron は行を消すだけで、開いている接続は切れるまで残る (つなぎ直すと、チケットの取得が 401 になる)。
- **CORS** (デスクトップの WebView は別のオリジンから呼ぶ): `/api/*`・`/auth/providers`・`/auth/desktop/exchange`・`/auth/logout`・`/auth/logout-all` に、`Origin` が `tauri://localhost` (macOS / Linux)・`http://tauri.localhost` (Windows) のとき、および `http://localhost:1420` (`tauri dev`。**`DEV_LOGIN=true` のときだけ**。本番では許さない) のときだけ `Access-Control-Allow-Origin` にその値を返す (一覧に無い送り元には何も付けない。`Vary: Origin`)。プリフライトは許す送り元に 204 (`Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS`、`Allow-Headers: Authorization, Content-Type, X-Untie-Token, X-Requested-With`、`Max-Age: 600`)、許さない送り元に 403。`Expose-Headers: Content-Disposition` (書き出しのファイル名を読むため)。**credentials は許さない** (`Access-Control-Allow-Credentials` は付けない)。**Cookie 認証は CORS 経由では使われない**: Cookie は SameSite=Lax なので別サイトからの fetch には付かず、さらにサーバーも、デスクトップの送り元から届いたリクエストの Cookie は読まない (Bearer だけを見る)。`/parties/*` の WebSocket は Origin を見ない (partyserver のまま。認証はチケット)。
- `requireSession` ミドルウェアが Cookie か Authorization を読み、`sessions` を引いて `c.var.user` を入れる。期限切れは 401。使うたびに `last_seen_at` と `expires_at` を延ばす (1 日に 1 回だけ書く)。
- ログアウトは行を消す。「すべての端末からログアウト」は `user_id` の行を全部消す。
- **ログアウトで開いているルームの接続も閉じる**: セッションを消しても、開いている WebSocket は切れない。そこでチケットの claims に `sid` (セッションの id = トークンの SHA-256 の先頭 16 文字。リンクで開いたゲストは null) を入れ、ルームが接続の state に写す (7.5)。`POST /auth/logout` は、そのセッションの `sid` で、`POST /auth/logout-all` は、そのユーザーの `userId` で、**そのユーザーがメンバーのすべてのファイル** (`file_members` から引く。ゴミ箱の中も含む) のルームに `kickRoomQuietly` を送る (`kick({ sid })` / `kick({ userId, reason: "loggedOut" })`。どちらも `4000「ログアウトしました」`)。ファイルが多いとき (6 件以上) は応答を待たせず `executionCtx.waitUntil` で続ける（上限は 7.5）。kick の準備を含めて失敗しても例外にせず、Cookie を消して 204 を返す。同じユーザーの別のセッションの接続は `logout` では残る。セッションが無い・期限切れの `logout` は何も閉じない。

### 7.3 ログイン (OIDC)

```
Web:        画面 ─GET /auth/login?provider=google────> Worker ─302─> Google
            Google ─302 /auth/callback?code&state──> Worker: code を交換、id_token を検証、users/identities を upsert、
                                                             sessions を作成、Cookie を付けて 302 / (元の URL)
デスクトップ: アプリ ─既定のブラウザで GET /auth/login?provider=google&client=desktop&state=<乱数>
            … 同じ流れで Worker がセッションを作る …
            Worker ─200 HTML (/auth/desktop/done の役目。callback の応答そのもの): untie://auth/callback?code=<引換コード>&state= へ自動遷移 + ボタン + コードの表示とコピー
            アプリ ─deep link を受ける → state を照合 → POST /auth/desktop/exchange { code, state } ─> { token, user }  → キーチェーンへ
```

- `GET /auth/providers` は使えるログイン方法 `{ providers }` を返す (`google` は `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` が入っているとき、`dev` は開発用ログインが有効なときだけ並ぶ。画面はこれでボタンを出す)。
- `state` と `nonce` と PKCE (`code_verifier`) は Worker が Cookie (`untie_auth`、10 分、HttpOnly) に署名付きで持ち、callback で照合する。
- プロバイダーは `IdentityProvider` インターフェース (`authorizationUrl`、`exchange`、`profile`) で抽象化し、まず `google` だけを実装する。ライブラリは `arctic` を使う (OIDC の定型を持ち、Workers で動く)。
- メールアドレスは小文字に正規化して `users.email` に合わせる。プロバイダーが `email_verified: false` を返したら拒む。
- **デスクトップのログイン** (Web の流れに `client=desktop` を足したもの):
  - `GET /auth/login?provider=…&client=desktop&state=<乱数>&code_challenge=<PKCE>`: `state` はアプリが作る乱数 (`[A-Za-z0-9_-]` の 16〜128 文字)、`code_challenge` は PKCE (RFC 7636 / RFC 8252) の `base64url(sha256(verifier))` (`[A-Za-z0-9_-]` の 43 文字)。どちらかが外れたら 400 `invalid_state`。`untie_auth` Cookie に `client: "desktop"`・`appState` (OIDC の `state` とは別)・`challenge` を入れる。Google も開発用ログイン (`/auth/dev` を経由する。Cookie は同じ) も流れはそのまま。デスクトップでないログイン (`client` が無い・`web`) は、前のデスクトップのログインが残した `untie_auth` を消してから進む (Google は新しい `untie_auth` で上書きする)。
  - callback (Google の `/auth/callback`、開発用の `POST /auth/dev`) で `client === "desktop"` なら、`kind = "desktop"` のセッション (90 日。`activated_at` は null) を作り、**Cookie は付けずに**引換コードを入れた HTML を 200 で返す。ページは「アプリに戻ります」と、`location.href` での `untie://auth/callback?code=<引換コード>&state=<state>` への自動遷移、同じリンクのボタン、deep link が開けない環境のための引換コードの表示と「コピー」ボタン。`Cache-Control: no-store`、スクリプトは nonce つきの CSP。
  - **引換コード**: `{ sessionHash, state, challenge, exp }` (`sessionHash` はこのときできた行の id=乱数のハッシュ、`challenge` は上の `code_challenge`、`exp` は 5 分後のエポックミリ秒) を JSON にして AES-GCM で暗号化した `base64url(iv ‖ 暗号文)`。**生のトークンは入れない**(この時点ではトークンはまだ存在しない)。鍵は `TICKET_SECRET` から HKDF-SHA256 (`info = "desktop-exchange-code-v1"`) で作り、チケットの HMAC の鍵と同じ秘密から別の鍵を派生する。追加認証データを固定にして他の用途に使い回せない。D1 には置かない。暗号化するのは、deep link の URL・ブラウザの履歴・クリップボードに残っても中身(state・challenge)が読めないようにするため。
  - `POST /auth/desktop/exchange { code, state, code_verifier }` (セッション不要、CORS 対応。7.2。`code_verifier` は `[A-Za-z0-9_-]` の 43〜128 文字): 復号できなければ 400 `invalid_code`、`exp` を過ぎていれば 401 `code_expired`、`state` が違えば 400 `state_mismatch`、`base64url(sha256(code_verifier))` が `challenge` と違えば 400 `invalid_verifier` (どちらもコードは使われないまま)。そのうえで**新しいトークンをこのとき作り**、`update sessions set id = <新しいトークンの SHA-256>, activated_at = now, last_seen_at = now where id = <sessionHash> and kind = 'desktop' and activated_at is null and expires_at > now` で行の id を入れ替え、`meta.changes === 1` のときだけ `{ token, user }` を返す。書けなかった (2 回目・行が消えている) ら 401 `code_used`。1 回限りは D1 の `activated_at` で守る (同時に 2 本来ても通るのは 1 本)。コードを盗み見た者は、verifier を持たないので交換できない(PKCE)。マイグレーションは `0003_desktop_sessions.sql`。
  - アプリ: `state` と PKCE の `verifier` (32 バイトの乱数の base64url) を作って `sessionStorage` に置き (戻り先とサーバーの URL も一緒に。**15 分**で無効)、`challenge` を付けて既定のブラウザで `/auth/login?…` を開く。deep link (`tauri-plugin-deep-link` の `onOpenUrl`。アプリが deep link で起動されたときは `getCurrent`) で `untie://auth/callback?code&state` を受けたら (URL は hostname に頼らず、頭の `untie://auth/callback` を文字列で比べ、クエリだけ `URL` で読む)、記録の `state` と照合して (合わなければ拒む)、`POST /auth/desktop/exchange` に `verifier` を添えて送る → 返った `token` を、**サーバーの URL とログインの記録がまだ同じときだけ**キーチェーンの `session` に置く(交換の最中に設定を変えたら、古いサーバーのトークンを保存しない)→ 戻り先 (`returnTo`) を `location.hash` に反映して `onLoggedIn` で知らせる。交換したコードがもう一度届いても何もしない。記録が無い・期限切れなら、それぞれ「ログインの記録がありません」(1 度だけ)・「時間切れです」と知らせる。`state` と `verifier` は短命なので、キーチェーンではなく `sessionStorage` に置く。
  - deep link が使えない環境では、ブラウザ側のページに引換コードを表示し、アプリのログイン欄の「引換コードを貼る」に貼る経路 (`completeLoginWithCode`) を残す。Windows / Linux は deep link で別のプロセスが起動されるので、`tauri-plugin-single-instance` (deep-link 機能つき) が URL を動いているアプリに渡す。
  - `POST /auth/logout`・`POST /auth/logout-all` は Bearer でも効く (行を消す。`X-Requested-With` は Cookie 認証のときだけ要る)。アプリは API の後で `clearSession()` でキーチェーンのトークンを消す。
- 登録はドメインで絞らない。Google のアカウントがあれば誰でもログインでき、共有されなければ自分のファイルしか見えない。将来絞りたくなったときのために `ALLOWED_EMAIL_DOMAINS` (環境変数、空なら制限なし) の判定だけ入れておく。

### 7.4 API

すべて `/api/` の下。JSON。`/api/links/*` を除いて `requireSession` を通る。ログアウトは `/api` ではなく `/auth` の下 (`POST /auth/logout`、`POST /auth/logout-all`。7.6)。リクエストは `packages/api` の zod スキーマで検証する。

| メソッドとパス | 内容 | 必要な役割 |
| --- | --- | --- |
| `GET /me` | 自分のユーザー情報 | ログイン |
| `GET /files` | 自分のファイルと共有されたファイル (`{ mine, shared }`)。名前・更新日時・役割・メンバー数 | ログイン |
| `POST /files` | 作る。`{ name }` で空のモデル、`{ model }` で JSON を取り込む (ローカルファイルをクラウドへ)。作った人が owner | ログイン |
| `GET /files/:id` | 1 件の情報 (名前・所有者・自分の役割)。**owner にだけ** `members` (`userId`・`email`・`name`・`role`・`addedAt`)、`invitations` (まだ受けられていない招待。`id`・`email`・`role`・`createdAt`・`expiresAt`。期限切れも含む)、`link` (`{ enabled }` だけ。トークンは持たないので URL は返さない) を付ける。editor / viewer には付けない | member |
| `PATCH /files/:id` | 名前を変える。ゴミ箱の中のファイルは owner でも 409 `in_trash` (戻してから変える) | editor |
| `POST /files/:id/duplicate` | 複製して自分の owner のファイルにする | member |
| `GET /files/:id/export` | JSON (`serializeModel` と同じ整形)。`Content-Disposition` 付き | member |
| `GET /files/:id/snapshots` | 過去の状態 (1 時間ごとのスナップショット。3.4) のキーの一覧 `{ keys: string[] }` (`snapshot:<日時>`、新しい順) | owner |
| `GET /files/:id/snapshots/:key` | その時点の JSON (`export` と同じ形・`Content-Disposition` 付き)。キーが `snapshot:<1 時間単位の日時>` の形でない・無いときは 404 `snapshot_not_found`。キーの `:` は URL エンコードして渡す | owner |
| `DELETE /files/:id` | ゴミ箱へ | owner |
| `POST /files/:id/restore` | ゴミ箱から戻す | owner |
| `DELETE /files/:id/purge` | 完全に消す (Durable Object の `destroy`) | owner |
| `GET /files/trash` | ゴミ箱の一覧 | ログイン |
| `POST /files/:id/ticket` | ルームに接続するチケット (7.5) | member |
| `GET /files/:id/presence` | いまルームにつながっている人 `{ presence: { userId, name, role }[] }` (ルームの `presence()`。接続のチケットから決めた値で、ゲストは `userId: null`・名前は「ゲスト N」。同じ人が複数のタブなら複数並ぶ)。画面が awareness の自己申告を照らすのに使う。ゴミ箱の中のファイルは owner 以外は 404、owner には 409 | member |
| `PUT /files/:id/members/:userId` | 役割を足す・変える (`{ role: "editor" \| "viewer" }`)。応答は `Member`。相手がユーザーでなければ 404 `user_not_found` → 招待を使う。owner の役割は変えられない (409 `owner_role_fixed`)。**役割が実際に変わったとき**だけ、その人の接続を `kick({ userId, reason: "roleChanged" })` で切る (新しく足しただけ・同じ役割への PUT では切らない) | owner |
| `DELETE /files/:id/members/:userId` | 外す (204)。owner は owner 以外の誰でも外せる。editor / viewer は自分だけ (`can(role, "leave")`、他人は 403)。owner 自身は外せない (409 `transfer_first`)。相手がメンバーでなければ 404 `member_not_found`。外したら `kick({ userId, reason: "removed" })` | owner (自分なら member) |
| `POST /files/:id/transfer` | 所有者を譲る (`{ userId }`。相手はメンバー。メンバーでなければ 404 `member_not_found`、自分なら 409 `already_owner`)。1 つの `batch` で `files.owner_id` と両者の `file_members.role` を書き換え、元の所有者は editor になる。両者を `kick({ userId, reason: "roleChanged" })`。応答は譲った人から見た `FileSummary` | owner |
| `PUT /files/:id/link` | リンク閲覧を有効にする (`{ regenerate?: true }` で作り直す。本文は省略できる)。トークンが無いか `regenerate` なら新しいトークンを作り、`{ enabled: true, url }` (`url` = `${APP_ORIGIN}/#/link/<トークン>`) を返す。作り直したときは `kick({ via: "link" })`。すでに有効で `regenerate` でなければ何も変えず `{ enabled: true }` だけ (トークンは平文で持たないので URL は出せない) | owner |
| `DELETE /files/:id/link` | リンク閲覧を無効にする (204)。`link_token` を null にし、`kick({ via: "link" })` | owner |
| `POST /files/:id/invitations` | メールで招待する (`{ email, role: "editor" \| "viewer" }`。メールは小文字に正規化)。既にユーザーならその場で `file_members` に足し (すでにメンバーなら役割を更新し、**役割が変わったときだけ** `kick({ userId, reason: "roleChanged" })`。同じ役割での招待し直しでは切らない)、`200 { kind: "member", userId }`。まだユーザーでなければ `invitations` に行を作り (同じメールの未承諾の招待は置き換える)、`201 { kind: "invitation", invitationId, url }` (`url` = `${APP_ORIGIN}/#/invite/<トークン>`。メール送信は PoC では画面から写して送る)。自分 (owner) のメールは 409 `already_owner`。有効期間は 14 日 | owner |
| `DELETE /files/:id/invitations/:invitationId` | 招待を取り消す (204)。無ければ 404 `invitation_not_found` | owner |
| `GET /invitations/info` | 招待の中身 `{ fileName, role, email, inviterName, expired }`。トークンの SHA-256 で引く (無ければ・ゴミ箱の中のファイルなら 404 `invitation_not_found`)。ログイン中のメールと招待のメールが違えば 403 `email_mismatch` | ログイン |
| `POST /invitations/accept` | 招待を受ける。メールが一致するときだけ。`file_members` に足し (すでにメンバーなら役割は変えない)、`accepted_at` を書き、`{ fileId }`。受け終わった招待をもう一度受けても同じ結果 (冪等)。期限切れは 410 `invitation_expired`。受けたあとに外された人が古い招待で戻ろうとすると 410 `invitation_used`。**ログインしただけでは受理しない** (受ける画面で明示的に受ける) | ログイン |
| `GET /links/info` | `{ fileId, name, role }`。`role` はセッションがあってメンバーならその役割、それ以外は `guest`。セッションは**あれば読む・無くてもよい** (期限切れ・不正でも guest で通る)。トークンが無効・ゴミ箱の中は 404 `link_not_found` | リンク |
| `POST /links/ticket` | リンクで接続するチケット (3.6)。常に `via: "link"`。メンバーならその役割と `userId`、それ以外は `role: "guest"`・`userId: null`・`name: "ゲスト"` | リンク |
| `GET /links/presence` | `GET /files/:id/presence` と同じ。ゲストも読める。トークンが無効・ゴミ箱の中は 404 | リンク |
| `GET /links/export` | JSON に書き出す (`GET /files/:id/export` と同じ形)。セッション不要 | リンク |
| `POST /links/duplicate` | リンクのファイルを複製して、自分の owner のファイルにする (`201 FileSummary`。名前は「<元の名前> のコピー」)。**セッション必須** (未ログインは 401。ゲストは「複製するにはログイン」)。メンバーでなくてもよい。トークンが無効・ゴミ箱の中は 404 | ログイン + リンク |

**ゴミ箱の中のファイル**では、状態を変える共有の API (`PUT/DELETE /files/:id/members/:userId`、`POST /files/:id/transfer`、`POST/DELETE …/invitations`、`PUT/DELETE …/link`) と名前の変更 (`PATCH /files/:id`) は owner でも **409 `in_trash`** (戻してから変える。メンバーには他の API と同じく 404)。

**共有の kick**: D1 を書き換えたあとに呼び、失敗しても例外にせずログに出すだけで 2xx を返す (500 にすると再試行されず、接続が残るため)。再試行の経路で切るのは、外し済みの人への `DELETE` だけ (`kick` してから 404。前の呼び出しで `kick` に失敗していても、接続が残らない)。`PUT` と招待し直しは、**役割が実際に変わったとき**だけ `kick` する (上の表のとおり。同じ役割への呼び出しで切ると、開いている人の画面を無駄につなぎ直させる)。`putMemberRole`・`removeMember` は、そのメール宛の未承諾の招待も同じ `batch` で消す (外した人が残っていた招待で戻れないように)。`transferOwner` は「いま from が owner で to がメンバー」を update の条件に持ち、並行して抜けた・別の譲渡が通ったときは何も書かず 409 `conflict`。リンクの有効化は `update … where link_token is null` で書き、先を越されたら URL を返さない。

**既存ユーザーの招待**: すでにユーザーのメールを招待すると、その場でメンバーになり、応答の `kind` から「そのメールは登録済み」と分かる。相手の共有一覧にも承諾なしで入る (PoC として許容する)。招待は `ALLOWED_EMAIL_DOMAINS` を通り、許されないドメインは 400 `email_not_allowed`。

権限判定は `requireRole(fileId, "editor")` のようなミドルウェアで `file_members` を引き、`can(role, action)` で判定する。ゴミ箱の中のファイルは owner 以外は 404。`/links/*` は `POST /links/duplicate` を除いて `requireSession` を通さず (`apiRoutes` で `requireSession` より前にマウントする)、トークンの SHA-256 で `files.link_token` を引く (無ければ 404)。**リンク・招待のトークンはパスに置かず、ヘッダー `X-Untie-Token` で受ける** (`/links/info`・`/links/ticket`・`/links/presence`・`/links/export`・`/links/duplicate`・`/invitations/info`・`/invitations/accept`)。パスは Workers のログに残るため。画面のハッシュ URL (`/#/link/<token>`・`/#/invite/<token>`) はサーバーに届かないので、そのまま。ヘッダーが無い・空のときは、でたらめなトークンと同じく 404。応答には (404 などのエラーにも) `Cache-Control: no-store` を付ける。セッションは `Authorization: Bearer` (desktop のセッションだけ) か Cookie (web のセッションだけ) から読み、種類が違う・期限切れ・不正なものはエラーにせず guest として扱う。招待とリンクの URL の組み立てには `appOrigin` (`APP_ORIGIN` が空ならリクエストの origin) を使い、画面のルーティングに合わせてハッシュ (`/#/invite/…`、`/#/link/…`) にする (8.1)。

### 7.5 ルームへの接続

- ブラウザの WebSocket にはヘッダーを付けられないので、接続には **チケット** を使う: `POST /api/files/:id/ticket` (または `POST /api/links/ticket`) が `{ fileId, userId, name, role, via: "member" | "link", sid, jti, iat, exp: 60 秒 }` を `TICKET_SECRET` で署名した短い JWT を返し、クライアントは `wss://<host>/parties/untie-room/<fileId>?ticket=...` でつなぐ。Web もデスクトップも同じ。
- Worker 側は `routePartykitRequest(request, env, { locationHint: "apac", onBeforeConnect, onBeforeRequest })`。
  - `onBeforeConnect` は `?ticket=` を検める (署名・期限・形。`apps/server/src/auth/ticket.ts` の `verifyTicket`)。無効・無し・期限切れは **401** (`{ error: { code: "invalid_ticket", message } }`)。チケットの `fileId` と URL のルーム名が違えば **403**。通れば、受けた `x-untie-*` を**すべて上書きして** (クライアントが付けた値は信用しない。ゲストの `x-untie-user` は消す)、次のヘッダーを付けた Request をルームへ渡す。クエリの `ticket` はそのまま残す。**接続 id の `?_pk=` はクライアントに選ばせず、`crypto.randomUUID()` に必ず上書きする** (同じ id で 2 本つなぐと 1 本目が `getConnections()` から外れたまま書き込め、kick から逃れられるため)。
  - `onBeforeRequest` (WebSocket でない HTTP) は **401** (`code: "unauthenticated"`)。ルームへの HTTP は使わない。
  - 名前空間が `untie-room` 以外は 404 (7.6)。

| ヘッダー | 中身 |
| --- | --- |
| `x-untie-user` | ユーザー id。ゲスト (ログインしていないリンク閲覧) は付けない |
| `x-untie-name` | 表示名を `encodeURIComponent` したもの (日本語をヘッダーに載せるため) |
| `x-untie-role` | `owner` / `editor` / `viewer` / `guest` |
| `x-untie-via` | `member` / `link` |
| `x-untie-iat` | チケットの発行時刻 (エポックミリ秒)。取り消しの判定に使う |
| `x-untie-sid` | チケットを取ったセッションの id の先頭 16 文字。ログアウトの判定に使う。ゲストには付けない |
| `x-untie-jti` | チケットの識別子 (乱数)。1 回限りの判定に使う |
| `x-untie-exp` | チケットの期限 (エポックミリ秒)。使用済みの記録を残す期間 |

- ルームは `onConnect(connection, ctx)` で `ctx.request` のヘッダーを `connection.setState({ userId, name, role, via, sid })` (型は `ConnectionState`、`packages/collab/src/room/connectionState.ts`) に写し、最後に `super.onConnect` を呼ぶ。**ヘッダーが無い (`jti`・`exp`・`iat` を含む)・役割が知らない値・メンバー (`via: member`) なのに userId が無い**接続 (Worker を通らずに来た) は `close(4000, "認証されていません")` で閉じる。
- チケットの本文は `iat` (ミリ秒。秒に丸めると kick との前後が曖昧になる)・`exp` (JWT の決まりどおり秒)・`jti` (16 バイトの乱数)・`sid` (セッションの印。無ければ null) を持つ。検証は署名・期限に加えて、本文の形 (`role` が既知、`via: member` なら `userId` あり、`guest` なら `via: link`、`jti` あり) を見る。`TICKET_SECRET` は 32 文字以上で、短ければ発行は例外、検証は null。
- **チケットは 1 回しか使えない**: 盗み見られた (ログ・履歴・画面共有に残った) チケットでも、先に使われていれば通らない。ルームは `onConnect` で DO storage の `ticket:<jti>` を見て、**あれば `close(4000, "このチケットは使用済みです")`**、無ければ期限 (`exp`) までの記録として書く (期限を過ぎた記録は、記録のたびに消す。kick の記録と同じ)。Durable Object の input gate で直列になる (ストレージの読み書きの間に別の接続の処理は割り込めない) ので、同じチケットで同時に 2 本つないでも通るのは 1 本だけ。kick の記録で閉じる接続は、使用済みにしない (取り消しの判定が先)。**provider は再接続のたびに `params` でチケットを取り直す**ので影響しない (最初の接続だけが取ってあったチケットを使う。8.3)。取り直しに失敗して provider が古い params のまま再接続し、使用済みで閉じられても、画面はそれを閉じた扱いにせず (理由が「使用済み」の 4000)、次の再接続で新しいチケットを取る。
- **取り消し (kick) の記録**: チケットは 60 秒使い回せるので、kick で閉じたあとに同じチケットで古い役割のままつなぎ直されうる。ルームは kick のたびに `revoked:user:<userId>` / `revoked:sid:<sid>` / `revoked:link` / `revoked:all` に `{ at: Date.now(), code, reason }` を DO storage に記録し (5 分より古い記録は次の kick で消す)、`onConnect` で `iat <= at` のチケットの接続を、記録した code で閉じる (`super.onConnect` を呼ぶ前)。kick のあとにチケットを取り直した接続は通る。
- ゲスト (`role: "guest"`) の `name` は、チケットの値ではなくルームが「ゲスト 1」「ゲスト 2」のように振る。**いまつながっているゲストの番号と重ならない最小の番号**で、抜けた人の番号は次の人が使う (接続順の厳密な通し番号ではない)。
- 閉じるコード (`packages/api/src/protocol.ts` の定数。server と ui が共有する):

| コード | 定数 | 意味 | つなぎ直したとき |
| --- | --- | --- | --- |
| 4000 | `CLOSE_UNAUTHENTICATED` | 認証されていない (ヘッダーが無い)、ログアウトした (`kick({ sid })` / `kick({ userId, reason: "loggedOut" })`。理由「ログアウトしました」)、チケットが使用済み (理由「このチケットは使用済みです」) | 画面は理由を出してホームへ戻し、ログインの状態を取り直す (ログイン欄が出る)。ただし「使用済み」は閉じた扱いにせず、provider がチケットを取り直して再接続する |
| 4001 | `CLOSE_ROLE_CHANGED` | 役割が変わった (`kick({ userId })`) | チケットの取得で新しい役割になる |
| 4003 | `CLOSE_REMOVED` | メンバーから外された (`kick({ userId, reason: "removed" })`)、またはファイルがゴミ箱に入った (`kick({ all: true })`) | チケットの取得で 404 (外された) / 409 `in_trash` (ゴミ箱) |
| 4004 | `CLOSE_LINK_DISABLED` | リンクが無効になった (`kick({ via: "link" })`) | チケットの取得で 404 |

```ts
export class UntieRoom extends YServer<Env> {
  static callbackOptions = { debounceWait: 2000, debounceMaxWait: 10000 };

  async onLoad() {
    const saved = await this.ctx.storage.get<Uint8Array>("ydoc");
    if (saved) Y.applyUpdate(this.document, saved);
    this.document.on("update", (_u, origin) => { if (origin !== "repair") this.scheduleRepair(); });
  }
  async onSave() {
    repairDoc(this.document, "repair");                       // 壊れた参照の修復と文字列の切り詰め。changes は id・件数だけを console.log に出す
    const model = rebuildModel(this.document);
    if (!validateModel(model).ok) { this.broadcastCustomMessage(SAVE_FAILED_MESSAGE); return; }   // 直前の正常な ydoc / snapshot を残す
    try {
      await this.keepHourlySnapshot(previous);
      await this.ctx.storage.put("ydoc", Y.encodeStateAsUpdate(this.document));
      await this.ctx.storage.put("snapshot", model);
    } catch (e) { console.error(…); this.broadcastCustomMessage(SAVE_FAILED_MESSAGE); return; }   // DO の 1 つの値の上限など
    if (this.saveFailed) this.broadcastCustomMessage(SAVE_OK_MESSAGE);    // 直って保存できた (D1 の更新より先に知らせる)
    try { await this.env.DB.prepare("update files set name = ?, updated_at = ? where id = ?").bind(model.meta.name, Date.now(), this.name).run(); }
    catch (e) { console.error(…); }                                       // 一覧の写しの失敗は、記録だけして続ける（中身は保存済み）
  }
  onConnect(connection, ctx) {
    // ヘッダー → connection.setState。無ければ close(4000)。kick の記録・使用済みチケットなら close。guest は「ゲスト N」を振る。最後に super.onConnect
    // 保存が失敗したままなら sendCustomMessage(connection, SAVE_FAILED_MESSAGE) で、あとから入った人にも知らせる
  }
  isReadOnly(connection) { return !(role === "owner" || role === "editor"); }  // y-partyserver が step2 / update を捨てる
  // RPC (Worker から getServerByName で呼ぶ)
  async importModel(model: UntieModel) { loadModel(this.document, model); await this.onSave(); }
  async exportModel(): Promise<UntieModel> { ... }
  async rename(name: string) { this.document.getMap("meta").set("name", name); }
  async destroy() { await this.ctx.storage.deleteAll(); }
  async currentModel(): Promise<UntieModel> { return rebuildModel(this.document); }  // 保存を待たずにメモリ上の中身を読む
  async kick(target: { userId: string; reason?: "roleChanged" | "removed" | "loggedOut" } | { sid: string } | { via: "link" } | { all: true }): Promise<number> { ... }   // 閉じた接続の数
  async presence(): Promise<{ userId: string | null; name: string; role: Role }[]> { ... }
}
```

- `isReadOnly` は `y-partyserver` (2.2.0) に組み込みの仕組みで、`true` の接続からの sync step2 と update を捨てる (step1 への返事と awareness は通る)。`onMessage` の上書きや `isDocWrite` は要らない。UntieRoom は接続の `state.role` が **owner / editor 以外ならすべて読み取り専用**にする (viewer・guest のほか、役割が無い・知らない役割の接続も)。awareness は viewer も送れる (選択が他の人に見える)。
- `hibernate` は付けない (awareness の状態をメモリに持つため)。誰もいなくなれば Durable Object は自然に落ち、次の接続で `onLoad` する。
- 不正な update はサーバーで個別に検査できない。守りは認証・役割・`repairModel` (文字列の長すぎるものは切り詰めて直るので、これが原因で保存できなくなることはない)。それでも `onSave` で `validateModel` に通らなければ、直前の正常な `ydoc` を残して `console.error` に記録し (検証エラーの文言に含まれる名前は「…」に伏せる)、**`broadcastCustomMessage(JSON.stringify({ type: "save_failed" }))` でつながっている全員に知らせる**。`onSave` の `put` が失敗した (DO の 1 つの値の上限など) ときも同じ。保存できなくなっている間に入った人にも、`onConnect` が `save_failed` を送る。通るようになって保存できたら `{ type: "save_ok" }` を流す。画面は 8.3。
- `kick` の対象と閉じるコード: `{ userId }` (役割が変わった。`4001 "役割が変わりました"`)、`{ userId, reason: "removed" }` (メンバーから外した。`4003 "共有から外されました"`)、`{ userId, reason: "loggedOut" }` (すべての端末からログアウトした。`4000 "ログアウトしました"`)、`{ sid }` (そのセッションがログアウトした。そのセッションで取ったチケットの接続だけを `4000 "ログアウトしました"` で閉じる)、`{ via: "link" }` (リンク閲覧を無効にした・作り直した。ゲストと、リンクから開いたメンバーを `4004 "リンクが無効になりました"` で閉じる)、`{ all: true }` (ファイルをゴミ箱に入れた。全員を `4003 "ファイルがゴミ箱に入りました"` で閉じる)。`userId` は空でない文字列でなければならない (null でゲストを巻き込まない)。**不正な対象は Worker 側の `kickRoom` (`apps/server/src/rooms.ts`) で弾いて例外にする。ルームは警告を出して 0 を返す** (RPC の中で投げるとテスト基盤が未処理の拒否として数えるため)。どれも閉じた数を返し、取り消しの記録を残す (上記)。つなぎ直すとチケットの取得で新しい役割になる (外された・リンクなら 404、ゴミ箱なら 409)。
- **ログアウトで閉じるのは最大 40 ファイルまで**: `kickRoomsOfUser` は同時に 10 件までのセマフォで送り (`KICK_CONCURRENCY`)、1 回のリクエストで送るのは 40 ファイルまで (`MAX_KICK_ROOMS`。サブリクエストの上限に収めるため)。それ以上は件数をログに出して諦める。残った接続は、つなぎ直すときのチケットの取得 (401) で止まる。D1 から対象を引くところから失敗しても、セッションは消えているので、ログに残して Cookie を消し 204 を返す (7.2)。
- **呼ぶ側**: `DELETE /api/files/:id` (ゴミ箱に入れる) は `kick({ all: true })` を呼ぶ。役割が**実際に変わった**とき (`PUT /members/:userId`、`POST /invitations` が既存メンバーの役割を変えたとき)・譲渡 (両者)・メンバーを外す・リンクの無効化と作り直し・ログアウト (7.2) からも呼ぶ (7.4)。DB を書き換えたあとに `kickRoom` を呼ぶので、つなぎ直しは新しい状態で判定される。
- `presence()` はいまつながっている接続の `{ userId, name, role }` の一覧 (同じ人が複数のタブなら、その数だけ出る)。`currentModel()` は保存を待たず、メモリ上の Y.Doc からモデルを作る (テストと確認用)。プレゼンスの表示そのもの (カーソル・選択) は awareness で運ぶ。

### 7.6 エラーの形と細部

- **エラー**: `/api` の失敗はすべて `{ "error": { "code": "...", "message": "..." } }` (message は画面にそのまま出せる日本語)。`packages/api` の `ApiError` がこれを `status`・`code`・`message` で投げる。想定外の例外は `500`・`code: "internal"` で、内容はログにだけ出す。主な `code` (共有まわりの追加分も含む): `unauthenticated` / `session_expired` (401)、`csrf` / `forbidden` / `email_mismatch` (403。招待のメールが自分のと違う)、`file_not_found` / `not_found` / `user_not_found` (メンバーにする相手がユーザーでない) / `member_not_found` (外す・譲る相手がメンバーでない) / `invitation_not_found` / `link_not_found` (404)、`invalid_request` / `invalid_model` / `email_not_allowed` (400。招待のメールのドメインが `ALLOWED_EMAIL_DOMAINS` にない)、`not_in_trash` / `in_trash` / `broken_model` (409。複製元の中身が検証に通らないとき) / `transfer_first` (owner を外そうとした) / `owner_role_fixed` (owner の役割を変えようとした) / `in_trash` (ゴミ箱の中のファイルの共有を変えようとした) / `conflict` (譲渡が並行した操作と重なった) / `already_owner` (自分を招待・自分に譲ろうとした。owner のメールを招待したとき)、`invitation_expired` / `invitation_used` (410。招待の期限切れ・受けたあとに外された人が古い招待を使った)、`too_large` (413。`limitBody` を通る API の本文は **1 MB まで**。モデルの大きさの上限。3.4)、`snapshot_not_found` (404。過去の状態のキーが無い)、`misconfigured` (503。秘密の値が足りない。7.1)。
- **ブラウザが直接開く `/auth/login`・`/auth/callback`・`/auth/dev` の失敗**は JSON ではなく、戻るリンク付きの小さな HTML で返す。
- **ログアウトは `/auth` の下**: `POST /auth/logout`、`POST /auth/logout-all`。`logout` はセッションが無くても成功し (204)、Cookie を消す。Cookie 認証なら `X-Requested-With` が要る。どちらも、そのセッション (またはユーザー) で開いているルームの接続を閉じる (7.2)。
- **レスポンス**: `POST /files` と `POST /files/:id/duplicate` は `201` と `FileSummary`。`PATCH /files/:id` と `POST /files/:id/restore` は `200` と `FileSummary`。`DELETE /files/:id` と `DELETE /files/:id/purge` は `204`。`GET /files/trash` は `{ files: FileSummary[] }`。`GET /files/:id` は `FileDetail` で、`members`・`invitations`・`link` は owner だけが受け取る。`PUT /files/:id/members/:userId` は `200` と `Member`、`POST /files/:id/transfer` は `200` と `FileSummary`、`DELETE …/members/:userId`・`DELETE …/invitations/:invitationId`・`DELETE …/link` は `204`。
- **完全削除はゴミ箱の中のファイルだけ**: ゴミ箱に入っていないファイルへの `purge` は `409 not_in_trash`。
- **開発用ログイン**: `DEV_LOGIN=true` で、かつリクエストのホストが localhost / 127.0.0.1 のときだけ `GET/POST /auth/dev` (メールと名前のフォーム) と `providers` の `dev` が有効。`false` なら `/auth/dev` は 404。ドメイン制限 (`ALLOWED_EMAIL_DOMAINS`) は Google と共通の `isEmailAllowed` を通る。
- **`untie_auth` Cookie** (OIDC の `state`・`nonce`・`code_verifier`・戻り先。デスクトップなら `client: "desktop"` と `appState` も。開発用ログインは `state` 以外が空) は `Path=/auth`、10 分、`SESSION_SECRET` の HMAC 署名付き。戻り先 (`return`) は `#` で始まる相対のものだけ受ける。
- **`/parties/*`**: 7.5 のとおり。`/parties/untie-room/<id>` は WebSocket だけを受け、チケットが無効なら 401 (`invalid_ticket`)、別のファイルのチケットなら 403、HTTP は 401。`untie-room` 以外の名前空間は JSON の 404。
- **`POST /files/:id/ticket`**: `requireRole(..., "read")` を通り、`{ ticket, role, expiresAt }` (`TicketResponse`) を返す。`name` はユーザーの表示名。ゴミ箱の中のファイルは owner 以外は 404 (他の API と同じ)、owner には 409 `in_trash` (ゴミ箱の中のファイルは開けない。戻せば出る)。`name` が空ならメールアドレスの `@` より前 (メールアドレスそのものは他のメンバーに見せない)。

## 8. クライアント

### 8.1 画面の流れ

```
起動 ─> ホーム (ファイル一覧)            … ログイン済みならクラウドファイルの一覧。未ログインなら「ログイン」と「ローカルファイルを開く」
         ├ クラウドファイルを開く ─> エディタ (接続中)  … 役割が viewer なら閲覧専用の帯を出す
         ├ ローカルファイルを開く ─> エディタ (従来どおり)
         ├ 新規作成 ─> クラウド (ログイン済み) / ローカル
         └ ローカルファイルをクラウドへ (POST /files に model を送る)
エディタ ─ ツールバー左の「ホーム」でファイル一覧へ戻る。アカウントメニュー (名前・ログアウト) はホームの右上に置き、エディタには出さない (ホームのアカウントメニューで代える)
```

**ルート** (`packages/ui/src/router.ts`)。ハッシュで画面を分ける。サーバーには `#` の後ろが届かないので、どの URL も同じ `index.html` を返せばよい。サーバーが作る招待・リンクの URL は `/#/invite/<token>`・`/#/link/<token>` にする (`/invite/...` では開けない)。

| ハッシュ | 画面 |
| --- | --- |
| `#/` | ホーム。空や、読めないハッシュもここ。起動時にハッシュが無ければ `#/` にする |
| `#/local` | ローカル編集 (従来のエディタ) |
| `#/f/<fileId>` | クラウドファイル (`CloudEditor`。同時編集) |
| `#/invite/<token>` | 招待を受ける (`InvitePage`) |
| `#/link/<token>` | リンクで開く (`CloudEditor` に `link` を渡す) |

`fileId`・`token` は `/^[A-Za-z0-9_-]{1,64}$/` に合うものだけ受け、合わなければホームにする。

**ログインを挟むときのトークン**: 招待・リンクのトークンをログインの URL (`/auth/login?return=...`) に載せるとサーバーのログに残る。`session.login` は戻り先が `#/invite/<t>`・`#/link/<t>` なら、トークンを `sessionStorage` (`untie.pendingInvite` / `untie.pendingLink`) に預け、`Platform.login` には `#/invite`・`#/link` (トークンなし) だけを渡す。戻ってきた `Root` が最初の描画の前に預けたトークンを読んで消し、`location.replace` で `#/invite/<t>`・`#/link/<t>` に直す (履歴に積まない)。預けたものが無ければホームが出る。

| 場所 | 内容 |
| --- | --- |
| ホーム | 「自分のファイル」「共有されたファイル」「ゴミ箱」のタブ。名前・更新日時・役割・メンバー。行の操作: 開く、名前を変える、複製、書き出す、共有 (owner だけ)、共有をやめる (共有されたファイルの行。editor / viewer。確認のあと自分をメンバーから外す)、ゴミ箱へ。「最近開いたローカルファイル」もここに並べる |
| ログイン | 「Google でログイン」のボタン。デスクトップは「ブラウザでログインしています…」の待ち画面と、deep link が使えないときの引換コードの入力欄 |
| 共有ダイアログ | `ShareDialog` (`role="dialog"`、`aria-labelledby`、Escape で閉じる、Tab はダイアログの中を回る)。owner だけ開ける: ホームの行の「共有」とエディタ (クラウド) のツールバーの「共有」から開き、所有者でなくなったら (譲った) 閉じる。`files.get(id)` の `FileDetail` を出し、変更のたびに取り直してホームの一覧も更新する。操作中は他の操作を受けない (二重押しを防ぐ)。失敗は `ApiError.message` をトーストに出す。**メンバー**: 名前・メール・役割の選択 (編集者 / 閲覧者。所有者は固定表示)・「外す」(確認なし)、所有者を譲る相手を選んで「所有者を譲る…」→ 確認 → `transfer` (譲ったらダイアログを閉じる。元の所有者は editor になり、開いていれば 4001 でつなぎ直す)。**招待**: メールと役割 → `invitations.create`。`kind: "member"` なら「〜さんをメンバーに加えました」(その場の文言)、`kind: "invitation"` なら招待リンクの入力欄と「リンクを写す」、その下に未承諾の招待 (メール・役割・期限。期限切れは「期限切れ」と出す) と「取り消す」。**リンクで閲覧**: 「リンクを知っている人が閲覧できる」のスイッチ (`role="switch"`)。有効にすると URL と「リンクを写す」を出す。すでに有効で URL が無い (開き直したあと。サーバーはトークンを持たない) ときは「リンクを作り直す」(確認: 古いリンクは使えなくなる) で新しい URL を出す。無効にするときも確認する。**過去の状態**: 1 時間ごとのスナップショット (3.4) を新しい順に「2026-10-31 19:00 の状態」と並べ、行ごとの「書き出す」で `GET /files/:id/snapshots/:key` の JSON を `platform.saveTextFile` で保存する (JSON の書き出しと同じ流れ。中身はサーバーが返したまま。ファイル名は「<名前> <日時>.json」)。一覧が読めなくても共有の設定は使える (その節にだけ理由を出す) |
| 招待を受ける画面 | `#/invite/<token>` (`InvitePage`)。ログインの状態が分かるまで「確認中」、未ログインなら「招待を受けるにはログインしてください」とログイン欄 (ログイン後はこの画面に戻る)、ログイン済みなら `invitations.get` で「〜さんから「ファイル名」に役割として招待されています」と「受ける」「やめる」。受けたら `#/f/<fileId>` へ移る。「期限切れ」(`expired` が true か 410 `invitation_expired`)・「すでに使われています」(410 `invitation_used`)・「別のメールアドレス宛です (いまのログイン: …)」(403 `email_mismatch`)・「見つかりません」(404) は文言を出して「ホームへ」だけ置く |
| リンクで開く画面 | `#/link/<token>`。ログインの状態が分かったら、`links.get` でファイルを引いて `openCloudFile(fileId, { link })` でそのままエディタ (閲覧専用) を開く。ログインしていなくてもホームへは戻さない。上の帯に「リンクで閲覧中。ログインすると複製できます」とログインの導線 (ログイン後はこのリンクへ戻る)。ログイン済みでメンバーでなければ「複製して自分のファイルにする」(`links.duplicate` → 複製したファイルへ)。ログイン済みでメンバー (所有者を含む) なら、`links.get` の役割が `guest` でないので `#/f/<fileId>` に `location.replace` で置き換え、`files.ticket` で開く (`via: "link"` にしない。リンクの無効化で切られず、アドレスバーからトークンも消える)。無効なリンク (`links.get` かチケットが 404) は「このリンクは無効です」を出してホームへ |
| エディタ (クラウド) | ツールバーのタイトルの横に接続状態 (接続中 / 切断。再接続します)、役割、参加者の色玉 (title に名前。同じ人の複数のタブは 1 つ。ゲストは接続 id から決めた色)。viewer と guest は上に「閲覧専用です (役割: …)」の帯 (`role="status"`)。Undo / Redo は無効 (title「共有中は取り消せません」)。Cmd/Ctrl+S は書き出し。ファイルメニューは「ホーム」「JSON に書き出す」「クラウドへ保存 (複製)」だけ |
| カード・固定ボード | 他の人の選択を色付きの縁で出す (awareness) |
| プロパティ欄 | 他の人が同じ要素を**選んでいる**なら、要素の種類の横に「○○さんも選択中」を出す (awareness は選択しか運ばないので「編集中」とは言わない。ロックはしない)。viewer は入力欄をすべて読み取り専用にし、追加・削除・移動・関係のボタンを出さない |
| AI の設定 | 従来どおり各自の API キー (キーチェーン / localStorage)。viewer はエージェントを開けない (質問だけ許す案は 12 章の「あとで」) |

### 8.2 ストア

- `session` ストア (`packages/ui/src/cloud/session.ts`): `status: "unknown" | "anonymous" | "signedIn"`、`user`、`providers: ProviderId[]` (`GET /auth/providers`)、`hasServer` (`Platform.serverOrigin()` が空でないか。空なら API を呼ばず anonymous)、`error` (つながらない・ログイン方法を取れない、など)。起動時に `Root` が `load()` を呼び、`GET /auth/providers` と `GET /api/me` で決める (実行中に重ねて呼んでも 1 回だけ叩く)。`/api/me` が 401 なら anonymous で、失敗ではない。
- **401 の扱い**: 使っている途中の 401 (セッション切れ・別の端末でのログアウト) は `cloud/api.ts` の `onUnauthorized` 1 か所で受ける。`session` が anonymous に戻して「ログインの有効期限が切れました」を出し、`files` が一覧を空にする (両者は互いを import せず、この購読口だけでつながる)。`logout` / `logoutAll` は 401 を成功とみなして手元の状態を消す。
- `files` ストア (`cloud/files.ts`): `mine` / `shared` / `trash` / `loading` / `loaded` / `error` と、`refresh`・`create`・`rename`・`duplicate`・`exportToFile`・`trashFile`・`restore`・`purge`・`leave` (共有をやめる)・`duplicateFromLink` (リンクのファイルを複製)。操作の失敗は `ApiError.message` をそのままトーストに出す。書き出しは `files.export` で JSON を取って `parseModel` で検めてから `Platform.saveTextFile` へ渡す (ダウンロード URL は使わない。デスクトップでも動く)。モデルの名前が空なら「名前なし」にして送る。
- ローカルの編集 (ホーム画面まわり): ツールバーの「ホーム」は、未保存の変更があれば `confirmDiscard` で確かめ、破棄すると決めたら編集中のモデルを起動時のサンプル (未変更) に戻し、走っている AI エージェントを止めてから `#/` へ移る。`openDocument` / `openRecentDocument` は開けたら `true` を返す (ホームが `#/local` へ移るかの判定に使う)。閉じる前の確認 (`useCloseGuard`) は `Root` に置き、ホームでも効く。
- **`cloud: CloudInfo | null`** (`{ fileId, role, doc: Y.Doc, status: "loading" | "connecting" | "connected" | "offline", closed?: { code, reason }, link?: string, dirtySinceOffline: boolean, saveFailed: boolean }`)。ローカルなら null。当初の案の `document: { kind: "local" | "cloud" }` で `file` を包む形にはせず、従来の `file` / `savedModel` / `history` はそのまま、`cloud` を足すだけにした (ローカルのコードに触れない)。`status` は最初の同期が済むまで `loading`。他に `peers: Peer[]` (`{ clientId, userId, name, color, boardId, selection }`、自分を除く) と `pendingRemote` (ドラッグ中に届いた変更を後回しにしているか)。
- 関数: `loadCloudDocument(model, cloud, { keepUi? })` (履歴・選択・ドラッグを捨てて開いた状態にする。`keepUi` = `{ currentBoardId, selection }` があれば、役割が変わったつなぎ直しでそれを引き継ぐ。8.3)、`setCloudStatus` / `setCloudRole` / `setCloudClosed` / `setCloudSaveFailed` / `setPeers`、`applyRemoteModel(model)`、`closeCloud()` (起動時のサンプル・未変更に戻す。クラウドを開いていなければ何もしない。ローカルの編集中のモデルを壊さないため)。`newDocument` / `loadDocument` も `cloud` を外す。
- **書き込みの経路**: `dispatch` / `commitDrag` / `agentApply` は、`cloud` があれば結果を `applyModelDiff(doc, before, after, LOCAL_ORIGIN)` で Doc に書き、そのあと **`model = rebuildModel(doc, after)`** にする (Doc が正本。他の人の変更との合流、消した側が勝つ規則はここで揃う)。`history` には積まず、`endAgentEdit` も履歴を積まない。`previewNode` / `previewCommand` は Doc に書かない (表示だけ)。`commitDrag` が書くのは `dragBase` と確定後の差だけなので、ドラッグ中に届いた他の人の変更は消さない。
- **リモートの変更**: `attachCloudDoc` が `observeModelChanges` で `LOCAL_ORIGIN` 以外の変更を受け、`rebuildModel(doc, store.model)` を `applyRemoteModel` に渡す。ドラッグ中 (`dragBase` が非 null) は `pendingRemote` を立てて後回しにし (組み立て直しもしない)、`commitDrag` / `cancelDrag` が Doc から組み立て直す。`dispatch` はドラッグ中なら先に `commitDrag` するので、`before` が Doc とずれない (消えたものの復活を防ぐ。6 章)。AI エージェントの編集中 (`agentBase`) は後回しにせず、そのまま反映する。部分的な組み立て直し (`changed` の id だけ) はしない: 届く id と変わる範囲が一致しないため (6 章)。構造共有で変わった分だけが新しい参照になる。
- **閲覧専用**: セレクタ `selectReadOnly` (`cloud && !can(cloud.role, "edit")`)。`dispatch` / `agentApply` は `{ ok: false, reason: "閲覧専用です" }` を返し、`previewNode` / `previewCommand` / `commitDrag` / `beginAgentEdit` は何もしない。画面は `useUntieStore(selectReadOnly)` で出し分ける (入力欄の `readOnly`、追加・削除・移動・関係のボタンを出さない、キャンバスの `nodesDraggable` を切る、AI のボタンとペインを出さない)。選ぶことはできる。
- **Undo / Redo**: `cloud` があれば `undo` / `redo` は何もしない。
- **`hasUnsavedChanges`**: `cloud` があれば `cloud.status !== "connected" && cloud.dirtySinceOffline`。`dirtySinceOffline` は、つながっていない間 (`connected` でない間) に自分の書き込み (`dispatch` / `commitDrag` / `agentApply`) があると立ち、同期が済んで `connected` になると戻る。
- **役割が変わったとき** (`setCloudRole`): 閲覧専用になったら、途中のドラッグ (`cancelDrag`) と AI の編集を捨てる。閲覧専用のときの `commitDrag` も、`dragBase` を残さずドラッグを捨てる。
- 画面の `can(role, action)` は `cloud.role` から引く。ローカルは常に owner 相当。リンクで開いたときは `cloud.link: token` を持ち、チケットを `links.ticket` で取る (再接続のたびも同じ)。書き出しは手元のモデルから行うので `links.export` は使わない。
- `session.status === "anonymous"` でもリンクのファイルは開ける。ホームは未ログインならログインとローカルファイルだけ出す。`#/f/<id>` は、未ログインならホームへ戻して「クラウドのファイルを開くにはログインしてください」を出す。
- クラウドファイルを開くと、ローカルの編集中のモデルはストアから置き換わる (戻るとサンプル)。そのため `CloudEditor` が、開く前に保存していない変更があれば `confirmDiscardIfDirty` で確かめ、断られたら `#/local` へ戻す (ホームの「開く」だけでなく、戻る/進む・URL の直打ちで来たときも守る)。開発モード (StrictMode) は effect を 2 回走らせるので、確認中の答え (Promise) を `useRef` に持ち、2 回目は新しく聞かずにその答えを待つ (確認ダイアログが 2 回出ない)。

### 8.3 接続

実装は `packages/ui/src/cloud/collab.ts`。provider に依存しない中核 (`attachCloudDoc(doc, { fileId, role, link? })`: ストアへの取り付けと、リモートの変更の反映。戻り値の `detach()`) と、その外側 (`openCloudFile(fileId)` / `closeCloudFile()`: チケット・`YProvider`・接続の状態・プレゼンス) に分けてある。テストは中核に 2 つの Y.Doc をつなぎ、外側は偽の provider で確かめる。

- `openCloudFile(fileId, { link? })` は先に `files.ticket(id)` (`link` があれば `links.ticket(link)`) を取り (401/403/404/409 ならその `ApiError` を投げる。何も付けない)、`new YProvider(host, fileId, doc, { party: "untie-room", protocol, disableBc: true, connect: false, params })` をつなぐ。`host` / `protocol` は `Platform.serverOrigin()` から決める。`params` は最初の 1 回は取ったチケットを使い、**再接続のたびに取り直す** (チケットは 60 秒で切れる)。取り直したチケットの `role` が変わっていたら、ストアの役割を更新する (切れている間に viewer から editor になった、など)。開く途中で `closeCloudFile()` や別の `openCloudFile()` が呼ばれたら、世代の番号で古い方が何も付けずに戻る (React の StrictMode でも二重につながない)。
- **接続の状態** (`cloud.status`): 最初の同期 (`sync` が true) までは `loading` (画面は「読み込み中…」。Doc が空のまま編集させない。15 秒たっても終わらなければ「サーバーにつながっていません」を添える)。以後は `status` イベントを写す: `disconnected` → `offline`、`connecting` → `connecting`、`connected` → 同期が済むまでは `connecting`、`sync` → `connected`。
- **閉じられたとき**: `connection-close` イベントの `code` が 4000〜4004 なら、再接続せず (`provider.disconnect()`)、`cloud.closed = { code, reason }` にする (`reason` はサーバーが付けた理由。空なら画面側の `CLOSE_REASONS`: 4000「認証されていません。ログインし直してください」、4001「役割が変わりました。開き直してください」、4003「共有から外されたか、ファイルがゴミ箱に入りました」、4004「リンクが無効になりました」)。`CloudEditor` が `closed` を見て、理由をトーストに出してホームへ戻す (4001 は下)。再接続のチケットの取得が 401/403/404/409 だった場合 (切れている間に外された・ゴミ箱に入った、など) も、同じく `closed` にして再接続しない。**4001 (役割が変わった) だけは、ホームへ戻さずその場でつなぎ直す**: `CloudEditor` が `openCloudFile` をもう一度呼んで (リンクで開いていれば `link` も付けて) 新しい役割で開き直す。トースト「役割が〜に変わりました」は、**役割が実際に変わったときだけ**出す。つなぎ直しに失敗した (外された・リンクが無効になった、など) ときは、開くときと同じ扱いでホームへ戻す。開き直す間は「読み込み中…」になるが、**開いているボード (`currentBoardId`) と選択 (`selection`) は引き継ぐ**: つなぎ直す前にストアから控え、`openCloudFile(id, { keepUi })` → `loadCloudDocument(model, cloud, { keepUi })` が新しい状態に入れる。つなぎ直した直後の Doc はまだ空なので、参照先 (自由ボード・要素) が無くても外さない。最初の同期で中身が届いたとき、`reconcileUi` が無いボード・要素だけを直す (ほかの画面の状態は初期に戻る)。**つなぎ直しは古い Y.Doc を捨てて新しい Doc で始めるので、古い Doc にあって送りきれていなかった更新 (つながっていない間の自分の変更など) は失われる**。そのため `dirtySinceOffline` が立っていれば、つなぎ直す前に確認を出す: 「送れていない変更があります。JSON に書き出しますか」(「書き出す」= `exportModelToFile` で書き出してからつなぎ直す。取り消した・失敗したときは聞き直す / 「捨てて続ける」= そのままつなぎ直す)。**4000 (ログアウト・認証切れ) は、理由を出してホームへ戻し、ログインの状態を取り直す** (ログイン欄が出る)。ただし理由が「このチケットは使用済みです」の 4000 は、provider が再接続のたびに取り直すチケットが重なったときに起きうるだけなので、閉じた扱いにせず provider の再接続に任せる (7.5)。
- **保存できていないとき**: provider の `custom-message` イベント (`y-partyserver` の `broadcastCustomMessage` の受け口。本文は `__YPS:` を除いた文字列) で `{ type: "save_failed" }` を受けたら `cloud.saveFailed = true` にし、`App` が帯「サーバーに保存できていません。JSON に書き出して保存してください」(`role="alert"`。閲覧者にも出す) を出す。`{ type: "save_ok" }` で消す。つながっていない間 (`disconnected`) も消す (つなぎ直したとき、まだ保存できなければサーバーがもう一度知らせる)。知らない・壊れた知らせは無視する。
- **接続の状態は切れたら戻らない**: 一度 `offline` になったら、`connected` かつ同期済みになるまで、再接続を試している `connecting` も `offline` として扱う (再接続に失敗し続けても「接続しています」と出さない)。
- **ログイン中に開く前から走っていた AI** を止める: `openCloudFile` の先頭で `useAgentStore.getState().cancel()` を呼ぶ。止め損ねても、クラウドの `agentApply` は `beginAgentEdit` の間にしか書けず、開くと `agentBase` は捨てられる。
- **チケットは再接続のたびに取り直す**: `params` は最初の 1 回だけ取ってあったチケットを返し、2 回目からは API で取り直す。チケットは 1 回しか使えないので (7.5)、同じチケットでは二度つながない。
- **途中で失敗したとき**: `openCloudFile` が attach のあとで例外になったら、provider を `destroy` し、`detach()` と `doc.destroy()` をしてから投げる (ストアに `cloud` を残さない)。
- **取れなかったとき**: チケットが 401 ならホーム (ログイン欄)、403/404 ならホームへ戻して「このファイルは開けません」、409 なら「ゴミ箱の中のファイルです」。
- つながっていない間の編集は手元の Y.Doc に溜まり、つながると合流する。ただし**タブを閉じると失われる**ので、`hasUnsavedChanges` (8.2) が true の間は、閉じる前の確認 (`useCloseGuard`) と、ツールバーの「ホーム」の確認 (「つながっていない間の変更はまだ送れていません」) を出す。「つながっていません。変更は接続後に反映されます」の長期の帯 (10 分など) は**入れていない** (ツールバーの「切断。再接続します」だけ。12.2)。
- **プレゼンス**: `awareness.setLocalState({ userId, name, color, boardId, selection })`。ゲスト (取ったチケットの役割が `guest`。ログインしていても同じ) は `userId: null`・`name: "ゲスト"` を自分で載せる (サーバーが付ける「ゲスト n」の番号は使わない)。`color` はユーザー id (ゲストは awareness の clientId) の FNV-1a ハッシュで 8 色から決める。ストアの `ui.currentBoardId` と `ui.selection` を購読して `setLocalStateField` で更新する。`awareness.on("change")` で `peers` を組み立てる (自分を除く)。**自分の別のタブ** (`userId` が同じ) は他の人として数えず、`peers`・色玉・「〜さんも選択中」から除く (ゲストは `userId` が無いので clientId で区別する)。自分の状態だけが変わった `change` では組み立て直さず、前の `peers` と比べて変わっていなければ `setPeers` しない (変わっていない人の参照は使い回す)。カードは `usePeersSelecting(elementId)` (その要素の結果だけを返し、`useShallow` で比べる) を読むので、自分が選ぶたびに全カードが描き直されることはない。**プレゼンスは偽れる**: awareness はクライアントが書く値で、サーバーは中身を検めない (`userId` や名前を他人に見せかけることができる)。そこで画面は、サーバーの `presence()` (接続のチケットから決めた `userId`・名前・役割。`GET /files/:id/presence`、リンクなら `GET /links/presence`) の一覧と照らして表示する: `attachPresence` の `verify` が一覧を取り、awareness の `userId` が一覧に無い人は「ゲスト」扱い (名前も `userId` も自己申告を捨てる)、ある人の名前はサーバーの値を使う。ゲストの「ゲスト N」の番号は awareness の clientId と結べないので、画面には出さず「ゲスト」とだけ出す。取るのは接続の直後と、他の人の顔ぶれ (clientId・`userId`・名前) が変わったとき (選択が変わっただけでは取らない)。取り直しは 1 秒に 1 回まで (先頭は待たずに取り、間が短ければ 1 秒空ける)。最初の一覧が届くまで、また一覧を取ったあとに来た人は、次の一覧が届くまで自己申告のまま出す (本物の参加者が一瞬ゲストに見えないように。偽りが見えるのはその間だけ)。一覧に載らない `userId` の人がいれば、載るのを待って最大 3 回取り直す。取れなかったときは前の一覧のまま。権限には使わない (見た目の補助)。他の人の状態は信用せず、形を確かめて作る (色は `#rrggbb` だけ受け、外れたら決め直す。選択は形が違えば外す)。表示は同じボードにいる人 (`peer.boardId === 開いているボード`) の選択だけ: 自由ボードのカード・枠と固定ボードのカード・枠に、その人の色の 2px の縁 (複数なら 2px ずつ外へ重ねる) と、右上に名前のラベルを出す。

### 8.4 デスクトップ固有

- **サーバーの URL**: 既定は無く (未設定のとき、クラウドの機能は使えない)、ホームの「サーバーの設定」(`platform.kind === "desktop"` のときだけ) で入れる。`localStorage` の `untie.serverOrigin` にオリジンだけを置く。設定のとき (`parseServerOrigin`) に検める: **`https:` の URL か、開発用の `http://localhost`・`http://127.0.0.1` だけ**。パス (末尾のスラッシュ以外)・クエリ・ハッシュ・ユーザー名・パスワードつきは拒む。読むときは手で書き換えた値でも使えるよう、http(s) のオリジンに直す。**変えたらログアウトする**: `setServerOrigin` は検めたあと、キーチェーンの `session` と始めたログインの記録を消してから URL を保存する (消せなければ URL も変えない。古いトークンを別のサーバーに送らない)。画面は、オリジンが変わらなければ何もせず、変わるときはログイン中なら先に (いまのサーバーで) `logout` を試し (失敗しても進める)、`setServerOrigin` のあと `session.load()` する。未設定のログイン欄には「サーバーを設定する」(入力欄へ移るボタン) を出す。
- **キーチェーン**: AI の API キーとセッションのトークンを置く。Rust のコマンドは `get_secret` / `set_secret` / `delete_secret` (名前は許可リストの `claude`・`codex`・`gemini`・`session`。API キーの項目名は従来どおり `api-key-<名前>`、トークンは `session-token`)。ログインの `state` は短命なので `sessionStorage` に置く。
- **`authorize`**: キーチェーンに `session` があれば `Authorization: Bearer` を `new Headers(init.headers)` に足す (呼び出し側のヘッダーは壊さない)。`credentials: "omit"` (Cookie は使わない)。トークンは初回に読んでメモリに写す。
- **CSP**: `tauri.conf.json` の `connect-src` に `https: wss:` を足した (開発用の `devCsp` はさらに `http://localhost:8787 ws://localhost:8787`)。サーバーの URL が設定で変わり、ビルド時に通信先を決められないため、`https:` と `wss:` 全体を許す。代わりに `script-src` は `'self'` のまま (外のスクリプトは読めない)。通信先を絞りたければ、サーバーの URL を固定したビルドにして `connect-src` をそのホストだけにする。リリース版は https のサーバーだけにつながる (http の localhost は `tauri dev` のみ)。`tauri.conf.json` は JSON でコメントを書けないので、理由はここと README に置く。
- **既定のブラウザ**: `plugin-opener` の `openUrl` (capability は `opener:allow-open-url`・`opener:allow-default-urls`)。ログインは `${origin}/auth/login?provider=…&client=desktop&state=…` を開く。
- **deep link**: `tauri-plugin-deep-link` で `untie://` を登録する (`tauri.conf.json` の `plugins.deep-link.desktop.schemes`、capability は `deep-link:default`)。Mac は `.app` の Info.plist、Windows のインストーラーはレジストリに入る (署名なしでも動く)。実行時の `register_all()` は、開発ビルド (未インストール) の Windows と、**Linux はリリースでも**呼ぶ (`#[cfg(any(all(debug_assertions, windows), target_os = "linux"))]`。AppImage で配るのでインストーラーが `.desktop` を置かない。起動のたびに `~/.local/share/applications` に登録し、`update-desktop-database` が要る)。**macOS の `tauri dev` では deep link が届かない** (Info.plist が無い) ので、引換コードを貼る。Windows / Linux は新しいプロセスが起動されるので `tauri-plugin-single-instance` (`deep-link` 機能) を最初のプラグインに置き、動いているウィンドウを前に出す。
- **ログインの画面**: 未ログインのログイン欄 (デスクトップ) は「Google でログイン (ブラウザが開きます)」。押すと「ブラウザでログインしています… 戻らない場合は、ブラウザの画面に出た引換コードを貼ってください」と、引換コードの入力欄・「ログインする」・「やめる」を出す。失敗 (引換コードの期限切れ・使用済み・state の不一致・つながらない) はコードの欄の下 (貼った場合) かトースト (deep link の場合) に出す。この待ちの案内と入力欄は部品 `DesktopLoginWait` で、ホームのログイン欄と、リンクで閲覧中の帯 (`LinkGuestNotice`) が共用する。ログアウトは、デスクトップではサーバーにつながらなくても手元のトークンを消す(「この端末のログイン情報だけ消しました」。サーバー側の行は期限まで残る)。

## 9. 配信とビルド

- **Web 版**: ルートの `pnpm web:deploy` (= `pnpm --filter @untie/web run deploy` = `pnpm build && wrangler pages deploy dist --project-name untie --branch main`)。Cloudflare Pages の Git 連携では Build command を `pnpm --filter @untie/web build`、出力を `apps/web/dist` にする。`_headers` は `apps/web/public/` にあり、Vite が `dist/` に写す。`connect-src` は `'self'` と各 AI プロバイダーの API だけ。手順は README の「Web 版の配信 (Cloudflare Pages)」。
- **クラウド版のサーバー**: ルートの `pnpm cloud:deploy` (= `pnpm --filter @untie/server run deploy` = `pnpm --filter @untie/cloud build && node scripts/copy-headers.mjs && wrangler deploy`)。Worker の名前は `untie-cloud`。`wrangler.jsonc` に `assets` (`../cloud/dist`、SPA、`run_worker_first` は `/auth/*`・`/api/*`・`/parties/*` と、`APP_ORIGIN` 以外のホストで開かれたときに Worker が 302 で移せるよう `/`・`/index.html`)、D1、Durable Object (`new_sqlite_classes`)、`triggers.crons` (ゴミ箱の掃除、毎日)、`vars` を書く。D1 は `--location apac` で作ったものをバインドする。secrets は `wrangler secret put`。本番で置き換える値 (`d1_databases[0].database_id`、`vars.APP_ORIGIN`) は `wrangler.jsonc` のコメントに明記してある。**公開のホスト**: 既定は workers.dev。独自ドメインで配るときは `"workers_dev": false` と `"routes": [{ "pattern": "<ホスト>", "custom_domain": true }]` を有効にする（設定例は `wrangler.jsonc` のコメント）。workers.dev も残すときは `APP_ORIGIN` を独自ドメインにしておけば、workers.dev で開かれた画面・ログインは `APP_ORIGIN` の同じパスへ 302 で移り、ログインは 1 つのホストで済む (7.1)。Google の redirect URI は `APP_ORIGIN` のものを登録する。初回の手順は README の「クラウド版の配信 (Cloudflare Workers)」。
- **確認**: `pnpm --filter @untie/server check` は `node scripts/copy-headers.mjs && wrangler deploy --dry-run`。バンドルと設定が通るかだけを確かめ、Cloudflare にはログインも通信もしない (`CLOUDFLARE_API_TOKEN` なしで動く)。ルートの `pnpm build` に含まれる。
- **クラウド版の画面**: `apps/cloud` は Vite の成果物を作るだけ。`_headers` は `apps/server/public/` にあり、`copy-headers.mjs` が `apps/cloud/dist/` に写して静的ファイルと一緒に配る。CSP の `connect-src` は `'self'` (同じオリジンの fetch と WebSocket を含む) と各 AI プロバイダーの API だけ。`wss:` は足さない (任意のホストへの WebSocket も許してしまうため)。`frame-ancestors 'none'`、`Referrer-Policy: no-referrer` は従来のまま。
- **デスクトップ**: `apps/desktop` に `vite.config.ts` と `src-tauri/`。Release は `apps/desktop` で `tauri-action` を動かす。サーバーの URL はアプリの設定 (8.4) で、ビルドには入れない。
- **core / api / collab / ui**: ビルドせず、`apps/*` の Vite と Worker が TypeScript を直接取り込む (`exports` は `src/*.ts` を指す)。型検査はルートの `pnpm typecheck` (= `tsc -b`) 1 本で、ルートの `tsconfig.json` が全パッケージの `tsconfig.json` を `references` に並べる (`packages/collab/src/room` と、各 app の `tsconfig.node.json` も含む。新しいパッケージを足したらここにも足す)。各 `tsconfig.json` は `tsconfig.base.json` を継承して `src` を見る。パッケージ同士は `exports` 経由でソースを直接読むので、パッケージ側に `composite` は使わない (`tsconfig.node.json` だけ使う)。core と server の `lib` は DOM 抜き (ES2022) にして、DOM に依存しないことを型検査で守る。
- **開発**: `pnpm dev:cloud` でルートから `wrangler dev` (server、8787。D1 と DO はローカルで、毎回マイグレーションを当てる) と `vite` (cloud、5173。`/api`・`/auth`・`/parties` を 8787 に proxy) を同時に動かす。ブラウザは 5173 だけを見る。Google の OIDC を試すときは、redirect URI に `http://localhost:5173/auth/callback` を登録する (`wrangler dev` はリクエストのオリジンを常に `http://localhost:8787` と見るので、`.dev.vars` の `APP_ORIGIN=http://localhost:5173` で固定する)。`.dev.vars` は無ければ `.dev.vars.example` から写し、コミットしない。Web 版だけなら `pnpm dev` (vite、5174。サーバーは要らない)。
- **CI** (`.github/workflows/ci.yml`): ルートから `pnpm check:types`、`pnpm typecheck`、`pnpm test`、`pnpm build` (Web 版・クラウド版・デスクトップのフロント・`wrangler deploy --dry-run`) を順に走らせる。`WRANGLER_SEND_METRICS=false`。別のジョブで Rust の `cargo check` (Linux。`libwebkit2gtk-4.1-dev` などを apt で入れる)。

## 10. セキュリティの要点

- セッションと招待のトークンは D1 にハッシュだけ置く。チケットは短命の署名付き JWT、引換コードは短命の AES-GCM 暗号文で、どちらも保存しない（チケットの使用済みの記録 `ticket:<jti>` は jti と期限だけ）。引換コードにトークンは入れず(交換のときにサーバーが新しいトークンを作って行の id を入れ替える)、1 回限りは `sessions.activated_at` で、コードを盗み見た者への備えは PKCE (`code_verifier`) で守る。
- 権限の判定はサーバーの `requireRole` が正本。画面の `can` は見せ方だけ。
- OIDC は `state`・`nonce`・PKCE を必ず使い、`email_verified` を見る。
- リンク・招待のトークンは URL のパスに置かず `X-Untie-Token` ヘッダーで送る (パスは Workers のログに残る。画面の `/#/…` はハッシュなのでサーバーに届かない)。
- リンク閲覧のトークンは D1 にハッシュだけ置く。無効化と作り直しで即座に使えなくなり、ゲストの接続は切る。編集できるリンクは作らない。
- Web の API は SameSite=Lax の Cookie と `X-Requested-With` で CSRF を防ぐ。デスクトップは Bearer だけ (Cookie は使わない)。
- ゴミ箱の 30 日と完全削除は `destroy()` で Durable Object のストレージを消す。D1 の `files`・`file_members`・`invitations` も消す。
- AI の API キーはいままでどおり各自の端末にだけ置き、サーバーには送らない。
- チケットは 60 秒・1 回限りなので、ログに残っても使えない。ログ (Workers のログ) にトークン・メールの本文は出さない。修復のログ (`changes`) も id・種類・項目名・件数だけで、業務名などの中身は含まない。検証エラーを記録するときも、要素の名前は「…」に伏せる。
- ログアウトしたセッション (`sid`)・ユーザーの接続は、ルームが閉じる (7.2)。セッションが消えたのに接続だけが残ることはない。
- 秘密の値 (`SESSION_SECRET`・`TICKET_SECRET`) は 32 文字以上でなければ動かさない (503 `misconfigured`。7.1)。
- Cloudflare Access を Worker の前にさらに置けるようにしておく (社内限定にしたいとき。Access の JWT があれば、それをログインの代わりにする拡張も可能)。

## 11. テスト

`pnpm test` (= ルートの `vitest run`) が、ルートの `vitest.config.ts` に並べたプロジェクト (`packages/core`・`api`・`collab`・`ui`、`apps/server`・`web`・`desktop`) をすべて走らせる。E2E は持たない。

| 対象 | 場所 | 内容 |
| --- | --- | --- |
| 権限の規則 (`can`) | `packages/api` | 3.2 の表をそのままテストにする |
| API の契約 | `packages/api` | zod スキーマ (リクエストの検証)、fetch クライアント (`UntieApi`。`ApiError`・ヘッダー・URL)、閉じるコードの定数 (7.5) |
| モデル | `packages/core` | 従来のコマンド・検証・固定ボード・分析・トレースに加え、`repairModel` (消えた要素を指す関係・ノード・対象・`bucId`・`contextId`、重複した関係、業務の無い BUC、ボード 0 枚、長すぎる文字列の切り詰め)、8 文字の id。文字数の上限: `limits.ts` の定数がスキーマの `maxLength` と一致すること（スキーマを読んで比べる。上限を持つ項目が増えたら落ちる）、すべてのコマンドが上限を超える入力を断ること、changes に名前などの中身が出ないこと |
| doc の往復 | `packages/collab` | `rebuildModel(applyModelDiff(a, b)) ≡ b` をサンプルと、コマンドをランダムに 1〜50 回当てたモデルで確かめる。順序キーの保持、`order` が JSON に漏れないこと、`observeModelChanges` が 1 トランザクションに 1 回呼ぶこと |
| 合流 | `packages/collab` | Y.Doc を 2 つ作って別々のコマンドを当て、update を交換して同じモデルになること。同じ項目の後勝ち、別の項目はどちらも残ること。`repairDoc` が壊れた参照を直すこと。説明が 4001 文字の要素が（`readModel`・`rebuildModel` でも `repairDoc` でも）残り、関係も残ること |
| サーバー | `apps/server` | `@cloudflare/vitest-plugin` で workerd の中に本物の D1 と Durable Object を立てて走らせる。ログイン (Google はモック、開発用ログイン)、セッションの期限・種類・CSRF・CORS、デスクトップの引換コード (PKCE・1 回限り・期限・未交換の行)、API の権限 (役割ごとに 7.4 の表を当てる)、招待の受理 (メール不一致は拒む)、所有者の譲渡、リンク閲覧 (有効・無効・作り直し、ゲストのチケットが guest になること、メンバーがリンクから開くと自分の役割になること、ゴミ箱の中は 404)、共有まわりの競合と kick、ゴミ箱と cron の掃除（セッション・古い招待）、チケットの検証、ルームへの接続 (viewer と guest の update が捨てられること、kick と取り消しの記録、`locationHint` が付くこと、`onSave` が D1 の名前と更新日時を書くこと)、ログアウトで接続が 4000 で閉じること (`logout`・`logout-all`。別のセッションの接続は残る)、チケットが 1 回限りであること、`save_failed` / `save_ok`、長すぎる文字列が切り詰められること、過去の状態の API、`APP_ORIGIN` への 302、秘密の値が短いときの 503 |
| ストア | `packages/ui` | 従来の `store.test.ts` はそのまま通る (ローカルは変えない)。クラウドの `dispatch`・`commitDrag`・`agentApply` が Y.Doc に書き、他の Y.Doc の変更がストアに届く。viewer の `dispatch` が何もしない。Undo / Redo が何もしない。`cloud/collab.ts` (接続・プレゼンス・閉じられたとき・`save_failed`・チケットの取り直し) は中核に 2 つの Y.Doc をつなぎ、外側は偽の provider で確かめる |
| UI | `packages/ui` | 従来の Testing Library のテスト (Platform はテスト用の実装を渡す) に加え、ホーム・ログイン・クラウドファイルの一覧、共有ダイアログ (リンクのスイッチを含む)、招待を受ける画面、閲覧専用の帯、保存できていない帯、リンクで開く画面、`CloudEditor` (つなぎ直しでボードと選択を引き継ぐこと、送れていない変更の確認、StrictMode で確認が 1 回だけ出ること)、共有ダイアログの「過去の状態」、入力欄の `maxLength`、ルーティング |
| プラットフォーム | `apps/desktop`・`apps/web` | デスクトップ: ログインの記録・deep link・引換コード・サーバーの URL・キーチェーンの呼び出し・最近開いたファイル。Web: 最近開いたファイル・API キーの置き場・`cloud` の有無 (Web 版はサーバーを持たない)。画面: Web 版ではクラウドの欄を出さず、`#/f`・`#/invite`・`#/link` もホームにする (`Root.test.tsx`) |
| 生成物 | CI | `pnpm check:types` が、スキーマから生成した型と検証関数が最新かを確かめる |

サーバーのテストは `apps/server/.dev.vars` を読まず、`vitest.config.ts` が `miniflare.bindings` に秘密の値を明示する (CI には `.dev.vars` が無いため)。

## 12. 進め方

次の 7 段階で進め、すべて実装済み。各段階で `pnpm typecheck`・`pnpm test` を通してから次へ進んだ。

### 12.1 実装済み

1. **モノレポ化** (振る舞いは変えない): `packages/core`・`packages/ui`・`apps/web`・`apps/desktop` に移し、`Platform` に `isTauri()` の分岐を集めた。CI と Release の経路も直した。
2. **Y.Doc の往復**: `packages/collab/src/doc` に往復・合流・`repairModel` を作り、まだつながずにテストで固めた。
3. **サーバーの土台とログイン**: `apps/server` (Hono、D1、Google OIDC、セッション)、`packages/api`、ホーム画面とログイン画面。ファイルは作る・一覧・名前・書き出し・複製・ゴミ箱まで。
4. **同時編集**: `UntieRoom` へのチケットでの接続、ストアのクラウド経路、プレゼンス、サーバー側の `repairModel`、viewer の閲覧専用。
5. **共有**: メンバー・招待・譲渡・リンク閲覧の API と共有ダイアログ、役割が変わったときとリンクを無効にしたときの切断、招待を受ける画面とリンクで開く画面。
6. **デスクトップ**: 既定のブラウザと deep link でのログイン (引換コード・PKCE)、キーチェーンへのセッションの保存、サーバー URL の設定、`tauri-plugin-single-instance`。
7. **Web 版とクラウド版の分離**: ローカル専用の Web 版 (`apps/web`、Cloudflare Pages) と、クラウド版 (`apps/cloud` の画面 + `apps/server` の Worker `untie-cloud`) を別のアプリ・別の配信先にした。`Platform.cloud` で画面を出し分ける (2.3)。

### 12.2 あとで (いまは作らない)

- Microsoft Entra ID でのログイン。`IdentityProvider` の実装を 1 つ足し、`identities.provider` に `microsoft` を入れる。
- magic link (メールのリンクでのログイン)。メール送信サービスが要る。招待も、メール送信が入るまでは画面に出した URL を写して送る (7.4)。
- ドメインでの登録制限の運用。`ALLOWED_EMAIL_DOMAINS` の判定は入っていて、Cloudflare Access を前に置く手もある。管理画面や招待制はあとで。
- フォルダ (ファイルの階層)。
- 名前・説明の文字単位の合流 (Y.Text)。いまは項目ごとの後勝ち。
- オフライン時の手元キャッシュ (IndexedDB)。いまは、つながっていない間の変更はタブを閉じると失われる。長い切断を知らせる帯 (8.3) もあわせて。
- 監査ログ。
- viewer がエージェントに質問だけできるようにすること (8.1)。
- 自社サーバーでの稼働 (Worker 一式を別アカウントに載せるだけ。README の「配信 (Cloudflare)」の手順をそのまま別のアカウントで行う)。
- データの所在を約束する必要が出たときの R2 (`location: apac`) への書き出し (3.7)。
- 同じメールアドレスが別の人に再割り当てされたケースの区別 (3.1)。

## 13. 決めたこと

決めたこと (2026-10-31):

- ID プロバイダーは Google だけで始める。
- 登録はドメインで絞らない。
- リンクを知っている人の閲覧を入れる (3.6)。
- D1 と Durable Object は日本 (apac) に寄せる (3.7)。
- 使われないファイルを自動では消さない。
- viewer / guest の書き込みは `y-partyserver` 2.2.0 の `isReadOnly` で捨てる (確認済み。`onMessage` の上書きは要らない。7.5)。
- Web 版でも、ログインなしでローカルの JSON を開ける経路を残す (ローカルファイルは従来どおり。8.1)。
- ゴミ箱の保持期間は 30 日 (3.1、3.4)。
- AI の API キーは従来どおり各自の端末に置き、サーバーには送らない (10 章)。サーバーで組織のキーを持つ案は、必要になったときに改めて決める。

実装の途中で決めたことのうち、1 章の表にまとめたもの: デスクトップのログイン (deep link・引換コード・PKCE)、トークンのヘッダー化 (`X-Untie-Token`)、CORS、未交換のセッション、kick と取り消しの記録、プレゼンスの照合。
