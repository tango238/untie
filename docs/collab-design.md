# Untie クラウド版 (ユーザー・ファイル・権限・同時編集) 設計書

ログインしたユーザーがクラウドにファイルを置き、他のユーザーと共有し、同時に編集できるようにする。あわせて、デスクトップ (Tauri)・Web・共通部分・サーバーをディレクトリで分けて管理する。本文書は [docs/design.md](design.md) の続きで、そこに書いてあることは繰り返さない。

## 1. 決めたこと

| 項目 | 決定 |
| --- | --- |
| ファイルの置き場所 | **ローカルファイル** (いまの JSON。ログイン不要) と **クラウドファイル** (サーバーに置く。ログインが要る) の 2 種類。クラウドファイルは常に同時編集できる (1 人でも同じ経路) |
| ユーザー | メールアドレスで識別する。パスワードは持たず、Google でログインする (OIDC)。他のプロバイダーは同じ形で後から足せる |
| セッション | サーバーが発行する不透明なトークン。Web は HttpOnly Cookie、デスクトップは OS のキーチェーンに置く |
| 権限 | ファイルごとに `owner` / `editor` / `viewer` の 3 役。権限の判定はサーバーで行い、UI は同じ規則で見せ方を変えるだけ |
| 共有 | 所有者がメールアドレスで招待する (editor / viewer)。加えて、所有者が有効にすれば**リンクを知っている人は誰でも閲覧**できる (ログイン不要。3.6) |
| 同期の方式 | Yjs (CRDT)。ルームは `y-partyserver` の `YServer` を継承した Durable Object。1 クラウドファイル = 1 Durable Object |
| 正本 | ローカルファイルはいまのストア (変えない)。クラウドファイルはルームの Durable Object の Y.Doc で、ストアの `model` はそこから組み立てる |
| 一覧と権限の置き場所 | D1 (SQLite)。ユーザー・セッション・ファイルの一覧・メンバー・招待・リンク。ファイルの中身は Durable Object のストレージ |
| 置き場所の地域 | 日本に寄せる。D1 は `--location apac` で作り、Durable Object は `locationHint: "apac"` で作る (3.7) |
| ファイルの寿命 | 使われないファイルを自動では消さない。消すのは所有者だけ (ゴミ箱に 30 日置いてから完全に消す) |
| 編集 API | いまの `commands.ts` (純粋関数) をそのまま使う。コマンドの結果と直前のモデルの差分を Y.Doc に書く |
| 保存形式 | JSON ファイルの形式 (`schema/untie.schema.json`、`version: 1`) は変えない。クラウドファイルは同じ JSON に書き出せる |
| 衝突 | 項目ごとに後勝ち (Yjs の Y.Map)。名前と説明は文字単位では合流しない |
| Undo / Redo | クラウドファイルでは使えない。ローカルファイルではいまのスナップショットの履歴をそのまま使う |
| 参照整合性 | 合流後に壊れた参照 (消えた要素を指す関係など) をサーバーが直す (`repairModel`) |
| 配信 | 1 つの Cloudflare Worker が Web の静的ファイル・API・Durable Object を持つ。デスクトップ版も同じ Worker につなぐ。Pages は使わない |
| 登録 | Google のアカウントがあれば誰でもログインできる。ドメインでは絞らない (共有されなければ何も見えない) |

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

まず Google だけで始める。パスワードは持たない (漏えい対策を背負わない)。Cloudflare Access は Worker の前にさらに置けるが、ログイン自体の仕組みにはしない。Microsoft Entra ID と magic link (メール送信サービスが要る) は、同じ `IdentityProvider` の形で後から足す (12 章)。

## 2. ディレクトリ構成 (pnpm ワークスペース)

```
untie/
├ packages/
│  ├ core/        @untie/core    … モデル (型・スキーマ・id・関係ルール・コマンド・検証・固定ボード・分析・トレース)、サンプル
│  │                               DOM にも React にも依存しない。サーバーもここを使う
│  ├ api/         @untie/api     … サーバーと画面で共有する契約。DTO の型、役割と権限の規則 (`can(role, action)`)、
│  │                               URL の形、fetch のクライアント (`UntieApi`)。zod でリクエストを検証する
│  ├ collab/      @untie/collab  … 同時編集。core と api にだけ依存する
│  │  ├ src/doc/                  … UntieDoc: Y.Doc ⇄ UntieModel の橋渡し (diff・apply・rebuild)、repairModel、順序キー
│  │  ├ src/client/               … 接続 (y-partyserver/provider)、プレゼンス、チケットの取得
│  │  └ src/room/                 … UntieRoom (YServer を継承した Durable Object)、閲覧専用の扱い、永続化、D1 への反映
│  └ ui/          @untie/ui      … React の画面と zustand ストア、io (ローカルファイル)、ai。Web とデスクトップで共通
│                                   プラットフォーム依存の処理は `Platform` インターフェースで受け取る (2.1)
├ apps/
│  ├ server/                      … Cloudflare Worker。Hono のルート (auth・files・members・invitations)、D1 のマイグレーション、
│  │                                 UntieRoom のマウント、`apps/web/dist` の静的配信。wrangler.jsonc はここ
│  ├ web/                         … Vite のエントリ。Platform の Web 実装。ビルド結果を server が配信する
│  └ desktop/                     … Vite のエントリ + src-tauri (Rust)。Platform の Tauri 実装 (キーチェーン・deep link)
├ schema/untie.schema.json        … 変えない (core が参照)
├ docs/
└ pnpm-workspace.yaml, package.json (ルートは scripts と devDependencies だけ)
```

依頼の「共通の core」は `core`・`api`・`ui` の 3 つに分ける。サーバー (Worker) が core と api を取り込むので、そこに React や DOM が入っていると Worker のバンドルに引きずられる。画面は `ui` に置き、Web とデスクトップはどちらも `ui` を使う。

いまの `src/` との対応:

| いま | 移動先 |
| --- | --- |
| `src/model/`、`src/sample/` | `packages/core/src/` |
| `src/components/`、`src/store/`、`src/ai/`、`src/io/`、`src/styles/`、`src/App.tsx` | `packages/ui/src/` |
| `src/io/file.ts`・`recent.ts`・`useCloseGuard.ts`・`ai/keys.ts` の `isTauri()` 分岐 | `apps/web/src/platform.ts` と `apps/desktop/src/platform.ts` に分割 |
| `src/main.tsx`、`index.html`、`vite.config.ts` | `apps/web/` と `apps/desktop/` にそれぞれ |
| `src-tauri/` | `apps/desktop/src-tauri/` |
| `public/_headers` | `apps/server/public/_headers` (`apps/server` ができるまでは `apps/web/public/_headers` に置く) |
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
  /** サーバーの URL (Web は自分のオリジン、デスクトップは設定で変えられる) */
  serverOrigin(): string;
  /** ログイン。Web は同じタブで /auth/login へ移り、returnTo (`#/...` のハッシュ) の画面へ戻る。デスクトップは既定のブラウザを開いて deep link で戻る (7.3)。ProviderId は `@untie/api` の `"google" | "dev"` */
  login(provider: ProviderId, returnTo: string): Promise<void>;
  /** セッションの送り方。Web は Cookie (何もしない)、デスクトップはキーチェーンのトークンを Authorization に付ける */
  authorize(request: RequestInit): Promise<RequestInit>;
}
```

`ui` のエントリは `createApp(platform)` で、`apps/web/src/main.tsx` と `apps/desktop/src/main.tsx` がそれぞれの実装を渡す。いまの `isTauri()` 分岐はすべてこの実装側に移す。

### 2.2 パッケージ間の依存

```
apps/web ──────> ui ─┬─> core
apps/desktop ──> ui  ├─> api
                     └─> collab (doc, client) ─> core, api
apps/server ─┬─> core
             ├─> api
             └─> collab (room)
```

`collab` は `exports` で `.` (doc + client) と `./room` を分け、`./room` だけが `partyserver` / `y-partyserver` / `cloudflare:workers` に依存する。`ui` から `./room` は取り込まない。`api` は DOM にも Worker にも依存しない (fetch だけ)。

## 3. ユーザー・ファイル・権限

### 3.1 概念

| 概念 | 内容 |
| --- | --- |
| ユーザー | メールアドレスで一意 (ASCII のみ。招待で受けるのも ASCII の形で、Unicode のアドレスは 400)。表示名とアイコンは ID プロバイダーからもらう。ログインのたびに、`identities` の (provider, subject) で見つかればそのユーザー、無ければメールで既存のユーザーに結び (同じメールで別のプロバイダーからログインしても同じユーザー)、どちらも無ければ作る。同じメールアドレスが別の人に再割り当てされたケースは区別しない (PoC) |
| ローカルファイル | いまの JSON ファイル。ログインしなくても使える。サーバーは関与しない |
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
  user_agent  text
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
```

