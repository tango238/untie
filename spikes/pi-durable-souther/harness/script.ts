// 台本: 「モデル」が出す応答 (どのツールを、どの引数で呼ぶか) を、あらかじめ決めておく。
// API キーが無くても Pi Durable の実行基盤 (ツールでファイルを書く・コマンドを実行する・記録して再開する) を確かめるためのもの。
// 書くアプリケーションは、宿泊管理システムの予約の操作 (確定・取消・チェックイン) の HTTP API。業務ルールは、Souther を WebAssembly にしたものを呼ぶ。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

const RULES_TS = `// 業務ルール: untie が書き出した Souther のモデルを WebAssembly にしたもの (model/pms.wasm) を呼ぶ。
// ここには判断を書かない。前提の状態・状態の移り変わり・条件のときの別の結果は、モデルが答える。
import { readFile } from "node:fs/promises";
import { load, type Bound } from "../../model/pms.ts";

let bound: Promise<Bound> | undefined;

export function rules(): Promise<Bound["modules"]["untie.sys_pms"]> {
  bound ??= readFile(new URL("../../model/pms.wasm", import.meta.url)).then((bytes) => load(bytes));
  return bound.then((b) => b.modules["untie.sys_pms"]);
}
`;

const APP_TS = `// 予約の操作の HTTP API。予約は、このプロセスのメモリに持つ (検証用)。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { rules } from "./rules.ts";

export interface Reservation {
  id: string;
  guest: string;
  /** 予約の状態。どの状態があり、どう移るかは、業務ルールのモデルが決める */
  state: string;
  /** 条件のときの別の結果になったときの、利用者への案内 */
  notice?: string;
}

/** 予約を登録したときの状態 (予約を登録する操作は、別のシステムのもので、このモデルに無い) */
const INITIAL_STATE = "仮予約";

/** 条件のときの別の結果 (Souther の出力のケース) になったときの、利用者への案内。そのあとの状態は、モデルが答える */
const NOTICES: Record<string, string> = {
  "予約を取り消す_取消料が発生する": "取消料を請求に加えてから、予約を取り消す。",
  "チェックインを記録する_早めのチェックインができる_でない": "部屋の準備が済むまで、ロビーで待ってもらう。",
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new SyntaxError("object expected");
  return parsed as Record<string, unknown>;
}

export function createApp(): Server {
  const reservations = new Map<string, Reservation>();
  let seq = 0;

  /** 業務ルールに、今の状態と条件を渡して結果を訊き、予約に反映する。前提の状態が違うかどうかも、モデルが答える */
  async function operate(res: ServerResponse, id: string, operation: string, ask: (m: any, state: string) => { value?: unknown; issues?: unknown }): Promise<void> {
    const reservation = reservations.get(id);
    if (!reservation) return send(res, 404, { error: "not_found", message: "予約が見つかりません" });
    const answer = ask(await rules(), reservation.state);
    if (answer.issues !== undefined) return send(res, 422, { error: "invalid", issues: answer.issues });
    const value = answer.value as string | { type: string; 予約の状態?: string };
    const outcome = typeof value === "string" ? value : value.type;
    if (outcome === \`\${operation}_状態が違う\`) return send(res, 409, { error: "state_conflict", message: \`この操作は、今の状態 (「\${reservation.state}」) では行えません\` });
    const notice = NOTICES[outcome];
    if (notice === undefined) {
      // ふだんの結果: 返ってきたものが、次の状態
      reservation.state = outcome;
      delete reservation.notice;
    } else {
      // 条件のときの別の結果: 状態を持っていれば、その状態になる。持っていなければ、状態は変えない
      if (typeof value !== "string" && value.予約の状態 !== undefined) reservation.state = value.予約の状態;
      reservation.notice = notice;
    }
    return send(res, 200, { reservation, outcome });
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "reservations") return send(res, 404, { error: "not_found", message: "見つかりません" });

      if (req.method === "POST" && parts.length === 1) {
        const body = await readJson(req);
        if (typeof body.guest !== "string" || body.guest.trim() === "") return send(res, 400, { error: "invalid_input", message: "宿泊客の名前を入れてください" });
        const reservation: Reservation = { id: \`r\${++seq}\`, guest: body.guest.trim(), state: INITIAL_STATE };
        reservations.set(reservation.id, reservation);
        return send(res, 201, { reservation });
      }
      const id = parts[1] ?? "";
      if (req.method === "GET" && parts.length === 2) {
        const reservation = reservations.get(id);
        return reservation ? send(res, 200, { reservation }) : send(res, 404, { error: "not_found", message: "予約が見つかりません" });
      }
      if (req.method === "POST" && parts.length === 3) {
        const body = await readJson(req);
        const flag = (key: string): boolean => body[key] === true;
        if (parts[2] === "confirm") return await operate(res, id, "予約を確定する", (m, state) => m["予約を確定する"](state));
        if (parts[2] === "cancel") return await operate(res, id, "予約を取り消す", (m, state) => m["予約を取り消す"](state, flag("cancellationFee")));
        if (parts[2] === "checkin") return await operate(res, id, "チェックインを記録する", (m, state) => m["チェックインを記録する"](state, flag("earlyCheckinAvailable")));
      }
      return send(res, 404, { error: "not_found", message: "見つかりません" });
    } catch (e) {
      if (e instanceof SyntaxError) return send(res, 400, { error: "invalid_input", message: "JSON として読めません" });
      return send(res, 500, { error: "server_error", message: "サーバーの中で失敗しました" });
    }
  });
}
`;

