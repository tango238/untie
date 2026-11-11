# Event Storming

Untie の業務分析 (RDRA) から導いたものです。イベントの並びは時系列ではなく、分析の並び順です。

## Domain Events (時系列)

### 受注
1. OrderPlaced — 注文を受け付けた
2. OrderConfirmed — 注文が確定した
3. OrderCancelled — 注文が取り消された
4. ピッキングの指示が出た
5. ReturnAccepted — 返品を受け付けた
6. ReturnInspected — 返品の検品が済んだ
7. OrderPaid — 注文が入金済になった

### 在庫
1. StockReceived — 入荷を受け入れた
2. 在庫数が変わった
3. 棚卸の数が記録された
4. StockAllocated — 在庫が引き当てられた

### 出荷
1. ShippingLabelIssued — 送り状が発行された
2. OrderShipped — 出荷した

### 決済
1. PaymentConfirmed — 入金が確認された

### 会計
1. 売掛金が計上された
2. モールからの入金が登録された
3. 売掛金が消し込まれた
4. 月次の締めが済んだ
5. 月次の数字が報告された

## Command / Event マトリクス

| Actor | Command | Aggregate | Event | 備考 |
|-------|---------|-----------|-------|------|
| 倉庫担当・仕入先 | receiveStock | Stock | StockReceived | 入荷を受け入れる |
| 倉庫担当 | 在庫数を更新する | Stock | 在庫数が変わった |  |
| 倉庫担当・店長 | 棚卸の結果を記録する | Stock | 棚卸の数が記録された |  |
| 受注担当・購入者 | placeOrder | Order | OrderPlaced | 注文を受け付ける |
| 受注担当 | confirmOrder | Order | OrderConfirmed | 注文を確定する |
| 受注担当 | cancelOrder | Order | OrderCancelled | 注文を取り消す |
| System | allocateStock | Stock | StockAllocated | 在庫を引き当てる。OrderConfirmed がきっかけ (自動) |
| 倉庫担当・配送業者 | issueShippingLabel | Shipment | ShippingLabelIssued | 送り状を発行する |
| 受注担当・購入者 | shipOrder | Shipment | OrderShipped | 出荷する |
| カスタマーサポート・購入者 | acceptReturn | ReturnRequest | ReturnAccepted | 返品を受け付ける |
| 倉庫担当 | inspectReturn | ReturnRequest | ReturnInspected | 返品を検品する。ReturnAccepted がきっかけ (人が判断) |
| TBD | markOrderPaid | Order | OrderPaid | 注文を入金済にする。あるべき姿 (分析に無い)。PaymentConfirmed がきっかけ (自動) |
| System | 売掛金を登録する | Receivable | 売掛金が計上された | OrderShipped がきっかけ (自動) |
| 経理担当 | 入金を登録する | Payout | モールからの入金が登録された |  |
| 経理担当 | 売掛金を消し込む | Receivable | 売掛金が消し込まれた | モールからの入金が登録された がきっかけ (人が判断) |

## 発見された問題点
- 「入金を記録する」(対象: 決済サービス) は「注文の状態」を「入金済」へ変えますが、決済サービス は「注文」の保存先ではありません
- 「返金を記録する」(対象: 決済サービス) は「返品の状態」を「返金済」へ変えますが、決済サービス は「返品」の保存先ではありません
- 「出荷を記録する」は「注文の状態」を「出荷済」へ変えますが、書くのは「出荷」で、持ち主の「注文」は書きません
- 「売掛金を消し込む」は「売掛金の状態」の「未入金」「一部入金」で実行でき、「一部入金」「消込済」へ変えますが、どの組み合わせかが決まりません
- コンテキスト「注文」に状態グループが 2 つあります (「注文の状態」「返品の状態」)
- 「ピッキングリストを出す」は情報を取得するだけですが、「ピッキングの指示が出た」を発生させます
- 「月次の数字を報告する」は情報を取得するだけですが、「月次の数字が報告された」を発生させます
- 「在庫数を更新する」を 3 つの作業 (「商品を棚に収める」「在庫数を更新する」「在庫に戻す」) が使っています
- 「問い合わせを記録する」を 3 つの作業 (「問い合わせに答える」「配送状況を調べる」「対応を記録する」) が使っています
- 「注文」と「購入者」を「注文を登録する」が一緒に書きます
- 「在庫を引き当てる」は条件「在庫が足りない」で判断しますが、結果のイベントは「在庫が引き当てられた」だけです
- 「ピッキングリストを出す」は条件「ギフト包装の指定がある」で判断しますが、結果のイベントは「ピッキングの指示が出た」だけです
- 「返品を登録する」は条件「返品の期間内である」で判断しますが、結果のイベントは「返品を受け付けた」だけです
- 「出荷」(出荷) の語が、別のコンテキストの「出荷済」(注文)にも出ています
- 「入金」(会計) の語が、別のコンテキストの「入金済」(注文)「入金が確認された」(注文)にも出ています

## Bounded Context 候補
- 受注: OrderPlaced, OrderConfirmed, OrderCancelled, ピッキングの指示が出た, ReturnAccepted, ReturnInspected, OrderPaid
- 在庫: StockReceived, 在庫数が変わった, 棚卸の数が記録された, StockAllocated
- 出荷: ShippingLabelIssued, OrderShipped
- 決済: PaymentConfirmed
- 会計: 売掛金が計上された, モールからの入金が登録された, 売掛金が消し込まれた, 月次の締めが済んだ, 月次の数字が報告された

## 未解決の問い
- なし