- 所有者は `files.owner_id` と `file_members` の `role = 'owner'` の両方に書く。前者で「自分のファイル」を速く引き、後者で権限判定を 1 本にする。譲るときは 1 トランザクションで両方を書き換える。
- 「共有されたファイル」は `file_members` を `user_id` で引いて `role != 'owner'` のもの。
- マイグレーションは `apps/server/migrations/0001_init.sql` から番号順に置き、`wrangler d1 migrations apply` で当てる。

### 3.4 ファイルの中身の置き場所 (Durable Object)

| キー | 中身 | 用途 |
| --- | --- | --- |
| `ydoc` | Yjs の状態 (`Y.encodeStateAsUpdate`) | 次に誰かが入ったときに `onLoad` で戻す |
| `snapshot` | JSON 形式のモデル (`rebuildModel` の結果) | 書き出し、複製、壊れたときの戻し先 |
| `snapshot:<日時>` | 1 時間ごとの `snapshot` の写し (直近 24 件)。その時間の**最初の保存の直前の状態** (上書きする前の `snapshot`) を入れ、同じ時間の 2 回目以降は上書きしない | 誤って消したときに、消す直前の状態の JSON を取り出す (クラウドファイルには Undo が無い) |

- 1 クラウドファイル = 1 Durable Object なので、ファイルの中身はその中で閉じる。モデルは数百 KB までなので、そのまま入る。R2 は使わない。
- Worker からルームへは `getServerByName(env.UntieRoom, fileId, { locationHint: "apac" })` で RPC を呼ぶ: `importModel(json)` (作成・複製)、`exportModel()` (書き出し。接続せずに読む)、`rename(name)`、`destroy()` (完全に消す)。
- ゴミ箱に入れても Durable Object は残す (戻せるように)。30 日経ったら Worker の cron (`scheduled`) が D1 から探して `destroy()` し、行を消す。

### 3.5 名前と更新日時

- 名前の正本はモデルの `meta.name` (Y.Doc の `meta`)。一覧の `files.name` はその写し。
- ルームが `onSave` で `files.name` と `files.updated_at` を D1 に書く (ルームにも D1 のバインディングを渡す)。
- 一覧から名前を変えるときは `PATCH /api/files/:id` がルームの `rename` を呼び、ルームが `meta.name` を書いて `onSave` で D1 に反映する。エディタで `meta.name` を変えたときも同じ経路で D1 に届く。

### 3.6 リンクを知っている人の閲覧

- 所有者が共有ダイアログで「リンクを知っている人が閲覧できる」を有効にすると、サーバーが 32 バイトの乱数のトークンを作り、SHA-256 を `files.link_token` に置く。URL は `https://<host>/#/link/<トークン>` (画面側はハッシュでルーティングするため、`#` が要る)。トークンは D1 に平文で持たないので、URL を返すのは有効にした・作り直した応答 (`PUT /api/files/:id/link`) だけで、`GET /api/files/:id` の `link` は `{ enabled }` だけ。すでに有効なときの `PUT` (作り直しでない) は何も変えず URL も返さない。
- 無効にすると `link_token` を null にする。「リンクを作り直す」は新しいトークンに置き換える (前のリンクは使えなくなる)。
- リンクを開いた人は、ログインしていなくても閲覧できる。`POST /api/links/ticket` はセッションが無くても通り、`{ fileId, userId: null, name: "ゲスト", role: "guest", via: "link" }` のチケットを返す。ログインしていて、かつそのファイルのメンバーなら、メンバーの役割のチケットを返す (editor がリンクから開いても編集できる)。
- ゲストはプレゼンスに「ゲスト」と番号で出る。書き出し (`GET /api/links/export`) はできる。複製はログインしてから (`POST /api/links/duplicate`。「複製するにはログイン」を出す)。
- 無効にした・作り直したときは、Worker がルームの `kick({ via: "link" })` を呼び、リンクで入っている接続を閉じる。つなぎ直しはチケットの取得で 404 になり、画面は「このリンクは無効になりました」を出す。
- リンクのトークンは URL に出るので、Referrer を外に漏らさないよう `_headers` の `Referrer-Policy: no-referrer` (いまのまま) を保つ。ゴミ箱の中のファイルはリンクでも開けない。
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
├ relations: Y.Map<id, JSON>    … { kind, sourceId, targetId } (作ったあと変えないので値ごと置く)
└ boards:    Y.Map<id, Y.Map { name, order,
                               nodes: Y.Map<elementId, { x, y, width?, height? }>,
                               edges: Y.Map<relationId, { sourceSide, targetSide }> }>
