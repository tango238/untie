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
| `public/_headers` | `apps/server/public/_headers` |
| `scripts/gen-validator.mjs`、`gen:types` | `packages/core/` の scripts |

### 2.1 Platform インターフェース (ui が受け取る)

```ts
export interface Platform {
  kind: "web" | "desktop";
  openTextFile(): Promise<OpenedFile | null>;
  saveTextFile(text: string, path: string | null, suggestedName: string): Promise<SavedFile | null>;
  confirmDiscard(message: string, okLabel?: string): Promise<boolean>;
  openExternalUrl(url: string): Promise<void>;
  onCloseRequested(guard: () => Promise<boolean>): () => void;
  secrets: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> };
  recentFiles: RecentFileStore;
  /** サーバーの URL (Web は自分のオリジン、デスクトップは設定で変えられる) */
  serverOrigin(): string;
  /** ログイン。Web は同じタブで /auth/login へ移る。デスクトップは既定のブラウザを開いて deep link で戻る (7.3) */
  login(provider: ProviderId): Promise<void>;
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
| ユーザー | メールアドレスで一意。表示名とアイコンは ID プロバイダーからもらう。同じメールで別のプロバイダーからログインしても同じユーザー |
| ローカルファイル | いまの JSON ファイル。ログインしなくても使える。サーバーは関与しない |
| クラウドファイル | サーバーに置くファイル。id は `nanoid` 21 文字。中身は Durable Object (ルーム) に、名前・所有者・メンバーは D1 に置く。開くと常に同時編集の経路になる |
| メンバー | ファイルに付いたユーザーと役割。所有者は 1 人 (作った人。譲れる) |
| 招待 | まだユーザーでないメールアドレスへの共有。受けた人がログインすると、そのメールのメンバーになる |
| リンク閲覧 | 所有者が有効にしたファイルは、リンク (`/link/<トークン>`) を知っている人なら誰でも、ログインせずに閲覧できる。ゲストとして viewer 相当になる (3.6) |
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
| `snapshot:<日時>` | 1 時間ごとの `snapshot` の写し (直近 24 件) | 誤って消したときに、その時点の JSON を取り出す (クラウドファイルには Undo が無い) |

- 1 クラウドファイル = 1 Durable Object なので、ファイルの中身はその中で閉じる。モデルは数百 KB までなので、そのまま入る。R2 は使わない。
- Worker からルームへは `getServerByName(env.UntieRoom, fileId, { locationHint: "apac" })` で RPC を呼ぶ: `importModel(json)` (作成・複製)、`exportModel()` (書き出し。接続せずに読む)、`rename(name)`、`destroy()` (完全に消す)。
- ゴミ箱に入れても Durable Object は残す (戻せるように)。30 日経ったら Worker の cron (`scheduled`) が D1 から探して `destroy()` し、行を消す。

### 3.5 名前と更新日時

- 名前の正本はモデルの `meta.name` (Y.Doc の `meta`)。一覧の `files.name` はその写し。
- ルームが `onSave` で `files.name` と `files.updated_at` を D1 に書く (ルームにも D1 のバインディングを渡す)。
- 一覧から名前を変えるときは `PATCH /api/files/:id` がルームの `rename` を呼び、ルームが `meta.name` を書いて `onSave` で D1 に反映する。エディタで `meta.name` を変えたときも同じ経路で D1 に届く。

### 3.6 リンクを知っている人の閲覧

- 所有者が共有ダイアログで「リンクを知っている人が閲覧できる」を有効にすると、サーバーが 32 バイトの乱数のトークンを作り、SHA-256 を `files.link_token` に置く。URL は `https://<host>/link/<トークン>`。
- 無効にすると `link_token` を null にする。「リンクを作り直す」は新しいトークンに置き換える (前のリンクは使えなくなる)。
- リンクを開いた人は、ログインしていなくても閲覧できる。`POST /api/links/:token/ticket` はセッションが無くても通り、`{ fileId, userId: null, name: "ゲスト", role: "guest", via: "link" }` のチケットを返す。ログインしていて、かつそのファイルのメンバーなら、メンバーの役割のチケットを返す (editor がリンクから開いても編集できる)。
- ゲストはプレゼンスに「ゲスト」と番号で出る。書き出し (`GET /api/links/:token/export`) はできる。複製はログインしてから (「複製するにはログイン」を出す)。
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
- 課題の `analysis` (現象・所在・理由・影響) は項目ごとに別の人が埋めることがあるので、Y.Map にして項目ごとに後勝ちにする。

### 4.2 UntieModel との往復

`packages/collab/src/doc/` に純粋関数を置く。

