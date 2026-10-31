# Untie 同時編集 (PartyServer) 設計書

複数人が同じモデルを同時に編集できるようにする。あわせて、デスクトップ (Tauri)・Web・共通部分・同時編集の 4 つをディレクトリで分けて管理できるようにする。本文書は [docs/design.md](design.md) の続きで、そこに書いてあることは繰り返さない。

## 1. 決めたこと

| 項目 | 決定 |
| --- | --- |
| 同期の方式 | Yjs (CRDT) を使い、サーバーは `y-partyserver` の `YServer` (Durable Object) で動かす |
| 正本 | 共有中はサーバーの Y.Doc。ローカル編集中もアプリ内の Y.Doc を正本にし、`UntieModel` はそこから組み立てる読み取り用の形にする (ローカルと共有で同じコード経路) |
| 編集 API | いまの `commands.ts` (純粋関数) をそのまま使う。コマンドの結果と直前のモデルの差分を Y.Doc に書く |
| 保存形式 | JSON ファイルの形式 (`schema/untie.schema.json`、`version: 1`) は変えない。Y.Doc は通信と合流のための表現で、ファイルには出さない |
| 衝突 | 項目ごとに後勝ち (Yjs の Y.Map)。名前と説明は文字単位では合流しない (入力確定が 500 ms / blur 単位なので衝突は稀) |
| Undo / Redo | `Y.UndoManager` で自分の変更だけを戻す (他の人の変更は戻さない) |
| 参照整合性 | Yjs の合流は構造を知らないので、合流後に壊れた参照 (消えた要素を指す関係など) をサーバーが直す (`repairModel`) |
| 配信 | Web 版を Cloudflare Pages から Workers (static assets) に移し、同じ Worker に Durable Object を同居させる。デスクトップ版も同じ Worker につなぐ |
| 認証 (PoC) | 推測できないルーム id + ルームごとの招待トークン。Cloudflare Access をかけられる構成にしておく |

### 1.1 方式の比較

| | Yjs + y-partyserver (採用) | コマンド中継 (サーバーが `commands.ts` を順に適用して配る) |
| --- | --- | --- |
| 合流 | 項目ごとに自動 | サーバーで直列化。楽観的に当てたコマンドの巻き戻し・再適用を自分で作る |
| 再接続・オフライン | ライブラリが持つ | 自分で作る |
| プレゼンス (誰がどこを見ているか) | awareness が持つ | 自分で作る |
| Undo | `Y.UndoManager` | コマンドごとの逆操作を自分で作る (約 20 本) |
| 参照整合性 | 合流後に直す処理が要る | サーバーで常に保てる |
| 既存コードへの影響 | ストアの中身を Y.Doc 裏打ちに替える | コマンドを関数から「名前 + payload」のデータに変える |

コマンド中継は整合性で勝るが、PoC で自作する部分 (楽観適用の巻き戻し、逆操作、再接続) が多い。Yjs は整合性を直す処理だけ足せばよく、PartyServer が公式に用意している道でもある。

## 2. ディレクトリ構成 (pnpm ワークスペース)

```
untie/
├ packages/
│  ├ core/        @untie/core    … モデル (型・スキーマ・id・関係ルール・コマンド・検証・固定ボード・分析・トレース)、サンプル
│  │                               DOM にも React にも依存しない。サーバーもここを使う
│  ├ collab/      @untie/collab  … 同時編集。core にだけ依存する
│  │  ├ src/doc/                  … UntieDoc: Y.Doc ⇄ UntieModel の橋渡し (diff・apply・rebuild)、repairModel、順序キー
│  │  ├ src/client/               … 接続 (y-partyserver/provider)、プレゼンス、ルームの作成・参加・書き出しの API 呼び出し
│  │  ├ src/server/               … UntieRoom (YServer を継承した Durable Object)、認証、永続化、HTTP API
│  │  └ src/protocol.ts           … ルーム id・トークン・プレゼンスの型、URL の形
│  └ ui/          @untie/ui      … React の画面と zustand ストア、io (開く・保存)、ai。Web とデスクトップで共通
│                                   プラットフォーム依存の処理は `Platform` インターフェースで受け取る (2.1)
├ apps/
│  ├ web/                         … Vite のエントリ + Cloudflare Worker (静的配信 + Durable Object のマウント)、wrangler.jsonc、_headers
│  └ desktop/                     … Vite のエントリ + src-tauri (Rust)。Platform の Tauri 実装
├ schema/untie.schema.json        … 変えない (core が参照)
├ docs/
└ pnpm-workspace.yaml, package.json (ルートは scripts と devDependencies だけ)
```

