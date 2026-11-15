# @untie/appkit

untie が設計から作るアプリケーションの、共通の仕組みです。ログイン (SSO のトークンの確認)・権限・監査の記録を、システムごとに作らせずに、ここに任せます。
設計は [docs/design.md](../../docs/design.md) の 6.1「共通の仕組み」にあります。

- Node でも Cloudflare Workers でも動くよう、Web 標準の API と [jose](https://github.com/panva/jose) だけを使います。
- untie の本体からは使いません。あとで別リポジトリへ切り出せるよう、ほかのパッケージには依存しません (テストだけが `@untie/core` を使います)。

```ts
import { authenticate, createOperations, createTokenVerifier, memoryAuditSink } from "@untie/appkit";
import policy from "./design/sys_pms.access.json" with { type: "json" }; // untie が書き出した権限表

const verify = createTokenVerifier({ issuer, audience, keys: new URL(jwksUrl), systemId: policy.systemId });
const ops = createOperations({ policy, audit: memoryAuditSink() });

// 設計の操作を 1 つ行うたびに、入口を 1 回通る (権限の判定 → 処理 → 監査の記録)
const principal = await authenticate(request, verify); // 通らなければ 401
await ops.run({ principal, operation: "uc_confirm_reservation" }, async (ctx) => {
  // …処理…
  ctx.record({ targets: [{ information: "info_reservation", key: id }], after: { 予約の状態: "確定" } });
}); // 権限が無ければ 403
```