| 関数 | 内容 |
| --- | --- |
| `loadModel(doc, model)` | JSON から読んだモデルを空の Y.Doc に入れる (順序キーを振る) |
| `rebuildModel(doc, prev?)` | Y.Doc からモデルを組み立てる。`prev` を渡すと、内容が同じ要素・関係・ボードは `prev` の参照を使い回す (React のメモ化と `===` 比較を生かす) |
| `applyModelDiff(doc, before, after, origin)` | 2 つのモデルを id 単位で比べ、違う項目だけを 1 つのトランザクションで Y.Doc に書く |
| `repairModel(model)` | 壊れた参照を見つけ、直すための変更の一覧を返す (6 章) |

往復の性質 `rebuildModel(applyModelDiff(doc, a, b)) ≡ b` をテストで固める (サンプルと、コマンドをランダムに当てたモデルで)。これが崩れると、自分の画面とほかの人の画面がずれる。

## 5. 編集の流れ (クラウドファイル)

```
コマンド (純粋関数)            Y.Doc (正本の写し)           ストア (表示用)
dispatch(cmd)
 ├ after = cmd(model)          applyModelDiff(before, after, origin=local)
 ├ model = after  ─────────────────────────────────────────> 即時反映 (差分適用と同じ結果になる前提)
 │                             ← 他の人の update / repair
 │                             doc.observeDeep → 変わった id だけ rebuildModel(doc, prev) ─> model
```

- **dispatch**: コマンドをいまのモデルに当て、成功したら結果を表示に出し、差分を `origin = local` のトランザクションで Y.Doc に書く。失敗 (`ok: false`) はいままでどおり何もしない。`viewer` のときは `dispatch` が何もせず `{ ok: false, reason: "閲覧専用です" }` を返す。
- **他の人の変更**: `observeDeep` のイベントから変わった id を集め、その分だけ組み立て直す。`reconcileUi` で選択やボードの参照先が消えていたら外す (既存の処理)。
- **ドラッグ中** (`previewNode` / `previewCommand`): Y.Doc には書かず表示だけ動かし、`commitDrag` で 1 トランザクションとして書く。ドラッグ中に同じノードを他の人が動かしたら、確定時に自分の座標で上書きする (後勝ち)。
- **AI エージェント** (`beginAgentEdit` 〜 `endAgentEdit`): 途中の `agentApply` は Y.Doc に書く (他の人にも見える)。`viewer` は使えない。
- **Undo / Redo**: クラウドファイルでは使えない。開いたときに履歴を捨て、ツールバーのボタンを無効にし、Cmd/Ctrl+Z・Shift+Cmd/Ctrl+Z・Ctrl+Y を無視する。
  - 理由: 共有中の Undo は「自分の変更だけを戻す」ことになるが、他の人の変更と絡むと結果が読めない (自分が足した作業を戻したら、他の人がそこに付けた課題の対象や関係が消える、など)。PoC では入れない。
  - 誤って消したときの戻し先は、書き出した JSON と、サーバーのスナップショット (3.4)。
- **ローカルファイルはいまのまま**: Y.Doc を持たない。`dispatch`・履歴・保存していない変更の判定 (`model === savedModel` の参照比較) は、いまのコードを変えない。ストアに `UntieDoc` が付いているときだけ、上の経路を通る。
- **保存していない変更**: クラウドファイルはサーバーが正本なので「未保存」の概念が無い。Cmd/Ctrl+S は「JSON に書き出す」になり、閉じる前の確認もしない。つながっていない間の変更は手元の Y.Doc に溜まり、つながると合流する。

## 6. 参照整合性

Yjs は「要素 A を消す」と「A への関係を足す」を両方受け入れるので、合流後に壊れた参照が残りうる。

- `repairModel` (core、純粋関数) が、いまの `validateModel` の参照整合性検査と同じ規則で壊れた箇所を見つけ、直し方を返す: 消えた要素を指す関係・ノード・`targetIds` は消す、消えた BUC を指す `bucId` と消えたコンテキストを指す `contextId` は `null` にする、業務が消えた BUC は消す、ボードが 0 枚なら「ボード 1」を作る。
- **直すのはサーバーだけ** (`UntieRoom` が update を受けるたびに、debounce して `origin = repair` で書く)。全員が直すと同じ修正が何度も流れる。
- クライアントの `rebuildModel` は、直されるまでの間 UI が壊れないよう、壊れた参照を表示から外す (消さない)。
- `addRelation` の重複検査など、コマンド側の検査はいままでどおり自分の手元のモデルに対して行う。同じ関係を 2 人が同時に足すと id が違う重複が残るので、`repairModel` が `sameRelation` で重複も畳む。
- id は `kind_` + 6 文字 (36^6 ≈ 22 億通り)。同時編集では別々の端末で同じ id を引く恐れがわずかにあるので 8 文字に伸ばす (JSON の形式は変わらない)。

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
- **Web**: `Set-Cookie: untie_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/`。API は Cookie で認証する。CSRF は SameSite=Lax に加え、状態を変える API は `X-Requested-With: untie` ヘッダーを要求する (フォームからは付けられない)。
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