依頼の「共通の core」は `core` と `ui` の 2 つに分ける。サーバー (Durable Object) が core を取り込むので、core に React や DOM が入っていると Worker のバンドルに引きずられる。画面は `ui` に置き、Web とデスクトップはどちらも `ui` を使う。

いまの `src/` との対応:

| いま | 移動先 |
| --- | --- |
| `src/model/`、`src/sample/` | `packages/core/src/` |
| `src/components/`、`src/store/`、`src/ai/`、`src/io/`、`src/styles/`、`src/App.tsx` | `packages/ui/src/` |
| `src/io/file.ts`・`recent.ts`・`useCloseGuard.ts`・`ai/keys.ts` の `isTauri()` 分岐 | `apps/web/src/platform.ts` と `apps/desktop/src/platform.ts` に分割 |
| `src/main.tsx`、`index.html`、`vite.config.ts` | `apps/web/` と `apps/desktop/` にそれぞれ |
| `src-tauri/` | `apps/desktop/src-tauri/` |
| `public/_headers` | `apps/web/public/_headers` |
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
  /** 共有サーバーの URL (Web は自分のオリジン、デスクトップは設定で変えられる) */
  collabHost(): string;
}
```

`ui` のエントリは `createApp(platform)` で、`apps/web/src/main.tsx` と `apps/desktop/src/main.tsx` がそれぞれの実装を渡す。いまの `isTauri()` 分岐はすべてこの実装側に移す。

### 2.2 パッケージ間の依存

```
apps/web ─┬─> ui ─┬─> core
          │       └─> collab (client, doc)
          └─> collab (server)   … Worker のエントリから UntieRoom を export する
apps/desktop ──> ui
```

`collab` は `exports` で `.` (doc + client) と `./server` を分け、`./server` だけが `partyserver` / `y-partyserver` / `cloudflare:workers` に依存する。`ui` から `./server` は取り込まない。

## 3. データの表現

### 3.1 Y.Doc の形

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

### 3.2 UntieModel との往復

`packages/collab/src/doc/` に純粋関数を置く。

| 関数 | 内容 |
| --- | --- |
| `loadModel(doc, model)` | JSON から読んだモデルを空の Y.Doc に入れる (順序キーを振る) |
| `rebuildModel(doc, prev?)` | Y.Doc からモデルを組み立てる。`prev` を渡すと、内容が同じ要素・関係・ボードは `prev` の参照を使い回す (React のメモ化と `===` 比較を生かす) |
| `applyModelDiff(doc, before, after, origin)` | 2 つのモデルを id 単位で比べ、違う項目だけを 1 つのトランザクションで Y.Doc に書く |
| `repairModel(model)` | 壊れた参照を見つけ、直すための変更の一覧を返す (4 章) |

往復の性質 `rebuildModel(applyModelDiff(doc, a, b)) ≡ b` をテストで固める (サンプルと、コマンドをランダムに当てたモデルで)。これが崩れると、自分の画面とほかの人の画面がずれる。

## 4. 編集の流れ

```
コマンド (純粋関数)            Y.Doc (正本)                 ストア (表示用)
dispatch(cmd)
 ├ after = cmd(model)          applyModelDiff(before, after, origin=local)
 ├ model = after  ─────────────────────────────────────────> 即時反映 (差分適用と同じ結果になる前提)
 │                             ← 他の人の update / undo / repair
 │                             doc.observeDeep → 変わった id だけ rebuildModel(doc, prev) ─> model
