// .dev.vars (wrangler dev が読む開発用の値) が無ければ、見本の .dev.vars.example から写す。pnpm dev の最初に走る。
// あっても、SESSION_SECRET / TICKET_SECRET が 32 文字未満なら警告を出し、見本の値に書き換える (他の行はそのまま)。
// 短いままだと、Worker が /api・/auth・/parties に 503 misconfigured を返す (docs/collab-design.md 7.1)
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, ".dev.vars");
const example = join(root, ".dev.vars.example");
const MIN_SECRET_LENGTH = 32;
const SECRETS = ["SESSION_SECRET", "TICKET_SECRET"];

/** `KEY=value` の行から値を引く (無ければ null)。引用符は外す */
function valueOf(lines, key) {
  const line = lines.find((l) => l.startsWith(`${key}=`));
  return line === undefined ? null : line.slice(key.length + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
}

if (!existsSync(target)) {
  copyFileSync(example, target);
  console.log(".dev.vars.example から .dev.vars を作りました (開発用。コミットしません)");
} else {
  const sample = readFileSync(example, "utf8").split(/\r?\n/);
  const lines = readFileSync(target, "utf8").split(/\r?\n/);
  const fixed = [];
  const next = lines.map((line) => {
    for (const key of SECRETS) {
      if (!line.startsWith(`${key}=`)) continue;
      if ((valueOf([line], key) ?? "").length >= MIN_SECRET_LENGTH) return line;
      fixed.push(key);
      return `${key}=${valueOf(sample, key)}`;
    }
    return line;
  });
  if (fixed.length > 0) {
    writeFileSync(target, next.join("\n"));
    console.warn(`警告: .dev.vars の ${fixed.join("・")} が ${MIN_SECRET_LENGTH} 文字未満だったので、.dev.vars.example の値に書き換えました (他の行はそのままです)`);
  }
}
