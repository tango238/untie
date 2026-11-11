# 検証: Pi Durable と Souther で、設計からアプリケーションが出来るか

untie の設計を材料に、[Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) (エージェントの実行基盤) がアプリケーションを作り、
業務ルールは [Souther](https://github.com/souther-lang/souther) のモデルを呼ぶ、という流れが実際に動くかを確かめたもの。
本体のワークスペース (`packages/*`・`apps/*`) には入れていない。検証のためのスクリプトと、その材料だけを置く。

確かめた日: 2026-11-11。Node 22.23、JDK 25 (Temurin)、Souther 0.4.1、souther-wasm-compiler 0.4.1、`@souther-lang/wasm` 0.4.1、Pi Durable 1.5.2。

## 確かめたこと

| # | 確かめたこと | 結果 |
| --- | --- | --- |
| 1 | untie が書き出した業務ルール (`workspace/design/sys_pms.sou`。宿泊サンプルの宿泊管理システム) を、Souther が受け付ける | 通った (`adequacy: satisfied`。7 つの操作) |
| 2 | そのモデルを WebAssembly にコンパイルできる (`souther compile --target wasm`) | 通った (`pms.wasm`、約 24 KB) |
| 3 | WebAssembly から TypeScript の呼び出しコードを作り、Node から呼べる | 通った (`workspace/model/pms.ts`)。分岐の結果も、設計のとおりに返る |
| 4 | Pi Durable が、ツール (read・write・bash) で作業フォルダにアプリケーションを書き、依存を入れ、テストを実行する | 通った (下の「台本」の注意を参照) |
| 5 | 出来上がったアプリケーションのテストが通り、起動して HTTP で呼べる | 通った (テスト 5 件。確定・取消・チェックインと、409・404・400) |
| 6 | 途中でプロセスが落ちても、同じストレージを開き直すと続きから終わる | 通った (テストの実行中に SIGKILL → 開き直して完了。台本のモデル) |
| 7 | **本物の LLM (Claude Sonnet 5.5) が、設計からアプリケーションを書く** | 通った。下の「本物の LLM での結果」 |

4〜6 は、モデルの応答をあらかじめ決めた「台本」(`harness/script.ts`。pi-ai の `fauxProvider`) で動かしている。書かれたコードは、この検証を作った側が用意したもので、
確かめているのは実行基盤が動くこと。7 が、本物の LLM に書かせたもの。

## 本物の LLM での結果 (Claude Sonnet 5.5)

`node run.ts llm` で、`harness/task.md` の依頼 (予約まわりの 7 つの操作の HTTP API を作る。業務ルールは書き直さずにモデルを呼ぶ。テストが通るまで直す) を渡した。
出来上がったものと記録は `results/sonnet-5-5/` にある (`app/`・`package.json`・`run.log`)。

| | |
| --- | --- |
| モデル | `claude-sonnet-5-5` (thinking は adaptive、Pi の thinkingLevel は medium) |
| かかった時間 | 約 3 分 (177 秒) |
| ツールの呼び出し | 25 回 (bash 21、write 4) |
| 費用 | 約 0.43 ドル (出力 25,477 トークン、キャッシュの読み 550,557・書き 49,456 トークン) |
| 出来たもの | `app/src/` 3 ファイル 251 行、テスト 259 行、README |
| テスト | 26 件。**エージェントの外で実行し直して、26 件とも通ることを確かめた** |
| 起動 | `node app/src/server.ts` で起動し、確定 → 取消 (取消料あり) → チェックイン → 状態違いの 409 → 入力の誤りの 400 を、HTTP で確かめた |

業務ルールの扱いは、依頼のとおりだった。`app/src/model.ts` は、操作の前提の状態と、結果がどの状態になるかを、WebAssembly のモデルの宣言 (surface) から読み、
条件の分かれ目はモデルに訊いている。アプリのコードに状態の名前を直に書いているのは、予約を作るときの最初の状態 (`仮予約`) の 1 か所だけ
(予約を登録する操作は別のシステムのもので、このモデルに無いため)。

Sonnet が見つけた設計の抜け (どれも、untie の書き出しを直す材料になる):

- **前提の状態を、モデルが断れない。** 状態はフィールドの無い data なので、TypeScript からはどの状態も `{}` になり、「確定」の操作に別の状態を渡しても通る。
  アプリは、モデルが宣言している前提の型と、今の状態を突き合わせて断っている。本来はモデルが答えるべきこと。
- **条件のときの別の結果に、状態が無い。** 設計は「取消料を請求に加えてから、予約を取り消す」だが、モデルが返すのは分岐の名前だけで、取消になるのかが分からない。
  Sonnet は推測せず、状態を変えないまま分岐の名前を返し、「決まっていないこと」に書いた。**代替パターンに、そのときの結果の状態を持たせる必要がある。**
- 条件 (取消料が発生するか・早めのチェックインができるか・満室か) は、何で判断するかが設計に無いので、呼び出す側が真偽値で渡す形になった。

## 確かめていないこと

- 本物の LLM で、途中で落として再開すること (6 は台本のモデルで確かめた)。
- Cloudflare の上で動かすこと (Durable Object に実行基盤、Containers に実行環境)。ここでは 1 つの Node のプロセスで動かした。
- 画面 (UI)・データベース。作ったのは、メモリに予約を持つ HTTP の API だけ。
- 条件の式・情報の項目・不変条件。Souther のモデルは、状態と、条件の真偽による分岐だけ (untie の今の書き出しの範囲)。

## 分かったこと (直すとよいところ)

1. **日本語の識別子は、TypeScript の型の名前では `_` の並びになる。** `souther-wasm-bindings` は、ASCII でない文字を `_` に置き換えるので、
   `export type _____ = "仮予約" | "確定" | …` のような、読めない名前になる。操作と型を引くキー (`m["予約を取り消す"]`) と値は日本語のままで、動きは正しい。
   実装から呼ぶモデルは、英語の名前で書き出すほうがよい (名前は AI が付け、日本語はコメントに残す)。
2. **状態を 1 つだけ返す操作は、結果が `{}` になる。** 出力の型が `確定` のように 1 つの場合 (フィールドの無い data) だと、値に名前が残らない。
   出力の型を状態のグループの和 (`予約の状態`) にすれば `"確定"` と返る。書き出しを直す余地がある。
3. **呼び出しコードは、アプリの中に置く必要がある。** `pms.ts` は `@souther-lang/wasm` を import するので、アプリの `node_modules` から引ける場所 (アプリのフォルダの中) に無いと動かない。
   台本では、最初に `model/` を `app/model/` へ写している。
4. **「出来ました」は当てにならない。** 台本の最初の版は、テストのコマンドとフォルダの置き方が誤っていて、テストは落ちていた。それでも実行基盤は「完了」と報告した
   (モデルが完了と言えば完了になる)。本物の LLM でも同じことが起きうるので、**出来上がったもののテストは、エージェントの外で実行し直して判定する** 必要がある。
5. **Pi Durable は AGENTS.md を読まない。** 実装するエージェントへの指示は、拡張の `section()` で渡す (`run.ts` の `untie-project`)。
6. **落ちたときの bash は、やり直されない。** 実行中だった bash は「中断された」という結果になり、モデルがもう一度呼ぶ。台本でも、開き直したあとにテストをやり直している。
7. **エージェントは、作業フォルダの外に出る。隔離は必須。** Sonnet の実行では、パッケージを探すために `find /` でファイルシステム全体を調べ、
   `cd ..` の勘違いで作業フォルダの親に入り、そこにファイルを書いてから移し、`/tmp` に試し書きのファイルを残した。壊れたものは無かったが、
   `run.ts` に入れた歯止め (作業フォルダの外のパスと、設定に触れるコマンドを断る) では防げていない (断れたのは 1 回だけ)。
   Pi Durable には権限の仕組みが無いので、本番では、会話ごとのコンテナに閉じ込める必要がある。
8. **シェルに、親プロセスの環境変数がそのまま渡る。** `NodeExecutionEnv` の `shellEnv` は、親の環境変数に重ねるだけで、置き換えない。
   API キーやほかの資格情報がエージェントのシェルから読めてしまうので、`run.ts` では、許したもの以外を空にして渡している (実際にシェルから見えないことを確かめた)。
9. **型の名前が読めないので、`as any` が増える。** 1 のとおり型の名前が `_` の並びになるため、Sonnet は呼び出しコードの型を使わず、`as any` で書いた (`model.ts` に 2 か所)。

## 動かし方

```sh
cd spikes/pi-durable-souther

# 1. 業務ルールを WebAssembly にする (JDK 25 と souther 0.4.1 が要る。済んだものを workspace/model に置いてあるので、飛ばしてもよい)
SOUTHER_BIN=/path/to/souther ./build-model.sh

# 2. Pi Durable で、アプリケーションを作る
cd harness && npm install
node run.ts full          # 最初から最後まで。workspace/app/ ができる

# 3. 出来上がったものを、外から確かめる
cd ../workspace/app && npm test
PORT=3456 node src/server.ts   # 別の端末で: curl -X POST localhost:3456/reservations -H 'content-type: application/json' -d '{"guest":"山田"}'

# 4. 途中で落ちても続きから終わるか
cd ../../harness && rm -rf ../workspace/app ../run.sqlite*
node run.ts crash         # テストの実行中に SIGKILL (終了コード 137)
node run.ts resume        # 同じストレージを開き直して、完了まで

# 5. 本物の LLM に書かせる (API の利用料がかかる。作業フォルダは、リポジトリの外に写したものを使う)
cp -r ../workspace/design ../workspace/model /path/to/empty-dir/
ANTHROPIC_API_KEY=... WORKSPACE=/path/to/empty-dir STORAGE=/path/to/run.sqlite node run.ts llm
```

本物の LLM で動かすときは、隔離された環境 (コンテナなど) の中で動かすこと。上の 7 のとおり、エージェントは作業フォルダの外にも触れる。

## 中身

- `workspace/design/` … untie から書き出した設計の材料 (操作・シーケンス図・実装を始める準備の状況、Souther のソース)
- `workspace/model/` … Souther のモデルを WebAssembly にしたものと、TypeScript の呼び出しコード (`build-model.sh` が作る)
- `harness/run.ts` … Pi Durable の実行基盤を開き、依頼を出して、完了を待つ。ストレージは SQLite、実行環境は Node (作業フォルダは `workspace/`)
- `harness/script.ts` … 台本 (モデルの応答)。書くアプリケーションのコードも、ここにある
- `harness/task.md` … 本物の LLM に渡す依頼
- `results/sonnet-5-5/` … Claude Sonnet 5.5 が作ったアプリケーション (`app/`) と、実行の記録 (`run.log`)
- `workspace/app/` … 出来上がるアプリケーション (コミットしない)