```

- **dispatch**: コマンドをいまのモデルに当て、成功したら結果を表示に出し、差分を `origin = local` のトランザクションで Y.Doc に書く。失敗 (`ok: false`) はいままでどおり何もしない。
- **他の人の変更**: `observeDeep` のイベントから変わった id を集め、その分だけ組み立て直す。`reconcileUi` で選択やボードの参照先が消えていたら外す (既存の処理)。
- **ドラッグ中** (`previewNode` / `previewCommand`): Y.Doc には書かず表示だけ動かし、`commitDrag` で 1 トランザクションとして書く。ドラッグ中に同じノードを他の人が動かしたら、確定時に自分の座標で上書きする (後勝ち)。
- **AI エージェント** (`beginAgentEdit` 〜 `endAgentEdit`): 途中の `agentApply` は Y.Doc に書き (他の人にも見える)、Undo の単位は `UndoManager.stopCapturing()` で区切って 1 件にまとめる。
- **Undo / Redo**: `Y.UndoManager(doc, { trackedOrigins: new Set([local]) })`。自分の変更だけを戻す。ドラッグ中は無視する (既存)。履歴上限 100 件は UndoManager の `captureTimeout` ではなくスタック長で切る。
- **保存していない変更の判定**: いまは `model === savedModel` の参照比較だが、Y.Doc 経由では Undo で戻っても参照が変わる。ローカル編集では保存時のモデルと内容比較 (`JSON.stringify` の比較で足りる大きさ) にする。共有中はサーバーが正本なので「未保存」の概念は無く、Cmd+S は「手元に書き出す」になる。
- **ローカル編集もこの経路**にする。ファイルを開く = 新しい Y.Doc に `loadModel`。新規作成 = 空の Y.Doc。接続は無い。これで「共有を始める」が、いま開いているモデルの Y.Doc に接続を付けるだけで済む。

## 5. 参照整合性

Yjs は「要素 A を消す」と「A への関係を足す」を両方受け入れるので、合流後に壊れた参照が残りうる。

- `repairModel` (core、純粋関数) が、いまの `validateModel` の参照整合性検査と同じ規則で壊れた箇所を見つけ、直し方を返す: 消えた要素を指す関係・ノード・`targetIds` は消す、消えた BUC を指す `bucId` と消えたコンテキストを指す `contextId` は `null` にする、業務が消えた BUC は消す、ボードが 0 枚なら「ボード 1」を作る。
- **直すのはサーバーだけ** (`UntieRoom` が update を受けるたびに、debounce して `origin = repair` で書く)。全員が直すと同じ修正が何度も流れる。
- クライアントの `rebuildModel` は、直されるまでの間 UI が壊れないよう、壊れた参照を表示から外す (消さない)。
- `addRelation` の重複検査など、コマンド側の検査はいままでどおり自分の手元のモデルに対して行う。同じ関係を 2 人が同時に足すと id が違う重複が残るので、`repairModel` が `sameRelation` で重複も畳む。
- id は `kind_` + 6 文字 (36^6 ≈ 22 億通り)。同時編集では別々の端末で同じ id を引く恐れがわずかにあるので 8 文字に伸ばす (JSON の形式は変わらない)。

## 6. サーバー (packages/collab/src/server)

```ts
export class UntieRoom extends YServer {
  static callbackOptions = { debounceWait: 2000, debounceMaxWait: 10000 };

