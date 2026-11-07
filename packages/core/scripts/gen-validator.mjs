// スキーマ検証関数を事前に生成する (ajv standalone)。
// アプリの CSP は eval を許さないので、実行時に ajv.compile() できない。
// 生成物: packages/core/src/model/schemaValidator.gen.js (pnpm gen:types で型と一緒に作り直す。検証関数だけなら packages/core の gen:validator)
import Ajv2020 from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";
import { readFileSync, writeFileSync } from "node:fs";

const schema = JSON.parse(readFileSync(new URL("../../../schema/untie.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false, code: { source: true, esm: true, lines: true } });
ajv.addSchema(schema);

// ルートの検証と、要素の種類ごとの検証 (エラーを読みやすく言い直すのに使う)
const refs = { validateModelSchema: schema.$id };
for (const kind of schema.$defs.elementKind.enum) refs[`validate_${kind}`] = `${schema.$id}#/$defs/${kind}`;

// 設計データの部品ごとの検証 (同時編集で Y.Doc から読むとき、壊れた項目を読み飛ばすのに使う)
for (const def of ["designScreen", "transition", "layout", "navGroup", "database"]) refs[`validateDef_${def}`] = `${schema.$id}#/$defs/${def}`;

// ajv の補助関数は require で書き出されるので、ESM の import に置き換える
const imports = [];
const code = standaloneCode(ajv, refs).replace(
  /const (\w+) = require\("(ajv\/dist\/runtime\/\w+)"\)\.default;/g,
  (_, name, mod) => {
    imports.push(`import ${name}Module from "${mod}.js";\nconst ${name} = ${name}Module.default ?? ${name}Module;`);
    return "";
  },
).replace(/^"use strict";\n/, "");
writeFileSync(
  new URL("../src/model/schemaValidator.gen.js", import.meta.url),
  `// このファイルは packages/core/scripts/gen-validator.mjs が生成する。手で直さないこと。\n/* eslint-disable */\n${imports.join("\n")}\n${code}\n`,
);
console.log("generated packages/core/src/model/schemaValidator.gen.js");
