# Context Map

## 図

<!-- ddd:diagram:context-map -->

## 関係一覧

| Upstream | Downstream | 関係 | 統合方式 | 備考 |
|----------|-----------|------|---------|------|
| 受注 | 在庫 | Customer-Supplier | Messaging | 注文が確定したら、在庫を引き当てる。 |
| 決済 | 受注 | Anticorruption Layer | Messaging | 決済サービスの通知 (Webhook) を、受注の言葉 (入金済) に訳す。 |
| 受注 | 出荷 | Customer-Supplier | RPC | 出荷は、注文の届け先を読む。 |
| 出荷 | 会計 | Published Language | Messaging | 出荷したら、会計が売掛金を計上する。 |
| 受注 | 会計 | Conformist | File | 会計は、注文のデータをそのままの形で取り込む。 |

## 統合の詳細

### 受注 → 在庫
- **関係**: Customer-Supplier
- **流れるデータ**: 注文が確定した、注文 (取得)
- **統合方式**: Messaging
- **ACL の有無**: なし
- **補足**: 注文が確定したら、在庫を引き当てる。

### 決済 → 受注
- **関係**: Anticorruption Layer
- **流れるデータ**: 入金が確認された
- **統合方式**: Messaging
- **ACL の有無**: あり
- **補足**: 決済サービスの通知 (Webhook) を、受注の言葉 (入金済) に訳す。

### 受注 → 出荷
- **関係**: Customer-Supplier
- **流れるデータ**: 注文 (取得)
- **統合方式**: RPC
- **ACL の有無**: なし
- **補足**: 出荷は、注文の届け先を読む。

### 出荷 → 会計
- **関係**: Published Language
- **流れるデータ**: 出荷した
- **統合方式**: Messaging
- **ACL の有無**: なし
- **補足**: 出荷したら、会計が売掛金を計上する。

### 受注 → 会計
- **関係**: Conformist
- **流れるデータ**: 注文 (取得)
- **統合方式**: File
- **ACL の有無**: なし
- **補足**: 会計は、注文のデータをそのままの形で取り込む。

## 未解決の問い
- なし