  async onLoad() {
    const saved = await this.ctx.storage.get<Uint8Array>("ydoc");
    if (saved) Y.applyUpdate(this.document, saved);
    this.document.on("update", (_u, origin) => { if (origin !== "repair") this.scheduleRepair(); });
  }
  async onSave() {
    await this.ctx.storage.put("ydoc", Y.encodeStateAsUpdate(this.document));
    await this.ctx.storage.put("snapshot", rebuildModel(this.document)); // 書き出し・管理用
  }
  async onRequest(request) { /* GET /export → JSON、GET /meta → 名前と人数 */ }
}
```

| 項目 | 内容 |
| --- | --- |
| ルーム | `UntieRoom` の名前 = ルーム id (`nanoid` 21 文字)。URL は `/parties/untie-room/<roomId>` |
| 作成 | `POST /api/rooms` に JSON のモデルを送ると、ルームを作って `loadModel` し、`{ roomId, token }` を返す。Worker の `fetch` で受け、`getServerByName` で DO を呼ぶ |
| 参加 | `routePartykitRequest` の `onBeforeConnect` で `?token=` をルームの DO storage にある招待トークンと照合する。合わなければ 401 |
| 書き出し | `GET /parties/untie-room/<roomId>/export` で JSON (`serializeModel` と同じ整形)。トークン必須 |
| 永続化 | Durable Object の SQLite ストレージ (`ctx.storage`)。モデルは小さい (数百 KB まで) のでそのまま入れる。R2 は使わない |
| 休止 | `hibernate` は付けない (awareness の状態をメモリに持つため)。誰もいなくなれば DO は自然に落ち、次の接続で `onLoad` する |
| 不正な update | Yjs の update はサーバーで個別に検査できない。守りは認証 (招待された人だけ) と `repairModel`。`onSave` で `validateModel` に通らなければ、直前の正常な update を残して記録する |

Worker のエントリ (`apps/web/worker/index.ts`):

```ts
export { UntieRoom } from "@untie/collab/server";
export default {
  async fetch(request, env) {
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    return (await routePartykitRequest(request, env, { onBeforeConnect: checkToken })) ?? env.ASSETS.fetch(request);
  },
};
```

`wrangler.jsonc` は `assets` (Vite の dist、`not_found_handling: "single-page-application"`)、`durable_objects.bindings` に `UntieRoom`、`migrations` に `new_sqlite_classes: ["UntieRoom"]`。

## 7. クライアント (packages/collab/src/client)

- **接続**: `YProvider(host, roomId, doc, { params: { token } })`。`y-partyserver/provider` が再接続と再同期を持つ。
- **状態**: `connecting` / `connected` / `offline` をストアの `collab` に持ち、ツールバーに出す。切れている間も編集はでき、つながれば合流する。
- **プレゼンス** (awareness): `{ name, color, boardId, selection, cursor? }`。名前は初回に聞く (localStorage / 設定に残す)。選んでいる要素は他の人のカードに色付きの縁で出す。自由ボードのカーソルは後回し。
- **ルームの参加の仕方**: Web は `https://<host>/#/r/<roomId>?t=<token>` を開く。デスクトップは「ファイル > 共有に参加」でリンクを貼る (deep link `untie://r/...` は後回し)。
- **共有を始める**: 「ファイル > 共有を始める」が `POST /api/rooms` に今のモデルを送り、返ってきたルームに今の Y.Doc をつなぐ。リンク (トークン付き) をクリップボードに写す。
- **最近開いたファイル**にルームも並べる (`{ kind: "room", roomId, token, name }`)。トークンはデスクトップではキーチェーン、Web では IndexedDB に置く。
- **手元に書き出す**: 共有中の Cmd+S は JSON を手元に保存する (正本はサーバー)。「共有をやめる」で接続を切り、手元のモデルとして続ける。

## 8. UI の変更点 (packages/ui)

| 場所 | 変更 |
| --- | --- |
| ストア | `model` の裏に `UntieDoc` を持つ。`dispatch` / `undo` / `redo` / `commitDrag` / `agentApply` が Y.Doc を通る。`history` は UndoManager のスタック長 (`canUndo` / `canRedo`) に置き換える。`collab: { status, roomId, peers }` を足す |
| ツールバー | ファイルメニューに「共有を始める」「共有に参加」「共有をやめる」「リンクを写す」。右に接続状態と参加者の色玉 |
| カード・固定ボード | 他の人の選択を色付きの縁で出す |
| プロパティ欄 | 他の人が同じ要素を編集中なら名前の横に表示する (ロックはしない) |
| 閉じる前の確認 | 共有中は未保存の概念が無いので確かめない (ローカル編集はいままでどおり) |
| 新規作成・開く | 共有中なら先に「共有をやめる」を挟む |

## 9. 配信とビルド

