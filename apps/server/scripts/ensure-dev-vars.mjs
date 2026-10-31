// .dev.vars (wrangler dev が読む開発用の値) が無ければ、見本の .dev.vars.example から写す。pnpm dev の最初に走る
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, ".dev.vars");
if (!existsSync(target)) {
  copyFileSync(join(root, ".dev.vars.example"), target);
  console.log(".dev.vars.example から .dev.vars を作りました (開発用。コミットしません)");
}