```

- 要素の項目 (`name`、`description`、`bucId`、`contextId`、`severity`、`hours`、`values`、`targetIds`、`links`、`analysis`) は Y.Map の値ごとに後勝ち。`values`・`targetIds`・`links` は小さな配列なので丸ごと 1 つの値として置く。
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
| `readModel(doc)` | Y.Doc の中身をそのままモデルにする。壊れた参照は外さず、ボードが 0 枚でも補わない。ただし形の壊れた要素・ノード・関係・線は外す。サーバーが「直す前」の状態を読むのに使う |
| `rebuildModel(doc, prev?)` | `readModel` に `repairModel` を当てた、表示用のモデル。`prev` を渡すと、内容が同じ要素・関係・ボード・ノード・線は `prev` の参照を使い回す (React のメモ化と `===` 比較を生かす)。全部同じなら `prev` 自体を返す |
| `applyModelDiff(doc, before, after, origin)` | 2 つのモデルを id 単位で比べ、違う項目だけを 1 つのトランザクションで Y.Doc に書く |
| `repairModel(model)` | 壊れた参照を見つけ、直したモデルと変更の一覧を返す (6 章。core にあり、Y.Doc を知らない) |
| `repairDoc(doc, origin)` | サーバーだけが呼ぶ。`readModel` の結果に `repairModel` を当て、差分を `applyModelDiff` で `origin` 付きに書き、変更の一覧を返す。壊れていなければ何も書かない |
| `observeModelChanges(doc, callback)` | 変わった id (`elements` / `relations` / `boards` / `meta`) を、**トランザクションごとに 1 回**、`origin` 付きで知らせる (`observeDeep` を包む)。戻り値は解除 |

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

- **dispatch**: コマンドをいまのモデルに当て、成功したら差分を `origin = local` のトランザクションで Y.Doc に書き、**そのあと `rebuildModel(doc, after)` を表示のモデルにする** (Doc が正本。コマンドの結果をそのまま出すのではない)。同時に届いていた他の人の変更も、消した側が勝つ規則も、ここで Doc の側で揃う。失敗 (`ok: false`) はいままでどおり何もしない。`viewer` のときは `dispatch` が何もせず `{ ok: false, reason: "閲覧専用です" }` を返す。
- **他の人の変更**: `observeModelChanges` が `origin` が自分以外のトランザクションを知らせるたびに、**変わった id だけではなく毎回 `rebuildModel(doc, prev)` で全体を組み立て直す** (届く id と組み立て直して変わる範囲が一致しないため。6 章)。`prev` を渡すので、内容が同じ要素・関係・ボード・ノード・線は参照が使い回され (構造共有)、React の再描画は変わった分に絞られる。`reconcileUi` で選択やボードの参照先が消えていたら外す (既存の処理)。
- **ドラッグ中** (`previewNode` / `previewCommand`): Y.Doc には書かず表示だけ動かす。ドラッグ中に届いたリモートの変更は後回しにし (`pendingRemote`)、`commitDrag` / `cancelDrag` のあとで Doc から組み立て直す。`commitDrag` が書くのは `dragBase` と確定後の差だけなので、他の人の変更は消さない (同じノードを他の人が動かしていたら、確定時に自分の座標で上書きする。後勝ち)。`dispatch` と `agentApply` は、ドラッグ中なら先に `commitDrag` する (`before` が Doc とずれないように)。
- **AI エージェント** (`beginAgentEdit` 〜 `endAgentEdit`): 途中の `agentApply` は Y.Doc に書く (他の人にも見える)。クラウドでは `beginAgentEdit` の間だけ書ける (開く前から走っていたローカルのエージェントを通さないため)。`viewer` は使えない。
- **Undo / Redo**: クラウドファイルでは使えない。開いたときに履歴を捨て、ツールバーのボタンを無効にし、Cmd/Ctrl+Z・Shift+Cmd/Ctrl+Z・Ctrl+Y を無視する。
  - 理由: 共有中の Undo は「自分の変更だけを戻す」ことになるが、他の人の変更と絡むと結果が読めない (自分が足した作業を戻したら、他の人がそこに付けた課題の対象や関係が消える、など)。PoC では入れない。
  - 誤って消したときの戻し先は、書き出した JSON と、サーバーのスナップショット (3.4)。
- **ローカルファイルはいまのまま**: Y.Doc を持たない。`dispatch`・履歴・保存していない変更の判定 (`model === savedModel` の参照比較) は、いまのコードを変えない。ストアに `UntieDoc` が付いているときだけ、上の経路を通る。
- **保存していない変更**: クラウドファイルはサーバーが正本なので、つながっている間は「未保存」の概念が無い。Cmd/Ctrl+S は「JSON に書き出す」になる。つながっていない間の変更は手元の Y.Doc に溜まり、つながると合流する。**その溜まった分はタブを閉じると失われる**ので、「最後の同期のあとに、つながっていない間に自分が書いた変更がある」ときだけ、閉じる前の確認とホームへ戻る確認の対象にする (8.3)。

## 6. 参照整合性

Yjs は「要素 A を消す」と「A への関係を足す」を両方受け入れるので、合流後に壊れた参照が残りうる。

- `repairModel` (core、純粋関数) が、いまの `validateModel` の参照整合性検査と同じ規則で壊れた箇所を見つけ、直し方を返す。
  - **持っている規則**: 消えた要素を指す関係・ノード・`targetIds` は消す。消えた BUC を指す `bucId` と消えたコンテキストを指す `contextId` は `null` にする (「無い」ものと「種類が違う」ものを分けて報告する)。業務が消えた BUC は消す。業務の既定の活動はちょうど 1 個にする (無ければ作る。id は `buc_<業務の id>` で、どの端末で直しても同じ。複数なら最初を残し、他の既定の活動の作業は残した方へ付け替えて消す) 。既定の活動の名前を業務名に揃える。自己参照の関係と、両端の種類から決まる kind と合わない関係は消す。置けない要素 (課題・既定の活動) のノードは消す。枠 (業務・BUC) のノードに `width` / `height` が無ければ既定の大きさを補う。関係が消えたボードの線の設定は消す。ボードが 0 枚なら「ボード 1」を作る。
  - **同じ関係の重複**は `sameRelation` で畳み、**`(order, id)` で先頭のものを残す**。畳んだ関係の線の設定も消す。
  - **持っていない規則 (対象外)**: 要素・関係・ボードをまたいだ id の重複、`hours` の小数点の桁、課題の対象の混在。`validateModel` は検査するが、同時編集では起きにくいので直さない (起きたら `onSave` の検証で見つけて記録する)。
- **直すのはサーバーだけ** (`UntieRoom` が update を受けるたびに、debounce して `repairDoc(doc, "repair")` を呼ぶ)。全員が直すと同じ修正が何度も流れる。
- クライアントの `rebuildModel` は、直されるまでの間 UI が壊れないよう、壊れた参照を表示から外す (Y.Doc は変えない)。**外すもの**は `repairModel` の規則に加えて、形の壊れた要素・ノード・関係・線 (項目が欠けた課題など。1 つで全員の組み立てが落ちるのを防ぐ。core の生成済みの要素単位の検証を使う) と、種類の分からない要素。
- **ボードが 0 枚**のとき、表示用に `board_main` の「ボード 1」を補う (Y.Doc は変えない)。補ったボードへの編集が消えないよう、Y.Doc のボードが 0 枚のときに限り、`applyModelDiff` が `board_main` を Y.Doc に作る。サーバーの修復と同じ固定 id なので、両方が作っても 1 つのボードに合流する (同時に作った内容は後勝ちで、片方は残らない)。
- `addRelation` の重複検査など、コマンド側の検査はいままでどおり自分の手元のモデルに対して行う。同じ関係を 2 人が同時に足すと id が違う重複が残る。表示は 1 本に畳まれるが、見えている方を消すと隠れていた方が現れてしまう。そのため `applyModelDiff` は関係を消すとき、Y.Doc に残っている `sameRelation` の重複と、その線の設定も同じトランザクションで消す。
- **衝突の非対称**: 要素と、ボード・関係のように Y.Map のキーで持つものは「消した側が勝つ」(消された要素への更新は、書き込む先が無いので捨てる)。一方、値ごと置く項目 (ノード・線・関係) は、同時の更新が消去に勝って復活しうる。ストアは `dispatch` の前に、リモートの変更の組み立て直しを済ませておくこと (Phase 4。手元の `before` が Y.Doc とずれると、消えたものを復活させる)。`applyModelDiff` は、変えた項目が Y.Doc に無いときは書かない。
- **`observeModelChanges` で届く id と、組み立て直して変わる id は一致しない**。たとえば BUC が消えると、その BUC を指す作業の `bucId` が (`repairModel` により) 変わるが、届くのは BUC の id だけである。部分的な組み立て直しをするなら、この差を考慮する (Phase 4)。当面は `rebuildModel(doc, prev)` で全体を組み立てて構造共有に任せる。
- id は `kind_` + 6 文字 (36^6 ≈ 22 億通り) だったが、同時編集では別々の端末で同じ id を引く恐れがわずかにあるので **8 文字**にした (36^8 ≈ 2.8 兆通り。JSON の形式は変わらない。既存の 6 文字の id はそのまま使える)。

## 7. サーバー (apps/server)

### 7.1 構成

```ts
// apps/server/src/index.ts
export { UntieRoom } from "@untie/collab/room";
const app = new Hono<{ Bindings: Env }>();
app.route("/auth", authRoutes);        // 7.3
app.route("/api", apiRoutes);          // 7.4。すべて requireSession を通す
app.all("/parties/*", roomRoutes);     // 7.5。チケットを検める
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));  // apps/web/dist (SPA)
export default { fetch: app.fetch, scheduled: purgeTrash };
```

| バインディング | 用途 |
| --- | --- |
| `ASSETS` | `apps/web/dist` の静的配信 (`not_found_handling: "single-page-application"`) |
| `DB` (D1) | 3.3 のテーブル |
| `UntieRoom` (Durable Object、`new_sqlite_classes`) | ファイルの中身 |
| secrets | `SESSION_SECRET` (Cookie の署名)、`TICKET_SECRET` (7.5 のチケットの署名)、`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` |

### 7.2 セッション

- ログインが済むと `sessions` に行を作り、トークン (32 バイトの乱数、base64url) を返す。D1 にはその SHA-256 だけを置く。
- **Web**: `Set-Cookie: untie_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/`。`Secure` は**リクエストが https のとき**に付ける (`APP_ORIGIN` の設定には頼らない。http://localhost の開発では付かない)。Cookie は `kind = web` のセッションだけ、Bearer は `kind = desktop` のセッションだけを受ける。ログインし直したときは、持っていた Cookie のセッションの行を消す。開発用ログイン (`DEV_LOGIN=true`) は、リクエストのホストが localhost / 127.0.0.1 のときだけ効く (本番で誤って true にしても効かない)。API は Cookie で認証する。CSRF は SameSite=Lax に加え、状態を変える API は `X-Requested-With: untie` ヘッダーを要求する (フォームからは付けられない)。
- **デスクトップ**: トークンを `Authorization: Bearer <token>` で送る。キーチェーンに `session` として置く (いまの `keyring` のコマンドを使う)。
- `requireSession` ミドルウェアが Cookie か Authorization を読み、`sessions` を引いて `c.var.user` を入れる。期限切れは 401。使うたびに `last_seen_at` と `expires_at` を延ばす (1 日に 1 回だけ書く)。
- ログアウトは行を消す。「すべての端末からログアウト」は `user_id` の行を全部消す。

### 7.3 ログイン (OIDC)

```
Web:        画面 ─GET /auth/login?provider=google────> Worker ─302─> Google
            Google ─302 /auth/callback?code&state──> Worker: code を交換、id_token を検証、users/identities を upsert、
                                                             sessions を作成、Cookie を付けて 302 / (元の URL)
デスクトップ: アプリ ─既定のブラウザで GET /auth/login?provider=google&client=desktop&state=<乱数>
            … 同じ流れで Worker がセッションを作る …
            Worker ─302 untie://auth/callback?code=<1 回限りの引換コード>&state=
            アプリ ─POST /auth/desktop/exchange { code, state } ─> { token }  → キーチェーンへ
```

- `state` と `nonce` と PKCE (`code_verifier`) は Worker が Cookie (`untie_auth`、10 分、HttpOnly) に署名付きで持ち、callback で照合する。
- プロバイダーは `IdentityProvider` インターフェース (`authorizationUrl`、`exchange`、`profile`) で抽象化し、まず `google` だけを実装する。ライブラリは `arctic` を使う (OIDC の定型を持ち、Workers で動く)。
- メールアドレスは小文字に正規化して `users.email` に合わせる。プロバイダーが `email_verified: false` を返したら拒む。
- デスクトップの引換コードは 1 回限り・5 分で、D1 ではなく `TICKET_SECRET` で署名した短い JWT にする (保存しない)。`state` はアプリが作ってキーチェーンに置き、戻ってきた `state` と照合する。deep link は `tauri-plugin-deep-link` で `untie://` を登録する。deep link が使えない環境 (Linux の一部) では、ブラウザ側のページに引換コードを表示し、アプリに貼る経路を残す。
- 登録はドメインで絞らない。Google のアカウントがあれば誰でもログインでき、共有されなければ自分のファイルしか見えない。将来絞りたくなったときのために `ALLOWED_EMAIL_DOMAINS` (環境変数、空なら制限なし) の判定だけ入れておく。