- **Web**: Pages から Workers に移す。`pnpm --filter web deploy` = `vite build && wrangler deploy`。`_headers` は Workers の static assets でも効く。CSP の `connect-src` に `wss:` の自分のオリジンを足す (`'self'` は ws/wss も含むが明示する)。
- **デスクトップ**: `apps/desktop` に `vite.config.ts` と `src-tauri/`。`tauri.conf.json` の `frontendDist` は `../dist`。CSP の `connect-src` に共有サーバー (`https://` と `wss://`) を足す。共有サーバーの URL は設定で変えられるようにし、既定は本番の Worker。
- **core / collab / ui**: ビルドせず、`apps/*` の Vite と Worker が TypeScript を直接取り込む (`exports` は `src/*.ts` を指す)。型検査は tsconfig の project references でパッケージごとに行う。
- **CI**: `pnpm -r typecheck`、`pnpm -r test`、`check:types` (core)、`apps/web` の `wrangler deploy --dry-run`、`apps/desktop` の Vite ビルド。Release は `apps/desktop` で `tauri-action` を動かす (`projectPath` を変えるだけ)。

## 10. テスト

| 対象 | 内容 |
| --- | --- |
| doc の往復 | `rebuildModel(applyModelDiff(a, b)) ≡ b` をサンプルと、コマンドをランダムに 1〜50 回当てたモデルで確かめる。順序キーの保持、`order` が JSON に漏れないこと |
| 合流 | Y.Doc を 2 つ作って別々のコマンドを当て、update を交換して同じモデルになること。同じ項目の後勝ち、別の項目はどちらも残ること |
| repairModel | 消えた要素を指す関係・ノード・対象・`bucId`・`contextId`、重複した関係、業務の無い BUC、ボード 0 枚 |
| Undo | 自分の変更だけ戻る。他の人の変更が間に入っても壊れない。ドラッグ・AI の編集が 1 件になる |
| ストア | いまの `store.test.ts` が Y.Doc 裏打ちでも通る (履歴上限の扱いだけ書き換える) |
| サーバー | `@cloudflare/vitest-pool-workers` で `UntieRoom` の作成・参加 (トークンの可否)・書き出し・再読み込み |
| UI | 既存の Testing Library のテストはそのまま (Platform はテスト用の実装を渡す) |

## 11. 進め方

1. **モノレポ化** (振る舞いは変えない): `packages/core`・`packages/ui`・`apps/web`・`apps/desktop` に移し、`Platform` に `isTauri()` の分岐を集める。CI と Release の経路を直す。
2. **Y.Doc 裏打ち** (まだつながない): `packages/collab/src/doc` を作り、ストアを Y.Doc 経由に替える。Undo を UndoManager に替える。往復と合流のテストを通す。ここまでは利用者から見て何も変わらない。
3. **サーバーと接続**: `UntieRoom`、Worker のエントリ、`POST /api/rooms`、`YProvider`、「共有を始める / 参加 / やめる」。Web を Workers に移す。
4. **使い勝手**: プレゼンス (選択の表示・参加者)、最近開いたルーム、デスクトップの設定画面 (サーバー URL)、書き出し、サーバー側の `repairModel`。
5. **あとで**: 名前・説明の文字単位の合流 (Y.Text)、deep link、オフライン時の手元キャッシュ (`y-indexeddb` / ファイル)、Cloudflare Access での利用者制限、自社サーバーでの稼働 (DO クラスは `collab/server` にあるので、別の Worker に載せるだけ)。

## 12. 決めてもらいたいこと

- **誰が入れるか**: リンク (トークン付き) を知っている人なら誰でも、で始めてよいか。社内限定なら Cloudflare Access を Worker の前に置く。
- **Pages から Workers への移行**: Durable Object は Workers にしか置けないので移す前提で書いた。Pages を残すなら同時編集用の Worker を別に立てる (`apps/collab-server` に `wrangler.jsonc` を置くだけで、コードは変わらない)。
- **デスクトップ版の既定サーバー**: 本番の Worker に固定するか、初回に入力させるか。
- **AI エージェントの編集を共有中にどう見せるか**: そのまま流す (本設計) か、確定するまで手元に留めるか。