すべて `/api/` の下。JSON。`requireSession` を通る。リクエストは `packages/api` の zod スキーマで検証する。

| メソッドとパス | 内容 | 必要な役割 |
| --- | --- | --- |
| `GET /me` | 自分のユーザー情報 | ログイン |
| `POST /me/logout`、`POST /me/logout-all` | ログアウト | ログイン |
| `GET /files` | 自分のファイルと共有されたファイル (`{ mine, shared }`)。名前・更新日時・役割・メンバー数 | ログイン |
| `POST /files` | 作る。`{ name }` で空のモデル、`{ model }` で JSON を取り込む (ローカルファイルをクラウドへ)。作った人が owner | ログイン |
| `GET /files/:id` | 1 件の情報 (名前・所有者・自分の役割・メンバー一覧は owner だけ) | member |
| `PATCH /files/:id` | 名前を変える | editor |
| `POST /files/:id/duplicate` | 複製して自分の owner のファイルにする | member |
| `GET /files/:id/export` | JSON (`serializeModel` と同じ整形)。`Content-Disposition` 付き | member |
| `DELETE /files/:id` | ゴミ箱へ | owner |
| `POST /files/:id/restore` | ゴミ箱から戻す | owner |
| `DELETE /files/:id/purge` | 完全に消す (Durable Object の `destroy`) | owner |
| `GET /files/trash` | ゴミ箱の一覧 | ログイン |
| `POST /files/:id/ticket` | ルームに接続するチケット (7.5) | member |
| `PUT /files/:id/members/:userId` | 役割を足す・変える (`{ role }`)。相手がユーザーでなければ 404 → 招待を使う | owner |
| `DELETE /files/:id/members/:userId` | 外す。自分を外すのは editor / viewer もできる | owner (自分なら member) |
| `POST /files/:id/transfer` | 所有者を譲る (`{ userId }`)。元の所有者は editor になる | owner |
| `PUT /files/:id/link` | リンク閲覧を有効にする (`{ regenerate?: true }` で作り直す)。リンクの URL を返す | owner |
| `DELETE /files/:id/link` | リンク閲覧を無効にする | owner |
| `POST /files/:id/invitations` | メールで招待する (`{ email, role }`)。既にユーザーならその場でメンバーにする。招待リンクを返す (メール送信は PoC では画面から写して送る) | owner |
| `DELETE /files/:id/invitations/:invitationId` | 招待を取り消す | owner |
| `POST /invitations/:token/accept` | 招待を受ける。ログイン中のメールと招待のメールが同じときだけ | ログイン |
| `GET /links/:token` | リンクのファイルの名前と自分の役割 (ゲストかメンバーか)。**セッション不要** | リンク |
| `POST /links/:token/ticket` | リンクで接続するチケット (3.6)。**セッション不要** | リンク |
| `GET /links/:token/export` | JSON に書き出す。**セッション不要** | リンク |

権限判定は `requireRole(fileId, "editor")` のようなミドルウェアで `file_members` を引き、`can(role, action)` で判定する。ゴミ箱の中のファイルは owner 以外は 404。`/links/*` だけは `requireSession` を通さず、トークンの SHA-256 で `files.link_token` を引く (無ければ 404)。

### 7.5 ルームへの接続