### 7.4 API

すべて `/api/` の下。JSON。`/api/links/*` を除いて `requireSession` を通る。リクエストは `packages/api` の zod スキーマで検証する。

| メソッドとパス | 内容 | 必要な役割 |
| --- | --- | --- |
| `GET /me` | 自分のユーザー情報 | ログイン |
| `POST /me/logout`、`POST /me/logout-all` | ログアウト | ログイン |
| `GET /files` | 自分のファイルと共有されたファイル (`{ mine, shared }`)。名前・更新日時・役割・メンバー数 | ログイン |
| `POST /files` | 作る。`{ name }` で空のモデル、`{ model }` で JSON を取り込む (ローカルファイルをクラウドへ)。作った人が owner | ログイン |
| `GET /files/:id` | 1 件の情報 (名前・所有者・自分の役割)。**owner にだけ** `members` (`userId`・`email`・`name`・`role`・`addedAt`)、`invitations` (まだ受けられていない招待。`id`・`email`・`role`・`createdAt`・`expiresAt`。期限切れも含む)、`link` (`{ enabled }` だけ。トークンは持たないので URL は返さない) を付ける。editor / viewer には付けない | member |
| `PATCH /files/:id` | 名前を変える | editor |
| `POST /files/:id/duplicate` | 複製して自分の owner のファイルにする | member |
| `GET /files/:id/export` | JSON (`serializeModel` と同じ整形)。`Content-Disposition` 付き | member |
| `DELETE /files/:id` | ゴミ箱へ | owner |
| `POST /files/:id/restore` | ゴミ箱から戻す | owner |
| `DELETE /files/:id/purge` | 完全に消す (Durable Object の `destroy`) | owner |
| `GET /files/trash` | ゴミ箱の一覧 | ログイン |
| `POST /files/:id/ticket` | ルームに接続するチケット (7.5) | member |
| `PUT /files/:id/members/:userId` | 役割を足す・変える (`{ role: "editor" \| "viewer" }`)。応答は `Member`。相手がユーザーでなければ 404 `user_not_found` → 招待を使う。owner の役割は変えられない (409 `owner_role_fixed`)。**役割が変わったとき**はその人の接続を `kick({ userId, reason: "roleChanged" })` で切る (新しく足しただけ・同じ役割への変更では切らない) | owner |
| `DELETE /files/:id/members/:userId` | 外す (204)。owner は owner 以外の誰でも外せる。editor / viewer は自分だけ (`can(role, "leave")`、他人は 403)。owner 自身は外せない (409 `transfer_first`)。相手がメンバーでなければ 404 `member_not_found`。外したら `kick({ userId, reason: "removed" })` | owner (自分なら member) |
| `POST /files/:id/transfer` | 所有者を譲る (`{ userId }`。相手はメンバー。メンバーでなければ 404 `member_not_found`、自分なら 409 `already_owner`)。1 つの `batch` で `files.owner_id` と両者の `file_members.role` を書き換え、元の所有者は editor になる。両者を `kick({ userId, reason: "roleChanged" })`。応答は譲った人から見た `FileSummary` | owner |
| `PUT /files/:id/link` | リンク閲覧を有効にする (`{ regenerate?: true }` で作り直す。本文は省略できる)。トークンが無いか `regenerate` なら新しいトークンを作り、`{ enabled: true, url }` (`url` = `${APP_ORIGIN}/#/link/<トークン>`) を返す。作り直したときは `kick({ via: "link" })`。すでに有効で `regenerate` でなければ何も変えず `{ enabled: true }` だけ (トークンは平文で持たないので URL は出せない) | owner |
| `DELETE /files/:id/link` | リンク閲覧を無効にする (204)。`link_token` を null にし、`kick({ via: "link" })` | owner |
| `POST /files/:id/invitations` | メールで招待する (`{ email, role: "editor" \| "viewer" }`。メールは小文字に正規化)。既にユーザーならその場で `file_members` に足し (すでにメンバーなら役割を更新し、変わったら `kick({ userId, reason: "roleChanged" })`)、`200 { kind: "member", userId }`。まだユーザーでなければ `invitations` に行を作り (同じメールの未承諾の招待は置き換える)、`201 { kind: "invitation", invitationId, url }` (`url` = `${APP_ORIGIN}/#/invite/<トークン>`。メール送信は PoC では画面から写して送る)。自分 (owner) のメールは 409 `already_owner`。有効期間は 14 日 | owner |
| `DELETE /files/:id/invitations/:invitationId` | 招待を取り消す (204)。無ければ 404 `invitation_not_found` | owner |
| `GET /invitations/info` | 招待の中身 `{ fileName, role, email, inviterName, expired }`。トークンの SHA-256 で引く (無ければ・ゴミ箱の中のファイルなら 404 `invitation_not_found`)。ログイン中のメールと招待のメールが違えば 403 `email_mismatch` | ログイン |
| `POST /invitations/accept` | 招待を受ける。メールが一致するときだけ。`file_members` に足し (すでにメンバーなら役割は変えない)、`accepted_at` を書き、`{ fileId }`。受け終わった招待をもう一度受けても同じ結果 (冪等)。期限切れは 410 `invitation_expired`。受けたあとに外された人が古い招待で戻ろうとすると 410 `invitation_used`。**ログインしただけでは受理しない** (受ける画面で明示的に受ける) | ログイン |
| `GET /links/info` | `{ fileId, name, role }`。`role` はセッションがあってメンバーならその役割、それ以外は `guest`。セッションは**あれば読む・無くてもよい** (期限切れ・不正でも guest で通る)。トークンが無効・ゴミ箱の中は 404 `link_not_found` | リンク |
| `POST /links/ticket` | リンクで接続するチケット (3.6)。常に `via: "link"`。メンバーならその役割と `userId`、それ以外は `role: "guest"`・`userId: null`・`name: "ゲスト"` | リンク |
| `GET /links/export` | JSON に書き出す (`GET /files/:id/export` と同じ形)。セッション不要 | リンク |
| `POST /links/duplicate` | リンクのファイルを複製して、自分の owner のファイルにする (`201 FileSummary`。名前は「<元の名前> のコピー」)。**セッション必須** (未ログインは 401。ゲストは「複製するにはログイン」)。メンバーでなくてもよい。トークンが無効・ゴミ箱の中は 404 | ログイン + リンク |

**ゴミ箱の中のファイル**では、状態を変える共有の API (`PUT/DELETE /files/:id/members/:userId`、`POST /files/:id/transfer`、`POST/DELETE …/invitations`、`PUT/DELETE …/link`) は owner でも **409 `in_trash`** (戻してから変える。メンバーには他の API と同じく 404)。

**共有の kick**: D1 を書き換えたあとに呼び、失敗しても例外にせずログに出すだけで 2xx を返す (500 にすると再試行されず、接続が残るため)。再試行の経路でも切る: すでにメンバーの行があるときの `PUT` は役割が同じでも `kick`、外し済みの人への `DELETE` も `kick` してから 404。`putMemberRole`・`removeMember` は、そのメール宛の未承諾の招待も同じ `batch` で消す (外した人が残っていた招待で戻れないように)。`transferOwner` は「いま from が owner で to がメンバー」を update の条件に持ち、並行して抜けた・別の譲渡が通ったときは何も書かず 409 `conflict`。リンクの有効化は `update … where link_token is null` で書き、先を越されたら URL を返さない。

**既存ユーザーの招待**: すでにユーザーのメールを招待すると、その場でメンバーになり、応答の `kind` から「そのメールは登録済み」と分かる。相手の共有一覧にも承諾なしで入る (PoC として許容する)。招待は `ALLOWED_EMAIL_DOMAINS` を通り、許されないドメインは 400 `email_not_allowed`。

権限判定は `requireRole(fileId, "editor")` のようなミドルウェアで `file_members` を引き、`can(role, action)` で判定する。ゴミ箱の中のファイルは owner 以外は 404。`/links/*` は `POST /links/duplicate` を除いて `requireSession` を通さず (`apiRoutes` で `requireSession` より前にマウントする)、トークンの SHA-256 で `files.link_token` を引く (無ければ 404)。**リンク・招待のトークンはパスに置かず、ヘッダー `X-Untie-Token` で受ける** (`/links/info`・`/links/ticket`・`/links/export`・`/links/duplicate`・`/invitations/info`・`/invitations/accept`)。パスは Workers のログに残るため。画面のハッシュ URL (`/#/link/<token>`・`/#/invite/<token>`) はサーバーに届かないので、そのまま。ヘッダーが無い・空のときは、でたらめなトークンと同じく 404。応答には (404 などのエラーにも) `Cache-Control: no-store` を付ける。セッションは `Authorization: Bearer` (desktop のセッションだけ) か Cookie (web のセッションだけ) から読み、種類が違う・期限切れ・不正なものはエラーにせず guest として扱う。招待とリンクの URL の組み立てには `appOrigin` (`APP_ORIGIN` が空ならリクエストの origin) を使い、画面のルーティングに合わせてハッシュ (`/#/invite/…`、`/#/link/…`) にする (8.1)。

