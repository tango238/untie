# 宿泊管理システム API (予約まわり)

業務ルール (前提の状態・状態の移り変わり・条件のときの別の結果) は `model/pms.wasm` が答える。アプリはモデルを呼び、結果を HTTP と、メモリ上のデータに写すだけ。

## 動かし方・テスト

```sh
npm start        # node app/src/server.ts  (PORT 環境変数、既定 3000)
npm test         # app/test/*.test.ts (HTTP を通すテスト)
node --test acceptance/run.test.ts   # 受け入れテスト (acceptance/driver.ts が HTTP で API を呼ぶ)
```

## API (JSON)

結果は `outcome`: `done` (200/201) / `alternate` (200、`condition` に条件名。状態の変わり方はモデルの答えのとおり) / `wrongState` (409)。
入力の誤り 400 `{error:{type:"input"}}`、無いもの 404 `{error:{type:"notFound"}}`。

| 操作 | API | 本体 |
| --- | --- | --- |
| 予約を登録 (仮予約を作る。予約サイトの代わり・確かめる用) | `POST /reservations` | `guest{name}`, `roomType`(シングル/ツイン/スイート), `checkIn`, `checkOut`(YYYY-MM-DD), `channel?`(電話/予約サイト/直接来館) |
| 予約を確定する | `POST /reservations/:id/confirm` | - |
| 予約を変更する | `PUT /reservations/:id` | guest/roomType/checkIn/checkOut/channel のうち 1 つ以上 |
| 予約を取り消す | `POST /reservations/:id/cancel` | `cancellationFee: boolean` (取消料が発生するか、呼び出す側が渡す)、`cancellationFeeAmount?` 整数 |
| チェックインを記録する | `POST /reservations/:id/check-in` | `earlyCheckInAllowed: boolean`、`guest?` |
| 部屋の割り当てを記録する | `POST /rooms/:id/assign` | `reservationId`、`full: boolean` (満室か) |
| 追加料金を登録する | `POST /reservations/:id/charges` | `description`、`amount` 整数 |
| チェックアウトを記録する | `POST /reservations/:id/check-out` | - |
| 予約・部屋を見る | `GET /reservations`, `GET /reservations/:id`, `GET /rooms`, `GET /rooms/:id` | |
| 部屋を用意する (状態は渡す) | `POST /rooms` | `type`, `state` |
| 【確かめる用】状態を指定して予約を用意する | `POST /test-setup/reservations` | 予約の登録と同じ + `state`, `roomId?` |

## 決まっていないこと

- 取消料が発生するか・早めのチェックインができるか・満室かの判断式: 設計に式が無いので、呼び出す側が真偽で渡す。
- 取消料・追加料金の金額の扱い (単位・上限・負の値・取消料の額の出どころ): 整数ならよしとし、請求には記録するだけ (請求金額の計算・請求書は作らない)。取消料の額は省略できる (null で記録)。
- 部屋の「満室」を部屋タイプごとの空きから求める方法。
- チェックアウトの部屋: 予約に割り当てた部屋 (`roomId`) があれば 清掃待ち にする。割り当てが無くてもチェックアウトはできる (設計に無い)。
- 部屋の割り当て時に、予約の状態・部屋タイプの一致を確かめるか (設計は「予約を取得」とだけ)。予約があることだけ確かめる。
- 日付の前後 (チェックアウトがチェックインより後か) の検査はしていない。
- 料金プラン・画面・データベース (設計の「まだ決まっていないこと」): 作らない。データはプロセスのメモリ上のみ。
