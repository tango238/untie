# Domain Events

## イベント一覧

### 受注

#### OrderPlaced
- **日本語名**: 注文を受け付けた
- **発生元 Aggregate**: Order
- **トリガー**: placeOrder

#### OrderConfirmed
- **日本語名**: 注文が確定した
- **発生元 Aggregate**: Order
- **トリガー**: confirmOrder
- **Consumer**: 在庫
- **ポリシー**: allocateStock (自動)

#### OrderCancelled
- **日本語名**: 注文が取り消された
- **発生元 Aggregate**: Order
- **トリガー**: cancelOrder

#### ピッキングの指示が出た
- **トリガー**: TBD

#### ReturnAccepted
- **日本語名**: 返品を受け付けた
- **発生元 Aggregate**: ReturnRequest
- **トリガー**: acceptReturn
- **ポリシー**: inspectReturn (人が判断)

#### ReturnInspected
- **日本語名**: 返品の検品が済んだ
- **発生元 Aggregate**: ReturnRequest
- **トリガー**: inspectReturn

#### OrderPaid
- **日本語名**: 注文が入金済になった
- **発生元 Aggregate**: Order
- **トリガー**: markOrderPaid

### 在庫

#### StockReceived
- **日本語名**: 入荷を受け入れた
- **発生元 Aggregate**: Stock
- **トリガー**: receiveStock

#### 在庫数が変わった
- **発生元 Aggregate**: Stock
- **トリガー**: 在庫数を更新する

#### 棚卸の数が記録された
- **発生元 Aggregate**: Stock
- **トリガー**: 棚卸の結果を記録する

#### StockAllocated
- **日本語名**: 在庫が引き当てられた
- **発生元 Aggregate**: Stock
- **トリガー**: allocateStock

### 出荷

#### ShippingLabelIssued
- **日本語名**: 送り状が発行された
- **発生元 Aggregate**: Shipment
- **トリガー**: issueShippingLabel

#### OrderShipped
- **日本語名**: 出荷した
- **発生元 Aggregate**: Shipment
- **トリガー**: shipOrder
- **プロパティ**:
  - `出荷`
  - `出荷日`
- **Consumer**: 会計
- **ポリシー**: 売掛金を登録する (自動)

### 決済

#### PaymentConfirmed
- **日本語名**: 入金が確認された
- **トリガー**: 外部 (このコンテキストの外で発生する)
- **Consumer**: 受注
- **ポリシー**: markOrderPaid (自動)

### 会計

#### 売掛金が計上された
- **発生元 Aggregate**: Receivable
- **トリガー**: 売掛金を登録する

#### モールからの入金が登録された
- **発生元 Aggregate**: Payout
- **トリガー**: 入金を登録する
- **ポリシー**: 売掛金を消し込む (人が判断)

#### 売掛金が消し込まれた
- **発生元 Aggregate**: Receivable
- **トリガー**: 売掛金を消し込む

#### 月次の締めが済んだ
- **トリガー**: TBD

#### 月次の数字が報告された
- **トリガー**: TBD

## Event Flow (コンテキスト間)

<!-- ddd:diagram:event-flow -->

受注 --{OrderConfirmed}--> 在庫
出荷 --{OrderShipped}--> 会計
決済 --{PaymentConfirmed}--> 受注

## 未解決の問い
- イベント「在庫数が変わった」の英語名が決まっていません
- イベント「棚卸の数が記録された」の英語名が決まっていません
- イベント「ピッキングの指示が出た」の英語名が決まっていません
- イベント「売掛金が計上された」の英語名が決まっていません
- イベント「モールからの入金が登録された」の英語名が決まっていません
- イベント「売掛金が消し込まれた」の英語名が決まっていません
- イベント「月次の締めが済んだ」の英語名が決まっていません
- イベント「月次の数字が報告された」の英語名が決まっていません