### 7.5 ルームへの接続

- ブラウザの WebSocket にはヘッダーを付けられないので、接続には **チケット** を使う: `POST /api/files/:id/ticket` (または `POST /api/links/ticket`) が `{ fileId, userId, name, role, via: "member" | "link", exp: 60 秒 }` を `TICKET_SECRET` で署名した短い JWT を返し、クライアントは `wss://<host>/parties/untie-room/<fileId>?ticket=...` でつなぐ。Web もデスクトップも同じ。
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

- ルームは `onConnect(connection, ctx)` で `ctx.request` のヘッダーを `connection.setState({ userId, name, role, via })` (型は `ConnectionState`、`packages/collab/src/room/connectionState.ts`) に写し、最後に `super.onConnect` を呼ぶ。**ヘッダーが無い・役割が知らない値・メンバー (`via: member`) なのに userId が無い**接続 (Worker を通らずに来た) は `close(4000, "認証されていません")` で閉じる。
- チケットの本文は `iat` (ミリ秒。秒に丸めると kick との前後が曖昧になる) と `exp` (JWT の決まりどおり秒) を持つ。検証は署名・期限に加えて、本文の形 (`role` が既知、`via: member` なら `userId` あり、`guest` なら `via: link`) を見る。`TICKET_SECRET` は 32 文字以上で、短ければ発行は例外、検証は null。
- **取り消し (kick) の記録**: チケットは 60 秒使い回せるので、kick で閉じたあとに同じチケットで古い役割のままつなぎ直されうる。ルームは kick のたびに `revoked:user:<userId>` / `revoked:link` / `revoked:all` に `{ at: Date.now(), code, reason }` を DO storage に記録し (5 分より古い記録は次の kick で消す)、`onConnect` で `iat <= at` のチケットの接続を、記録した code で閉じる (`super.onConnect` を呼ぶ前)。kick のあとにチケットを取り直した接続は通る。
- ゲスト (`role: "guest"`) の `name` は、チケットの値ではなくルームが「ゲスト 1」「ゲスト 2」のように振る。**いまつながっているゲストの番号と重ならない最小の番号**で、抜けた人の番号は次の人が使う (接続順の厳密な通し番号ではない)。
- 閉じるコード (`packages/api/src/protocol.ts` の定数。server と ui が共有する):

| コード | 定数 | 意味 | つなぎ直したとき |
| --- | --- | --- | --- |
| 4000 | `CLOSE_UNAUTHENTICATED` | 認証されていない (ヘッダーが無い) | チケットを取り直す (画面は理由を出してホームへ戻す) |
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
    await this.ctx.storage.put("ydoc", Y.encodeStateAsUpdate(this.document));
    const model = rebuildModel(this.document);
    await this.ctx.storage.put("snapshot", model);
    await this.rotateSnapshots();
    await this.env.DB.prepare("update files set name = ?, updated_at = ? where id = ?").bind(model.meta.name, Date.now(), this.name).run();
  }
  onConnect(connection, ctx) {
    // ヘッダー → connection.setState。無ければ close(4000)。guest は「ゲスト N」を振る。最後に super.onConnect
  }
  isReadOnly(connection) { return !(role === "owner" || role === "editor"); }  // y-partyserver が step2 / update を捨てる
  // RPC (Worker から getServerByName で呼ぶ)
  async importModel(model: UntieModel) { loadModel(this.document, model); await this.onSave(); }
  async exportModel(): Promise<UntieModel> { ... }
  async rename(name: string) { this.document.getMap("meta").set("name", name); }
  async destroy() { await this.ctx.storage.deleteAll(); }
  async currentModel(): Promise<UntieModel> { return rebuildModel(this.document); }  // 保存を待たずにメモリ上の中身を読む
  async kick(target: { userId: string; reason?: "roleChanged" | "removed" } | { via: "link" } | { all: true }): Promise<number> { ... }   // 閉じた接続の数
  async presence(): Promise<{ userId: string | null; name: string; role: Role }[]> { ... }
}
```

- `isReadOnly` は `y-partyserver` (2.2.0) に組み込みの仕組みで、`true` の接続からの sync step2 と update を捨てる (step1 への返事と awareness は通る)。`onMessage` の上書きや `isDocWrite` は要らない。UntieRoom は接続の `state.role` が **owner / editor 以外ならすべて読み取り専用**にする (viewer・guest のほか、役割が無い・知らない役割の接続も)。awareness は viewer も送れる (選択が他の人に見える)。
- `hibernate` は付けない (awareness の状態をメモリに持つため)。誰もいなくなれば Durable Object は自然に落ち、次の接続で `onLoad` する。
- 不正な update はサーバーで個別に検査できない。守りは認証・役割・`repairModel`。`onSave` で `validateModel` に通らなければ、直前の正常な `ydoc` を残して記録する。
- `kick` の対象と閉じるコード: `{ userId }` (役割が変わった。`4001 "役割が変わりました"`)、`{ userId, reason: "removed" }` (メンバーから外した。`4003 "共有から外されました"`)、`{ via: "link" }` (リンク閲覧を無効にした・作り直した。ゲストと、リンクから開いたメンバーを `4004 "リンクが無効になりました"` で閉じる)、`{ all: true }` (ファイルをゴミ箱に入れた。全員を `4003 "ファイルがゴミ箱に入りました"` で閉じる)。`userId` は空でない文字列でなければならない (null でゲストを巻き込まない)。**不正な対象は Worker 側の `kickRoom` (`apps/server/src/rooms.ts`) で弾いて例外にする。ルームは警告を出して 0 を返す** (RPC の中で投げるとテスト基盤が未処理の拒否として数えるため)。どれも閉じた数を返し、取り消しの記録を残す (上記)。つなぎ直すとチケットの取得で新しい役割になる (外された・リンクなら 404、ゴミ箱なら 409)。
- **呼ぶ側**: `DELETE /api/files/:id` (ゴミ箱に入れる) は `kick({ all: true })` を呼ぶ。役割の変更 (`PUT /members/:userId`、`POST /invitations` が既存メンバーの役割を変えたとき)・譲渡 (両者)・メンバーを外す・リンクの無効化と作り直しからも呼ぶ (7.4)。DB を書き換えたあとに `kickRoom` を呼ぶので、つなぎ直しは新しい状態で判定される。
- `presence()` はいまつながっている接続の `{ userId, name, role }` の一覧 (同じ人が複数のタブなら、その数だけ出る)。`currentModel()` は保存を待たず、メモリ上の Y.Doc からモデルを作る (テストと確認用)。プレゼンスの表示そのもの (カーソル・選択) は awareness で運ぶ。

### 7.6 エラーの形と細部 (3 段階目の実装)

- **エラー**: `/api` の失敗はすべて `{ "error": { "code": "...", "message": "..." } }` (message は画面にそのまま出せる日本語)。`packages/api` の `ApiError` がこれを `status`・`code`・`message` で投げる。想定外の例外は `500`・`code: "internal"` で、内容はログにだけ出す。主な `code` (共有まわりの追加分も含む): `unauthenticated` / `session_expired` (401)、`csrf` / `forbidden` / `email_mismatch` (403。招待のメールが自分のと違う)、`file_not_found` / `not_found` / `user_not_found` (メンバーにする相手がユーザーでない) / `member_not_found` (外す・譲る相手がメンバーでない) / `invitation_not_found` / `link_not_found` (404)、`invalid_request` / `invalid_model` / `email_not_allowed` (400。招待のメールのドメインが `ALLOWED_EMAIL_DOMAINS` にない)、`not_in_trash` / `in_trash` / `broken_model` (409。複製元の中身が検証に通らないとき) / `transfer_first` (owner を外そうとした) / `owner_role_fixed` (owner の役割を変えようとした) / `in_trash` (ゴミ箱の中のファイルの共有を変えようとした) / `conflict` (譲渡が並行した操作と重なった) / `already_owner` (自分を招待・自分に譲ろうとした。owner のメールを招待したとき)、`invitation_expired` / `invitation_used` (410。招待の期限切れ・受けたあとに外された人が古い招待を使った)、`too_large` (413。`POST /files` と `PATCH /files/:id` の本文は 2 MB まで)。
- **ブラウザが直接開く `/auth/login`・`/auth/callback`・`/auth/dev` の失敗**は JSON ではなく、戻るリンク付きの小さな HTML で返す。
- **ログアウトは `/auth` の下**: `POST /auth/logout`、`POST /auth/logout-all` (7.4 の表の `/me/logout` ではなく)。`logout` はセッションが無くても成功し (204)、Cookie を消す。Cookie 認証なら `X-Requested-With` が要る。
- **レスポンス**: `POST /files` と `POST /files/:id/duplicate` は `201` と `FileSummary`。`PATCH /files/:id` と `POST /files/:id/restore` は `200` と `FileSummary`。`DELETE /files/:id` と `DELETE /files/:id/purge` は `204`。`GET /files/trash` は `{ files: FileSummary[] }`。`GET /files/:id` は `FileDetail` で、`members`・`invitations`・`link` は owner だけが受け取る。`PUT /files/:id/members/:userId` は `200` と `Member`、`POST /files/:id/transfer` は `200` と `FileSummary`、`DELETE …/members/:userId`・`DELETE …/invitations/:invitationId`・`DELETE …/link` は `204`。
- **完全削除はゴミ箱の中のファイルだけ**: ゴミ箱に入っていないファイルへの `purge` は `409 not_in_trash`。
- **開発用ログイン**: `DEV_LOGIN=true` で、かつリクエストのホストが localhost / 127.0.0.1 のときだけ `GET/POST /auth/dev` (メールと名前のフォーム) と `providers` の `dev` が有効。`false` なら `/auth/dev` は 404。ドメイン制限 (`ALLOWED_EMAIL_DOMAINS`) は Google と共通の `isEmailAllowed` を通る。
- **`untie_auth` Cookie** (OIDC の `state`・`nonce`・`code_verifier`・戻り先) は `Path=/auth`、10 分、`SESSION_SECRET` の HMAC 署名付き。戻り先 (`return`) は `#` で始まる相対のものだけ受ける。
- **`/parties/*`**: 7.5 のとおり。`/parties/untie-room/<id>` は WebSocket だけを受け、チケットが無効なら 401 (`invalid_ticket`)、別のファイルのチケットなら 403、HTTP は 401。`untie-room` 以外の名前空間は JSON の 404。
- **`POST /files/:id/ticket`**: `requireRole(..., "read")` を通り、`{ ticket, role, expiresAt }` (`TicketResponse`) を返す。`name` はユーザーの表示名。ゴミ箱の中のファイルは owner 以外は 404 (他の API と同じ)、owner には 409 `in_trash` (ゴミ箱の中のファイルは開けない。戻せば出る)。`name` が空ならメールアドレスの `@` より前 (メールアドレスそのものは他のメンバーに見せない)。

