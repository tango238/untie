# Aggregates

## 集約一覧

### Order (Bounded Context: 受注)

**日本語名**: 注文
**Root Entity**: 注文
**ID**: OrderId

**構成要素**:
- なし

**状態**: 注文の状態 (受付済 → 確定 → 入金済 → 出荷済 → 取消)

**ビジネス不変条件**:
- 入金済にできるのは、確定した注文だけ。
- 出荷済の注文は取り消せない。

**操作**:
- `placeOrder()`: 注文を受け付ける → 発行: `OrderPlaced`
- `confirmOrder()`: 注文を確定する → 発行: `OrderConfirmed`
- `cancelOrder()`: 注文を取り消す → 発行: `OrderCancelled`
- `markOrderPaid()`: 注文を入金済にする → 発行: `OrderPaid`

**他 Aggregate との参照**: 購入者 (集約にしていない情報), 商品 (集約にしていない情報), Shipment (ID で参照), ReturnRequest (ID で参照), Receivable (ID で参照), 損益計算書 (PL) (集約にしていない情報)

### ReturnRequest (Bounded Context: 受注)

**日本語名**: 返品
**Root Entity**: 返品
**ID**: ReturnRequestId

**構成要素**:
- なし

**状態**: 返品の状態 (返品受付 → 検品済 → 返金済)

**ビジネス不変条件**:
- 返品を受け付けるのは、返品の期間内の注文だけ。

**操作**:
- `acceptReturn()`: 返品を受け付ける → 発行: `ReturnAccepted`
- `inspectReturn()`: 返品を検品する → 発行: `ReturnInspected`

**他 Aggregate との参照**: Order (ID で参照)

### Stock (Bounded Context: 在庫)

**日本語名**: 在庫
**Root Entity**: 在庫
**ID**: StockId

**構成要素**:
- なし

**ビジネス不変条件**:
- 引き当てる数は、引き当てていない在庫の数を超えない。

**操作**:
- `receiveStock()`: 入荷を受け入れる → 発行: `StockReceived`
- `allocateStock()`: 在庫を引き当てる → 発行: `StockAllocated`

**英語名の無い操作 (図には出ない)**:
- 在庫数を更新する
- 棚卸の結果を記録する

**他 Aggregate との参照**: 商品 (集約にしていない情報)

### Shipment (Bounded Context: 出荷)

**日本語名**: 出荷
**Root Entity**: 出荷
**ID**: ShipmentId

**構成要素**:
- なし

**ビジネス不変条件**:
- 送り状を発行していない出荷は、出荷済にできない。

**操作**:
- `issueShippingLabel()`: 送り状を発行する → 発行: `ShippingLabelIssued`
- `shipOrder()`: 出荷する → 発行: `OrderShipped`

**他 Aggregate との参照**: Order (ID で参照)

### Receivable (Bounded Context: 会計)

**日本語名**: 売掛金
**Root Entity**: 売掛金
**ID**: ReceivableId

**構成要素**:
- なし

**状態**: 売掛金の状態 (未入金 → 一部入金 → 消込済)

**ビジネス不変条件**:
- 消し込む金額の合計は、売掛金の金額を超えない。

**操作**:
- なし

**英語名の無い操作 (図には出ない)**:
- 売掛金を登録する
- 売掛金を消し込む

**他 Aggregate との参照**: Order (ID で参照), Payout (ID で参照), 貸借対照表 (BS) (集約にしていない情報)

### Payout (Bounded Context: 会計)

**日本語名**: 入金
**Root Entity**: 入金
**ID**: PayoutId

**構成要素**:
- なし

**ビジネス不変条件**:
- 1 件の入金を、同じ売掛金へ 2 度消し込まない。

**操作**:
- なし

**英語名の無い操作 (図には出ない)**:
- 入金を登録する

**他 Aggregate との参照**: Receivable (ID で参照)

## 未解決の問い
- なし
