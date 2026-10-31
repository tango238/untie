// public/_headers を、Worker が配信する apps/web/dist に写す (Web のビルドのあとに実行する)
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "../web/dist");
mkdirSync(dist, { recursive: true });
const source = join(root, "public/_headers");
if (!existsSync(source)) throw new Error(`${source} がありません`);
copyFileSync(source, join(dist, "_headers"));
console.log("_headers を apps/web/dist に写しました");