## 8. クライアント

### 8.1 画面の流れ

```
起動 ─> ホーム (ファイル一覧)            … ログイン済みならクラウドファイルの一覧。未ログインなら「ログイン」と「ローカルファイルを開く」
         ├ クラウドファイルを開く ─> エディタ (接続中)  … 役割が viewer なら閲覧専用の帯を出す
         ├ ローカルファイルを開く ─> エディタ (いまのまま)
         ├ 新規作成 ─> クラウド (ログイン済み) / ローカル
         └ ローカルファイルをクラウドへ (POST /files に model を送る)
エディタ ─ ツールバー左の「ホーム」でファイル一覧へ戻る。アカウントメニュー (名前・ログアウト) はホームの右上に置き、エディタには出さない (ホームのアカウントメニューで代える)
```

**ルート** (`packages/ui/src/router.ts`)。ハッシュで画面を分ける。サーバーには `#` の後ろが届かないので、どの URL も同じ `index.html` を返せばよい。サーバーが作る招待・リンクの URL は `/#/invite/<token>`・`/#/link/<token>` にする (`/invite/...` では開けない)。

| ハッシュ | 画面 |
| --- | --- |
| `#/` | ホーム。空や、読めないハッシュもここ。起動時にハッシュが無ければ `#/` にする |
| `#/local` | ローカル編集 (いまのエディタ) |
| `#/f/<fileId>` | クラウドファイル (4 段階目から同時編集。3 段階目は案内だけ) |
| `#/invite/<token>` | 招待を受ける (5 段階目。それまではホームを出す) |
| `#/link/<token>` | リンクで開く (5 段階目。それまではホームを出す) |

`fileId`・`token` は `/^[A-Za-z0-9_-]{1,64}$/` に合うものだけ受け、合わなければホームにする。

| 場所 | 内容 |
| --- | --- |
| ホーム | 「自分のファイル」「共有されたファイル」「ゴミ箱」のタブ。名前・更新日時・役割・メンバー。行の操作: 開く、名前を変える、複製、書き出す、共有、ゴミ箱へ。「最近開いたローカルファイル」もここに並べる |
| ログイン | 「Google でログイン」のボタン。デスクトップは「ブラウザでログインしています…」の待ち画面と、deep link が使えないときの引換コードの入力欄 |
| 共有ダイアログ | メンバー一覧 (名前・メール・役割の選択・外す)、メールアドレスと役割で招待、未承諾の招待の一覧と取り消し、所有者を譲る。「リンクを知っている人が閲覧できる」のスイッチと、リンクを写す・作り直す。owner だけ開ける |
| 招待を受ける画面 | `#/invite/<token>` を開くと、ログイン (必要なら) → 受けるかの確認 → 受けたらそのファイルを開く |
| リンクで開く画面 | `#/link/<token>` を開くと、ログインせずにそのままエディタ (閲覧専用) を開く。上の帯に「リンクで閲覧中。ログインすると複製できます」。ログイン済みでメンバーならその役割で開く |
| エディタ (クラウド) | ツールバーのタイトルの横に接続状態 (接続中 / 切断。再接続します)、役割、参加者の色玉 (title に名前。同じ人の複数のタブは 1 つ。ゲストは接続 id から決めた色)。viewer と guest は上に「閲覧専用です (役割: …)」の帯 (`role="status"`)。Undo / Redo は無効 (title「共有中は取り消せません」)。Cmd/Ctrl+S は書き出し。ファイルメニューは「ホーム」「JSON に書き出す」「クラウドへ保存 (複製)」だけ |
| カード・固定ボード | 他の人の選択を色付きの縁で出す (awareness) |
| プロパティ欄 | 他の人が同じ要素を**選んでいる**なら、要素の種類の横に「○○さんも選択中」を出す (awareness は選択しか運ばないので「編集中」とは言わない。ロックはしない)。viewer は入力欄をすべて読み取り専用にし、追加・削除・移動・関係のボタンを出さない |
| AI の設定 | いまのまま各自の API キー (キーチェーン / localStorage)。viewer はエージェントを開けない (質問だけなら将来) |

### 8.2 ストア

