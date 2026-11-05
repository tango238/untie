// Web 版: ローカルのファイルだけを編集する (ログイン・クラウドの機能は出さない)。Cloudflare Pages で静的に配る。
// クラウド版 (apps/cloud) も同じ Platform を cloud: true で使う
import { createApp } from "@untie/ui";
import { webPlatform } from "./platform";

createApp(webPlatform());
