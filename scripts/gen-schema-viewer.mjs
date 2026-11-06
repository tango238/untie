// schema/untie.schema.json と関係の規則 (relations.ts) から docs/schema-viewer.html を作る。
// 使い方: pnpm gen:schema-viewer
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(resolve(root, "schema/untie.schema.json"), "utf8"));
const rulesSrc = readFileSync(resolve(root, "packages/core/src/model/relations.ts"), "utf8");

const rules = [...rulesSrc.matchAll(/\{\s*kind:\s*"(\w+)",\s*sources:\s*\[([^\]]*)\],\s*targets:\s*\[([^\]]*)\],\s*label:\s*"([^"]*)",\s*undirected:\s*(true|false)\s*\}/g)].map((m) => {
  const list = (s) => [...s.matchAll(/"(\w+)"/g)].map((x) => x[1]);
  return { kind: m[1], sources: list(m[2]), targets: list(m[3]), label: m[4], undirected: m[5] === "true" };
});
const kinds = schema.$defs.relationKind.enum;
if (rules.length !== kinds.length || kinds.some((k) => !rules.some((r) => r.kind === k))) {
  throw new Error(`relations.ts の規則 (${rules.length}) がスキーマの relationKind (${kinds.length}) と合いません`);
}

// </script> が JSON の中に出ても HTML を壊さないようにする
const json = (v) => JSON.stringify(v).replace(/</g, "\\u003c");
const html = readFileSync(resolve(root, "scripts/schema-viewer.template.html"), "utf8")
  .replace("/*SCHEMA*/null", () => json(schema))
  .replace("/*RULES*/null", () => json(rules));
writeFileSync(resolve(root, "docs/schema-viewer.html"), html);
console.log(`docs/schema-viewer.html を作りました (関係の規則 ${rules.length} 件)`);