- `session` ストア (`packages/ui/src/cloud/session.ts`): `status: "unknown" | "anonymous" | "signedIn"`、`user`、`providers: ProviderId[]` (`GET /auth/providers`)、`hasServer` (`Platform.serverOrigin()` が空でないか。空なら API を呼ばず anonymous)、`error` (つながらない・ログイン方法を取れない、など)。起動時に `Root` が `load()` を呼び、`GET /auth/providers` と `GET /api/me` で決める (実行中に重ねて呼んでも 1 回だけ叩く)。`/api/me` が 401 なら anonymous で、失敗ではない。
- **401 の扱い**: 使っている途中の 401 (セッション切れ・別の端末でのログアウト) は `cloud/api.ts` の `onUnauthorized` 1 か所で受ける。`session` が anonymous に戻して「ログインの有効期限が切れました」を出し、`files` が一覧を空にする (両者は互いを import せず、この購読口だけでつながる)。`logout` / `logoutAll` は 401 を成功とみなして手元の状態を消す。
- `files` ストア (`cloud/files.ts`): `mine` / `shared` / `trash` / `loading` / `loaded` / `error` と、`refresh`・`create`・`rename`・`duplicate`・`exportToFile`・`trashFile`・`restore`・`purge`。操作の失敗は `ApiError.message` をそのままトーストに出す。書き出しは `files.export` で JSON を取って `parseModel` で検めてから `Platform.saveTextFile` へ渡す (ダウンロード URL は使わない。デスクトップでも動く)。モデルの名前が空なら「名前なし」にして送る。
- ローカルの編集 (ホーム画面まわり): ツールバーの「ホーム」は、未保存の変更があれば `confirmDiscard` で確かめ、破棄すると決めたら編集中のモデルを起動時のサンプル (未変更) に戻し、走っている AI エージェントを止めてから `#/` へ移る。`openDocument` / `openRecentDocument` は開けたら `true` を返す (ホームが `#/local` へ移るかの判定に使う)。閉じる前の確認 (`useCloseGuard`) は `Root` に置き、ホームでも効く。
- **`cloud: CloudInfo | null`** (`{ fileId, role, doc: Y.Doc, status: "loading" | "connecting" | "connected" | "offline", closed?: { code, reason }, link?: string }`)。ローカルなら null。当初の案の `document: { kind: "local" | "cloud" }` で `file` を包む形にはせず、いまの `file` / `savedModel` / `history` はそのまま、`cloud` を足すだけにした (ローカルのコードに触れない)。`status` は最初の同期が済むまで `loading`。他に `peers: Peer[]` (`{ clientId, userId, name, color, boardId, selection }`、自分を除く) と `pendingRemote` (ドラッグ中に届いた変更を後回しにしているか)。
- 関数: `loadCloudDocument(model, cloud)` (履歴・選択・ドラッグを捨てて開いた状態にする)、`setCloudStatus` / `setCloudRole` / `setCloudClosed` / `setPeers`、`applyRemoteModel(model)`、`closeCloud()` (起動時のサンプル・未変更に戻す。クラウドを開いていなければ何もしない。ローカルの編集中のモデルを壊さないため)。`newDocument` / `loadDocument` も `cloud` を外す。
- **書き込みの経路**: `dispatch` / `commitDrag` / `agentApply` は、`cloud` があれば結果を `applyModelDiff(doc, before, after, LOCAL_ORIGIN)` で Doc に書き、そのあと **`model = rebuildModel(doc, after)`** にする (Doc が正本。他の人の変更との合流、消した側が勝つ規則はここで揃う)。`history` には積まず、`endAgentEdit` も履歴を積まない。`previewNode` / `previewCommand` は Doc に書かない (表示だけ)。`commitDrag` が書くのは `dragBase` と確定後の差だけなので、ドラッグ中に届いた他の人の変更は消さない。
- **リモートの変更**: `attachCloudDoc` が `observeModelChanges` で `LOCAL_ORIGIN` 以外の変更を受け、`rebuildModel(doc, store.model)` を `applyRemoteModel` に渡す。ドラッグ中 (`dragBase` が非 null) は `pendingRemote` を立てて後回しにし (組み立て直しもしない)、`commitDrag` / `cancelDrag` が Doc から組み立て直す。`dispatch` はドラッグ中なら先に `commitDrag` するので、`before` が Doc とずれない (消えたものの復活を防ぐ。6 章)。AI エージェントの編集中 (`agentBase`) は後回しにせず、そのまま反映する。部分的な組み立て直し (`changed` の id だけ) はしない: 届く id と変わる範囲が一致しないため (6 章)。構造共有で変わった分だけが新しい参照になる。
- **閲覧専用**: セレクタ `selectReadOnly` (`cloud && !can(cloud.role, "edit")`)。`dispatch` / `agentApply` は `{ ok: false, reason: "閲覧専用です" }` を返し、`previewNode` / `previewCommand` / `commitDrag` / `beginAgentEdit` は何もしない。画面は `useUntieStore(selectReadOnly)` で出し分ける (入力欄の `readOnly`、追加・削除・移動・関係のボタンを出さない、キャンバスの `nodesDraggable` を切る、AI のボタンとペインを出さない)。選ぶことはできる。
- **Undo / Redo**: `cloud` があれば `undo` / `redo` は何もしない。
- **`hasUnsavedChanges`**: `cloud` があれば `cloud.status !== "connected" && cloud.dirtySinceOffline`。`dirtySinceOffline` は、つながっていない間 (`connected` でない間) に自分の書き込み (`dispatch` / `commitDrag` / `agentApply`) があると立ち、同期が済んで `connected` になると戻る。
- **役割が変わったとき** (`setCloudRole`): 閲覧専用になったら、途中のドラッグ (`cancelDrag`) と AI の編集を捨てる。閲覧専用のときの `commitDrag` も、`dragBase` を残さずドラッグを捨てる。
- 画面の `can(role, action)` は `cloud.role` から引く。ローカルは常に owner 相当。リンクで開いたときは `cloud.link: token` を持ち、チケットと書き出しを `/api/links/*` で取る (5 段階目)。
- `session.status === "anonymous"` でもリンクのファイルは開ける (5 段階目)。ホームは未ログインならログインとローカルファイルだけ出す。4 段階目の `#/f/<id>` は、未ログインならホームへ戻して「クラウドのファイルを開くにはログインしてください」を出す。
- クラウドファイルを開くと、ローカルの編集中のモデルはストアから置き換わる (戻るとサンプル)。そのため `CloudEditor` が、開く前に保存していない変更があれば `confirmDiscardIfDirty` で確かめ、断られたら `#/local` へ戻す (ホームの「開く」だけでなく、戻る/進む・URL の直打ちで来たときも守る)。

### 8.3 接続

実装は `packages/ui/src/cloud/collab.ts`。provider に依存しない中核 (`attachCloudDoc(doc, { fileId, role, link? })`: ストアへの取り付けと、リモートの変更の反映。戻り値の `detach()`) と、その外側 (`openCloudFile(fileId)` / `closeCloudFile()`: チケット・`YProvider`・接続の状態・プレゼンス) に分けてある。テストは中核に 2 つの Y.Doc をつなぎ、外側は偽の provider で確かめる。

- `openCloudFile` は先に `files.ticket(id)` を取り (401/403/404/409 ならその `ApiError` を投げる。何も付けない)、`new YProvider(host, fileId, doc, { party: "untie-room", protocol, disableBc: true, connect: false, params })` をつなぐ。`host` / `protocol` は `Platform.serverOrigin()` から決める。`params` は最初の 1 回は取ったチケットを使い、**再接続のたびに取り直す** (チケットは 60 秒で切れる)。取り直したチケットの `role` が変わっていたら、ストアの役割を更新する (切れている間に viewer から editor になった、など)。開く途中で `closeCloudFile()` や別の `openCloudFile()` が呼ばれたら、世代の番号で古い方が何も付けずに戻る (React の StrictMode でも二重につながない)。
- **接続の状態** (`cloud.status`): 最初の同期 (`sync` が true) までは `loading` (画面は「読み込み中…」。Doc が空のまま編集させない。15 秒たっても終わらなければ「サーバーにつながっていません」を添える)。以後は `status` イベントを写す: `disconnected` → `offline`、`connecting` → `connecting`、`connected` → 同期が済むまでは `connecting`、`sync` → `connected`。
- **閉じられたとき**: `connection-close` イベントの `code` が 4000〜4004 なら、再接続せず (`provider.disconnect()`)、`cloud.closed = { code, reason }` にする (`reason` はサーバーが付けた理由。空なら画面側の `CLOSE_REASONS`: 4000「認証されていません。ログインし直してください」、4001「役割が変わりました。開き直してください」、4003「共有から外されたか、ファイルがゴミ箱に入りました」、4004「リンクが無効になりました」)。`CloudEditor` が `closed` を見て、理由をトーストに出してホームへ戻す。再接続のチケットの取得が 401/403/404/409 だった場合 (切れている間に外された・ゴミ箱に入った、など) も、同じく `closed` にして再接続しない。4001 (役割が変わった) も開き直しではなくホームへ戻す (5 段階目で、その場で新しい役割につなぎ直すか決める)。
- **接続の状態は切れたら戻らない**: 一度 `offline` になったら、`connected` かつ同期済みになるまで、再接続を試している `connecting` も `offline` として扱う (再接続に失敗し続けても「接続しています」と出さない)。
- **ログイン中に開く前から走っていた AI** を止める: `openCloudFile` の先頭で `useAgentStore.getState().cancel()` を呼ぶ。止め損ねても、クラウドの `agentApply` は `beginAgentEdit` の間にしか書けず、開くと `agentBase` は捨てられる。
- **途中で失敗したとき**: `openCloudFile` が attach のあとで例外になったら、provider を `destroy` し、`detach()` と `doc.destroy()` をしてから投げる (ストアに `cloud` を残さない)。
- **取れなかったとき**: チケットが 401 ならホーム (ログイン欄)、403/404 ならホームへ戻して「このファイルは開けません」、409 なら「ゴミ箱の中のファイルです」。
- つながっていない間の編集は手元の Y.Doc に溜まり、つながると合流する。ただし**タブを閉じると失われる**ので、`hasUnsavedChanges` (8.2) が true の間は、閉じる前の確認 (`useCloseGuard`) と、ツールバーの「ホーム」の確認 (「つながっていない間の変更はまだ送れていません」) を出す。「つながっていません。変更は接続後に反映されます」の長期の帯 (10 分など) は**まだ入れていない** (いまはツールバーの「切断。再接続します」だけ)。
- **プレゼンス**: `awareness.setLocalState({ userId, name, color, boardId, selection })`。`color` はユーザー id (ゲストは awareness の clientId) の FNV-1a ハッシュで 8 色から決める。ストアの `ui.currentBoardId` と `ui.selection` を購読して `setLocalStateField` で更新する。`awareness.on("change")` で `peers` を組み立てる (自分を除く)。**自分の別のタブ** (`userId` が同じ) は他の人として数えず、`peers`・色玉・「〜さんも選択中」から除く (ゲストは `userId` が無いので clientId で区別する)。自分の状態だけが変わった `change` では組み立て直さず、前の `peers` と比べて変わっていなければ `setPeers` しない (変わっていない人の参照は使い回す)。カードは `usePeersSelecting(elementId)` (その要素の結果だけを返し、`useShallow` で比べる) を読むので、自分が選ぶたびに全カードが描き直されることはない。**プレゼンスは偽れる**: awareness はクライアントが書く値で、サーバーは中身を検めない (`userId` や名前を他人に見せかけることができる)。見た目の補助にとどめ、権限には使わない。5 段階目で、サーバーの `presence()` (接続のチケットから決めた `userId`・名前・役割) と照らして、偽りを表示から外す。他の人の状態は信用せず、形を確かめて作る (色は `#rrggbb` だけ受け、外れたら決め直す。選択は形が違えば外す)。表示は同じボードにいる人 (`peer.boardId === 開いているボード`) の選択だけ: 自由ボードのカード・枠と固定ボードのカード・枠に、その人の色の 2px の縁 (複数なら 2px ずつ外へ重ねる) と、右上に名前のラベルを出す。

