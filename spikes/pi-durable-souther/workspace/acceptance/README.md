# 受け入れテスト

untie が、設計 (操作・状態・条件・代替パターン) から作ったテストです。出来上がったアプリケーションが設計のとおりに動くかを、
作る側が書いたテストとは別に確かめます。

- `*.cases.json` … ケースの一覧 (システムごとに 1 つ)。「この状態のものに、この条件で、この操作をしたら、結果と状態はこうなる」
- `run.test.ts` … ケースを 1 件ずつ当てる、テストの本体
- `driver.ts` … **実装する側が書くもの。** テストの本体と、アプリケーションをつなぐ

`*.cases.json` と `run.test.ts` は、書き換えないでください (設計を直して、untie から書き出し直します)。

## driver.ts の書き方

`run.test.ts` の `AcceptanceDriver` を満たすものを、既定の export にします。

```ts
import type { AcceptanceDriver } from "./run.test.ts";

const driver: AcceptanceDriver = {
  async run({ operation, states, conditions }) {
    // 1. states の状態のもの (予約など) を、アプリケーションに用意する
    // 2. conditions (条件の名前 → 満たすか) を渡して、operation (操作の名前) を行う
    // 3. 結果の種類と、アプリケーションに保存されている状態を読んで返す
    return { outcome: "done", states: {} };
  },
};
export default driver;
```

driver.ts は、利用者が使うのと同じ入口 (HTTP の API や画面) を通して、アプリケーションを動かします。
業務ルールを driver.ts の中で判断したり、アプリケーションを通さずに答えを作ったりしないでください (テストは通りますが、アプリケーションを確かめたことになりません)。

結果の種類 (`outcome`):

| 値 | 意味 |
| --- | --- |
| `done` | ふだんの結果 |
| `wrongState` | 前提の状態が違うので、行えない (状態は変えない) |
| `alternate` | 条件のときの別の結果。`condition` に、条件の名前を入れる |
| `error` | 条件のときの結果がエラー。`condition` と、`error` (種類と、サーバーエラーなら HTTP ステータス) を入れる |

`states` には、操作のあとの状態を、状態グループの名前ごとに入れます (アプリケーションに保存されているものを読むこと。操作の戻り値をそのまま返さない)。

## 動かし方

```sh
node --test acceptance/run.test.ts
```

「設計で決まっていないことが無い」が落ちるときは、`*.cases.json` の `pending` に挙がっていることを、設計で決めてください。
