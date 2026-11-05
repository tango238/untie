// クラウド版: Web 版と同じ画面と Platform に、ログイン・クラウドファイル・共有・同時編集を足したもの。
// apps/server の Worker が、このビルド結果 (apps/cloud/dist) と API を同じオリジンで配る
import { createApp } from "@untie/ui";
import { webPlatform } from "@untie/web/platform";

createApp(webPlatform({ cloud: true }));
