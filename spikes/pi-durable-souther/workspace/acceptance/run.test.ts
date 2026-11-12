// untie が設計から作った受け入れテストの本体 (自動生成。書き換えない)。
// 同じフォルダの *.cases.json のケースを、driver.ts を通して、アプリケーションに 1 件ずつ当てる。
// 動かし方: node --test acceptance/run.test.ts   (Node 22 以上。ビルドは要らない)
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import driver from "./driver.ts";

/** 操作を 1 回行う、という依頼。states は、操作の前の状態 (状態グループの名前 → 状態の名前)。conditions は、条件の名前 → 満たすか */
export interface AcceptanceInput {
  operation: string;
  states: Record<string, string>;
  conditions: Record<string, boolean>;
}

/**
 * 操作の結果。
 * outcome: done (ふだんの結果)・wrongState (前提の状態が違うので行えない)・alternate (条件のときの別の結果)・error (条件のときの結果がエラー)
 * condition: alternate・error のとき、どの条件の分岐か (条件の名前)
 * states: 操作のあとの状態 (状態グループの名前 → 状態の名前)。アプリケーションに保存されているものを読んで返す
 */
export interface AcceptanceResult {
  outcome: "done" | "wrongState" | "alternate" | "error";
  condition?: string;
  error?: { type: "input" | "server"; status?: number };
  states: Record<string, string>;
}

/** 実装する側が driver.ts に書くもの。states の状態のものを用意し、conditions を渡して操作を行い、結果を返す */
export interface AcceptanceDriver {
  run(input: AcceptanceInput): Promise<AcceptanceResult> | AcceptanceResult;
}

const here = new URL(".", import.meta.url);
const files = readdirSync(here)
  .filter((f) => f.endsWith(".cases.json"))
  .sort();
test("受け入れテストのケースがある", () => assert.ok(files.length > 0, "*.cases.json がありません"));

for (const file of files) {
  const suite = JSON.parse(readFileSync(new URL(file, here), "utf8"));
  for (const c of suite.cases) {
    test(`${suite.system} / ${c.operation} / ${c.title}`, async () => {
      const result = await (driver as AcceptanceDriver).run({ operation: c.operation, states: c.given.states, conditions: c.given.conditions });
      assert.equal(result.outcome, c.expect.outcome, "結果の種類");
      if (c.expect.condition !== undefined) assert.equal(result.condition, c.expect.condition, "どの条件の分岐か");
      if (c.expect.error !== undefined) {
        assert.equal(result.error?.type, c.expect.error.type, "エラーの種類");
        if (c.expect.error.status !== undefined) assert.equal(result.error?.status, c.expect.error.status, "HTTP ステータス");
      }
      for (const [group, state] of Object.entries(c.expect.states)) assert.equal(result.states[group], state, `操作のあとの「${group}」`);
    });
  }
  // 設計で決まっていないことが残っているあいだは、出来上がったとは言えない
  test(`${suite.system} / 設計で決まっていないことが無い`, () => assert.deepEqual(suite.pending.map((p: { operation: string; reason: string }) => `${p.operation}: ${p.reason}`), []));
}