- ブラウザの WebSocket にはヘッダーを付けられないので、接続には **チケット** を使う: `POST /api/files/:id/ticket` (または `POST /api/links/:token/ticket`) が `{ fileId, userId, name, role, via: "member" | "link", exp: 60 秒 }` を `TICKET_SECRET` で署名した短い JWT を返し、クライアントは `wss://<host>/parties/untie-room/<fileId>?ticket=...` でつなぐ。Web もデスクトップも同じ。
- Worker 側は `routePartykitRequest(request, env, { locationHint: "apac", onBeforeConnect })` で、`onBeforeConnect` がチケットを検め、`x-untie-user`・`x-untie-name`・`x-untie-role`・`x-untie-via` のヘッダーを付けた Request に差し替えてルームへ渡す。合わなければ 401。チケットの `fileId` と URL のファイル id が違えば 403。
- ルームは `onConnect` でヘッダーを `connection.setState({ userId, name, role, via })` に写す。ゲストの `name` は「ゲスト 1」のように、ルームが接続順に番号を振る。

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
  onMessage(connection, message) {
    // 閲覧専用: 同期メッセージのうち step2 と update を捨て、step1 (読むための要求) と awareness だけ通す
    if ((connection.state.role === "viewer" || connection.state.role === "guest") && isDocWrite(message)) return;
    return super.onMessage(connection, message);
  }
  // RPC (Worker から getServerByName で呼ぶ)
  async importModel(model: UntieModel) { loadModel(this.document, model); await this.onSave(); }
  async exportModel(): Promise<UntieModel> { ... }
  async rename(name: string) { this.document.getMap("meta").set("name", name); }
  async destroy() { await this.ctx.storage.deleteAll(); }
}
```

- `isDocWrite` は y-protocols の形 (先頭の varuint が `0 = sync`、次が `1 = step2` か `2 = update`) を読むだけ。awareness (`1`) は viewer も送れる (選択が他の人に見える)。`YServer` の `onMessage` を上書きできることは実装前に `y-partyserver` の版で確かめる (できなければ `onBeforeConnect` で viewer を別の読み取り専用経路に回す)。
- `hibernate` は付けない (awareness の状態をメモリに持つため)。誰もいなくなれば Durable Object は自然に落ち、次の接続で `onLoad` する。
- 不正な update はサーバーで個別に検査できない。守りは認証・役割・`repairModel`。`onSave` で `validateModel` に通らなければ、直前の正常な `ydoc` を残して記録する。
- 役割が変わった (editor → viewer、外された) ときは、Worker がルームの `kick({ userId })` を呼び、その人の接続を閉じる。リンク閲覧を無効にしたときは `kick({ via: "link" })` でゲストを全員閉じる。つなぎ直すとチケットの取得で新しい役割になる (リンクなら 404)。

## 8. クライアント

### 8.1 画面の流れ

```
起動 ─> ホーム (ファイル一覧)            … ログイン済みならクラウドファイルの一覧。未ログインなら「ログイン」と「ローカルファイルを開く」
         ├ クラウドファイルを開く ─> エディタ (接続中)  … 役割が viewer なら閲覧専用の帯を出す
         ├ ローカルファイルを開く ─> エディタ (いまのまま)
         ├ 新規作成 ─> クラウド (ログイン済み) / ローカル
         └ ローカルファイルをクラウドへ (POST /files に model を送る)
