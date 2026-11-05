// public/_headers を、Worker が配信する apps/cloud/dist に写す (クラウド版の画面のビルドのあとに実行する)
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "../cloud/dist");
mkdirSync(dist, { recursive: true });
const source = join(root, "public/_headers");
if (!existsSync(source)) throw new Error(`${source} がありません`);
copyFileSync(source, join(dist, "_headers"));
console.log("_headers を apps/cloud/dist に写しました");