### 8.4 デスクトップ固有

- サーバーの URL は設定画面で変えられる (既定は本番)。変えたらログアウトする。
- セッションのトークンと deep link の `state` はキーチェーンに置く。
- `tauri.conf.json` の CSP の `connect-src` にサーバーの `https://` と `wss://` を足す。`shell`/`opener` で既定のブラウザを開く (いまの `openExternalUrl`)。
- deep link: `tauri-plugin-deep-link` で `untie://` を登録。Mac は `.app` の Info.plist、Windows はレジストリに入る (署名なしでも動く)。

## 9. 配信とビルド

- **サーバー**: `pnpm --filter server deploy` = `pnpm --filter web build && wrangler deploy`。`wrangler.jsonc` に `assets` (`../web/dist`)、D1、Durable Object、`triggers.crons` (ゴミ箱の掃除、毎日)、`vars.ALLOWED_EMAIL_DOMAINS` (空) を書く。D1 は `--location apac` で作ったものをバインドする。secrets は `wrangler secret put`。
- **Web**: `apps/web` は Vite の成果物を作るだけ。`_headers` は `apps/server/public/` から静的ファイルと一緒に配る。CSP の `connect-src` に `'self'` と `wss:` の自分のオリジンを足す。`frame-ancestors 'none'` はいまのまま。
- **デスクトップ**: `apps/desktop` に `vite.config.ts` と `src-tauri/`。Release は `apps/desktop` で `tauri-action` を動かす (`projectPath` を変えるだけ)。
- **core / api / collab / ui**: ビルドせず、`apps/*` の Vite と Worker が TypeScript を直接取り込む (`exports` は `src/*.ts` を指す)。型検査はルートの `tsc -b` (ルートの `tsconfig.json` は各パッケージを references に並べるだけ) で行い、各パッケージの `tsconfig.json` は `tsconfig.base.json` を継承して `src` を見る。`composite` は使わない (パッケージ同士は `exports` 経由でソースを直接読むため)。core の `lib` は DOM 抜き (ES2022) にして、DOM に依存しないことを型検査で守る。
- **開発**: `pnpm dev` でルートから `wrangler dev` (server、D1 と DO はローカル) と `vite` (web、`/api`・`/auth`・`/parties` を wrangler に proxy) を同時に動かす。Google の OIDC はローカル用の client id を使い、redirect に `http://localhost:8787/auth/callback` を登録する。
- **CI**: `pnpm -r typecheck`、`pnpm -r test`、`check:types` (core)、`apps/server` の `wrangler deploy --dry-run`、`apps/desktop` の Vite ビルド。

## 10. セキュリティの要点

- セッションと招待のトークンは D1 にハッシュだけ置く。チケットと引換コードは短命の署名付き JWT で、保存しない。
- 権限の判定はサーバーの `requireRole` が正本。画面の `can` は見せ方だけ。
- OIDC は `state`・`nonce`・PKCE を必ず使い、`email_verified` を見る。
- リンク・招待のトークンは URL のパスに置かず `X-Untie-Token` ヘッダーで送る (パスは Workers のログに残る。画面の `/#/…` はハッシュなのでサーバーに届かない)。
- リンク閲覧のトークンは D1 にハッシュだけ置く。無効化と作り直しで即座に使えなくなり、ゲストの接続は切る。編集できるリンクは作らない。
- Web の API は SameSite=Lax の Cookie と `X-Requested-With` で CSRF を防ぐ。デスクトップは Bearer だけ (Cookie は使わない)。
- ゴミ箱の 30 日と完全削除は `destroy()` で Durable Object のストレージを消す。D1 の `files`・`file_members`・`invitations` も消す。
- AI の API キーはいままでどおり各自の端末にだけ置き、サーバーには送らない。
- ログ (Workers のログ) にトークン・チケット・メールの本文を出さない。
- Cloudflare Access を Worker の前にさらに置けるようにしておく (社内限定にしたいとき。Access の JWT があれば、それをログインの代わりにする拡張も可能)。

## 11. テスト

| 対象 | 内容 |
| --- | --- |
| 権限の規則 (`can`) | 3.2 の表をそのままテストにする |
| doc の往復 | `rebuildModel(applyModelDiff(a, b)) ≡ b` をサンプルと、コマンドをランダムに 1〜50 回当てたモデルで確かめる。順序キーの保持、`order` が JSON に漏れないこと |
| 合流 | Y.Doc を 2 つ作って別々のコマンドを当て、update を交換して同じモデルになること。同じ項目の後勝ち、別の項目はどちらも残ること |
| repairModel | 消えた要素を指す関係・ノード・対象・`bucId`・`contextId`、重複した関係、業務の無い BUC、ボード 0 枚 |
| ストア | いまの `store.test.ts` はそのまま通る (ローカルは変えない)。クラウドの `dispatch`・`commitDrag`・`agentApply` が Y.Doc に書き、他の Y.Doc の変更がストアに届く。viewer の `dispatch` が何もしない。Undo / Redo のボタンが無効で、ショートカットで何も変わらない |
| サーバー (`@cloudflare/vitest-pool-workers`) | ログイン (OIDC はモック)、セッションの期限、API の権限 (役割ごとに 7.4 の表を当てる)、招待の受理 (メール不一致は拒む)、所有者の譲渡、リンク閲覧 (有効・無効・作り直し、ゲストのチケットが guest になること、メンバーがリンクから開くと自分の役割になること、ゴミ箱の中は 404)、ゴミ箱と cron の掃除、チケットの検証、viewer と guest の update が捨てられること、`locationHint` が付くこと、`onSave` が D1 の名前と更新日時を書くこと |
| UI | 既存の Testing Library のテストはそのまま (Platform はテスト用の実装を渡す)。ホーム・ログイン・共有ダイアログ (リンクのスイッチを含む)・閲覧専用の帯・リンクで開く画面を足す |

## 12. 進め方

1. **モノレポ化** (振る舞いは変えない): `packages/core`・`packages/ui`・`apps/web`・`apps/desktop` に移し、`Platform` に `isTauri()` の分岐を集める。CI と Release の経路を直す。
2. **Y.Doc の往復** (まだつながない): `packages/collab/src/doc` を作り、往復と合流と `repairModel` のテストを通す。
3. **サーバーの土台とログイン**: `apps/server` (Hono、D1、Google OIDC、セッション)、`packages/api`、ホーム画面とログイン画面。この段階ではファイルは「作る・一覧・名前・書き出し・ゴミ箱」まで (1 人で使うクラウドファイル。中身はルームに置く)。
4. **同時編集**: `UntieRoom` への接続、ストアのクラウド経路、プレゼンス、サーバー側の `repairModel`、viewer の閲覧専用。
5. **共有**: メンバー・招待・譲渡・リンク閲覧の API と共有ダイアログ、役割が変わったときとリンクを無効にしたときの切断、リンクで開く画面。
6. **デスクトップ**: deep link でのログイン、キーチェーン、サーバー URL の設定。
7. **あとで**: Microsoft Entra ID、magic link、ドメインでの登録制限、フォルダ、名前・説明の文字単位の合流 (Y.Text)、オフライン時の手元キャッシュ、監査ログ、自社サーバーでの稼働 (Worker 一式を別アカウントに載せるだけ)。

## 13. 決めたことと残っていること

決めたこと (2026-10-31):

- ID プロバイダーは Google だけで始める。
- 登録はドメインで絞らない。
- リンクを知っている人の閲覧を入れる (3.6)。
- D1 と Durable Object は日本 (apac) に寄せる (3.7)。
- 使われないファイルを自動では消さない。
- viewer / guest の書き込みは `y-partyserver` 2.2.0 の `isReadOnly` で捨てる (確認済み。`onMessage` の上書きは要らない。7.5)。

残っていること:

- **Web 版でのローカルファイル**: ログイン前提のクラウド版にしても、Web でローカルの JSON を開く経路を残すか (本設計は残す)。
- **ゴミ箱の保持期間** (本設計は 30 日)。
- **AI の API キー**: いままでどおり各自の端末に置くか、将来サーバーで組織のキーを持つか。