エディタ ─ ツールバー左の「ホーム」でファイル一覧へ戻る。右端にアカウントメニュー (名前・ログアウト)
```

| 場所 | 内容 |
| --- | --- |
| ホーム | 「自分のファイル」「共有されたファイル」「ゴミ箱」のタブ。名前・更新日時・役割・メンバー。行の操作: 開く、名前を変える、複製、書き出す、共有、ゴミ箱へ。「最近開いたローカルファイル」もここに並べる |
| ログイン | 「Google でログイン」のボタン。デスクトップは「ブラウザでログインしています…」の待ち画面と、deep link が使えないときの引換コードの入力欄 |
| 共有ダイアログ | メンバー一覧 (名前・メール・役割の選択・外す)、メールアドレスと役割で招待、未承諾の招待の一覧と取り消し、所有者を譲る。「リンクを知っている人が閲覧できる」のスイッチと、リンクを写す・作り直す。owner だけ開ける |
| 招待を受ける画面 | `/invite/<token>` を開くと、ログイン (必要なら) → 受けるかの確認 → 受けたらそのファイルを開く |
| リンクで開く画面 | `/link/<token>` を開くと、ログインせずにそのままエディタ (閲覧専用) を開く。上の帯に「リンクで閲覧中。ログインすると複製できます」。ログイン済みでメンバーならその役割で開く |
| エディタ (クラウド) | ツールバーに接続状態 (接続中 / 切断。再接続します)、参加者の色玉 (ゲストは灰色)、役割。viewer と guest は上に「閲覧専用」の帯。Undo / Redo は無効。Cmd/Ctrl+S は書き出し |
| カード・固定ボード | 他の人の選択を色付きの縁で出す (awareness) |
| プロパティ欄 | 他の人が同じ要素を編集中なら名前の横に表示する (ロックはしない)。viewer は入力欄をすべて読み取り専用にする |
| AI の設定 | いまのまま各自の API キー (キーチェーン / localStorage)。viewer はエージェントを開けない (質問だけなら将来) |

### 8.2 ストア

- `session: { status: "unknown" | "anonymous" | "signedIn", user? }` を足す。起動時に `GET /me` で決める。401 なら anonymous。
- `document: { kind: "local", file } | { kind: "cloud", fileId, role, doc: UntieDoc, connection: status }` に、いまの `file` を広げる。
- `dispatch` / `commitDrag` / `agentApply` は `document.kind === "cloud"` のとき Y.Doc に書く。`role === "viewer"` なら何もしない。
- `history` はクラウドのとき空にし、積まない。
- `peers: Peer[]` (awareness から) を足し、カードと参加者の色玉が読む。
- 画面の `can(role, action)` は `document.role` から引く。ローカルは常に owner 相当。リンクで開いたときは `document.link: token` を持ち、チケットと書き出しを `/api/links/*` で取る。
- `session.status === "anonymous"` でもリンクのファイルは開ける。ホームは未ログインならログインとローカルファイルだけ出す。

### 8.3 接続

- `YProvider(serverOrigin, fileId, doc, { params: async () => ({ ticket: await api.ticket(fileId) }) })`。`params` は再接続のたびに呼ばれるので、チケットが 60 秒で切れても困らない。
- 401 / 403 で切られたら (役割が変わった・外された・セッション切れ)、再接続せずにホームへ戻し、理由をトーストで出す。
- つながっていない間の編集は手元の Y.Doc に溜まり、つながると合流する。長く切れていたら (例: 10 分) 「つながっていません。変更は接続後に反映されます」の帯を出す。
- プレゼンス: `{ userId, name, color, boardId, selection }`。色はユーザー id のハッシュから決める。

### 8.4 デスクトップ固有

- サーバーの URL は設定画面で変えられる (既定は本番)。変えたらログアウトする。
- セッションのトークンと deep link の `state` はキーチェーンに置く。
- `tauri.conf.json` の CSP の `connect-src` にサーバーの `https://` と `wss://` を足す。`shell`/`opener` で既定のブラウザを開く (いまの `openExternalUrl`)。
- deep link: `tauri-plugin-deep-link` で `untie://` を登録。Mac は `.app` の Info.plist、Windows はレジストリに入る (署名なしでも動く)。

## 9. 配信とビルド

- **サーバー**: `pnpm --filter server deploy` = `pnpm --filter web build && wrangler deploy`。`wrangler.jsonc` に `assets` (`../web/dist`)、D1、Durable Object、`triggers.crons` (ゴミ箱の掃除、毎日)、`vars.ALLOWED_EMAIL_DOMAINS` (空) を書く。D1 は `--location apac` で作ったものをバインドする。secrets は `wrangler secret put`。
- **Web**: `apps/web` は Vite の成果物を作るだけ。`_headers` は `apps/server/public/` から静的ファイルと一緒に配る。CSP の `connect-src` に `'self'` と `wss:` の自分のオリジンを足す。`frame-ancestors 'none'` はいまのまま。
- **デスクトップ**: `apps/desktop` に `vite.config.ts` と `src-tauri/`。Release は `apps/desktop` で `tauri-action` を動かす (`projectPath` を変えるだけ)。
- **core / api / collab / ui**: ビルドせず、`apps/*` の Vite と Worker が TypeScript を直接取り込む (`exports` は `src/*.ts` を指す)。型検査は tsconfig の project references でパッケージごとに行う。
- **開発**: `pnpm dev` でルートから `wrangler dev` (server、D1 と DO はローカル) と `vite` (web、`/api`・`/auth`・`/parties` を wrangler に proxy) を同時に動かす。Google の OIDC はローカル用の client id を使い、redirect に `http://localhost:8787/auth/callback` を登録する。
- **CI**: `pnpm -r typecheck`、`pnpm -r test`、`check:types` (core)、`apps/server` の `wrangler deploy --dry-run`、`apps/desktop` の Vite ビルド。

## 10. セキュリティの要点

- セッションと招待のトークンは D1 にハッシュだけ置く。チケットと引換コードは短命の署名付き JWT で、保存しない。
- 権限の判定はサーバーの `requireRole` が正本。画面の `can` は見せ方だけ。
- OIDC は `state`・`nonce`・PKCE を必ず使い、`email_verified` を見る。
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

残っていること:

- **Web 版でのローカルファイル**: ログイン前提のクラウド版にしても、Web でローカルの JSON を開く経路を残すか (本設計は残す)。
- **ゴミ箱の保持期間** (本設計は 30 日)。
- **AI の API キー**: いままでどおり各自の端末に置くか、将来サーバーで組織のキーを持つか。
- **`YServer.onMessage` の上書き**: 採用する `y-partyserver` の版で、viewer / guest の書き込みを捨てられるかを実装前に確かめる (7.5)。
