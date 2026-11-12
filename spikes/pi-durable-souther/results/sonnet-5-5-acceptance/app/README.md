# 宿泊管理システム 予約まわり API

業務ルール (前提の状態・状態の移り変わり・条件の分岐) は `model/pms.wasm` が答える。app/ は入出力と、メモリ上の保存だけ。

## 動かし方・テスト
```sh
npm start            # node app/src/server.ts (PORT 環境変数、既定 3000)
npm test             # app/test/*.test.ts
node --test acceptance/run.test.ts   # 受け入れテスト (acceptance/driver.ts が HTTP で駆動)
```

## API (JSON)
結果: `{"outcome": "done"|"alternate"|"wrongState", "condition"?, "reservation"?, "room"?}`。
`done`/`alternate` は 200、前提の状態が違うと `wrongState` で 409 (状態は変えない)。入力の誤りは 400、無いものは 404 (`{"outcome":"error","error":{"type","message"}}`)。

| メソッド・経路 | 内容 | 本文 |
| --- | --- | --- |
| POST /reservations/:id/confirm | 予約を確定する | — |
| POST /reservations/:id/change | 予約を変更する | checkInDate, checkOutDate, roomType, guestName のうち 1 つ以上 (文字列) |
| POST /reservations/:id/cancel | 予約を取り消す | `cancellationFeeApplies` (真偽, 必須), `cancellationFee` (数, 任意)。true なら outcome=alternate (condition=取消料が発生する)、予約は取消になり取消料が請求 (charges) に加わる |
| POST /reservations/:id/check-in | チェックインを記録する | `earlyCheckInAllowed` (真偽, 必須), `guestName` (任意)。false なら alternate (早めのチェックインができる)、状態は変わらない |
| POST /rooms/:id/assign | 部屋の割り当てを記録する | `fullHouse` (真偽, 必須), `reservationId` (任意。結びつける) 。true なら alternate (満室である) |
| POST /reservations/:id/charges | 追加料金を登録する | `description` (文字列), `amount` (0 以上の数) |
| POST /reservations/:id/check-out | チェックアウトを記録する | — 予約に結びついた部屋があれば清掃待ちになる |
| GET /reservations/:id, GET /rooms/:id | 今の状態を見る | |
| POST /dev/reservations | (確かめる用) 予約を用意 | `state` (既定 仮予約), `roomId`, `guestName` |
| POST /dev/rooms | (確かめる用) 部屋を用意 | `state` (既定 準備完了) |

## 決まっていないこと
- 「取消料が発生する」「早めのチェックインができる」「満室である」を何で判断するか: 設計に無いので、呼び出す側が真偽で渡す。取消料の金額も呼び出す側が渡す (任意)。
- 予約の登録 (仮予約を作る操作)・部屋の準備完了にする操作・宿泊者名簿は、対象外。予約と部屋は dev API で用意する。
- 予約と部屋の結びつき: 設計に無い。割り当て時の `reservationId` か dev 作成時の `roomId` で結ぶ。結びついていなければチェックアウトは部屋を変えない。
- 変更できる項目、請求の金額計算・請求書・料金プラン (出どころが未定) は扱わない。追加料金は金額と内容を記録するだけ。
- 追加料金は「チェックイン済」の予約に対してだけ受け付ける (モデルの前提)。