const SERVER_TS = `import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
createApp().listen(port, () => console.log(\`listening on http://localhost:\${port}\`));
`;

const TEST_TS = `// 設計のシーケンス図の、ふだんの流れと分岐 (代替パターン) を、HTTP の呼び出しで確かめる
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApp } from "../src/app.ts";

const server = createApp();
let base = "";
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = \`http://localhost:\${(server.address() as AddressInfo).port}\`;
});
after(() => server.close());

const post = async (path: string, body?: unknown) => {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
};
const reserve = async () => (await post("/reservations", { guest: "山田" })).body.reservation.id as string;

test("ふだんの流れ: 仮予約 → 確定 → チェックイン済", async () => {
  const id = await reserve();
  assert.equal((await post(\`/reservations/\${id}/confirm\`)).body.reservation.state, "確定");
  const checkin = await post(\`/reservations/\${id}/checkin\`, { earlyCheckinAvailable: true });
  assert.equal(checkin.status, 200);
  assert.equal(checkin.body.reservation.state, "チェックイン済");
});

test("分岐: 取消料が発生するとき、取消料を請求に加えてから取り消す", async () => {
  const id = await reserve();
  await post(\`/reservations/\${id}/confirm\`);
  const cancel = await post(\`/reservations/\${id}/cancel\`, { cancellationFee: true });
  assert.equal(cancel.body.outcome, "予約を取り消す_取消料が発生する");
  assert.equal(cancel.body.reservation.state, "取消");
  assert.match(cancel.body.reservation.notice, /取消料を請求に加えて/);
});

test("分岐: 取消料が発生しないとき、そのまま取り消す", async () => {
  const id = await reserve();
  await post(\`/reservations/\${id}/confirm\`);
  const cancel = await post(\`/reservations/\${id}/cancel\`, { cancellationFee: false });
  assert.equal(cancel.body.outcome, "取消");
  assert.equal(cancel.body.reservation.notice, undefined);
});

test("分岐: 早めのチェックインができないとき、状態は変えずに待ってもらう", async () => {
  const id = await reserve();
  await post(\`/reservations/\${id}/confirm\`);
  const checkin = await post(\`/reservations/\${id}/checkin\`, { earlyCheckinAvailable: false });
  assert.equal(checkin.body.reservation.state, "確定");
  assert.match(checkin.body.reservation.notice, /ロビーで待って/);
});

test("前提の状態が違う操作は 409、無い予約は 404、入力の誤りは 400", async () => {
  const id = await reserve();
  assert.equal((await post(\`/reservations/\${id}/cancel\`)).status, 409);
  assert.equal((await post("/reservations/none/confirm")).status, 404);
  assert.equal((await post("/reservations", { guest: "" })).status, 400);
});
`;

/** フォルダの下のファイルを、相対パスで並べる */
function filesUnder(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? filesUnder(path, base) : [relative(base, path)];
    });
}

/**
 * 再生の台本: 前に本物の LLM が書いたもの (from の app/ と acceptance/driver.ts) を、write のツールで 1 つずつ書かせて、「できた」と答える。
 * 書かれる中身は記録のままなので、確かめているのは、依頼 → 書く → 完了の検査 → 判定 の流れ
 */
export function replayScript(from: string) {
  const paths = [...filesUnder(join(from, "app")).map((p) => `app/${p}`), ...(existsSync(join(from, "acceptance/driver.ts")) ? ["acceptance/driver.ts"] : [])];
  if (paths.length === 0) throw new Error(`再生するものがありません (REPLAY_FROM に、app/ のあるフォルダを指してください): ${from}`);
  // 検査で差し戻されても、記録には続きが無いので、同じ答えを繰り返す (検査が上限まで落ちて、受け入れられないことを確かめられる)
  const done = () => fauxAssistantMessage([fauxText(`記録にあった ${paths.length} 個のファイルを書きました。できました。`)]);
  return [...paths.map((p) => write(p, readFileSync(join(from, p), "utf8"))), done(), done(), done(), done()];
}

const write = (path: string, content: string) => fauxAssistantMessage([fauxToolCall("write", { path, content })], { stopReason: "toolUse" });
const bash = (command: string) => fauxAssistantMessage([fauxToolCall("bash", { command, timeout: 240 })], { stopReason: "toolUse" });
const read = (path: string) => fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" });

/** テストを走らせるコマンド (途中で落とす検証の目印にもする) */
export const TEST_COMMAND = "npm test 2>&1 | tail -30";

const FINAL = fauxAssistantMessage([fauxText("app/ に、予約の操作の HTTP API を作りました。業務ルールは model/pms.wasm (Souther) を呼んでいます。npm test は通っています。")]);

/** はじめから終わりまで */
export const FULL_SCRIPT = [
  read("design/design.md"),
  read("design/sys_pms.sou"),
  // 土台 (作業フォルダの package.json) の依存を入れる。モデルの呼び出しコード (model/pms.ts) が使うパッケージも、ここから引ける
  bash("ls model && npm install 2>&1 | tail -5"),
  write("app/src/rules.ts", RULES_TS),
  write("app/src/app.ts", APP_TS),
  write("app/src/server.ts", SERVER_TS),
  write("app/test/app.test.ts", TEST_TS),
  bash(TEST_COMMAND),
  FINAL,
];

/** テストの実行中に落ちたあと、開き直して続けるときの残り */
export const RESUME_SCRIPT = [bash(TEST_COMMAND), FINAL];
