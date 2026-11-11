// 実装を始める (6.1)。対象のシステムについて、準備がそろっているかを確かめ、実装する側 (AI のエージェント) に渡すものを、その時点の設計から 1 つにまとめる。
// まとめるのは: 設計書・業務ルール (Souther のソース)・受け入れテスト・作業フォルダの土台・依頼文。どれも同じモデルから、同じときに作る
// (別々に書き出すと、設計を直したあとの古いテストで判定してしまう)。ここは組み立てるだけの純粋関数で、ファイルに書く・エージェントを動かすのは、呼び出す側。
import { ACCEPTANCE_DIR, ACCEPTANCE_README_FILE, ACCEPTANCE_RUNNER_FILE, acceptanceCasesFileName, deriveAcceptanceCases, exportAcceptanceTests } from "./acceptance";
import { exportDesignBrief } from "./designBrief";
import { usecasePlaces } from "./placement";
import { checkReadiness, readinessRemaining, type Readiness } from "./readiness";
import { exportSouther } from "./southerExport";
import type { UntieModel } from "./types";

/** 作業フォルダに置くファイル (path は、作業フォルダからの相対。区切りは /) */
export interface BuildFile {
  path: string;
  text: string;
}

/** 業務ルールのモデル (Souther)。source を WebAssembly にして wasm に、TypeScript の呼び出しコードを bindings に置くのは、呼び出す側 (JDK が要る) */
export interface BuildModel {
  /** Souther のソース (files に入っている) */
  source: string;
  wasm: string;
  bindings: string;
  /** Souther のモジュールの名前 (呼び出しコードで、操作を引くキー) */
  moduleName: string;
}

export interface BuildPlan {
  systemId: string;
  /** システムの名前 */
  system: string;
  /** 準備がすべてそろっている。false のときは、始めない */
  ready: boolean;
  readiness: Readiness;
  /** まだ決まっていないことの数 */
  remaining: number;
  /** このシステムで作る操作の名前 */
  operations: string[];
  /** 作業フォルダに置くファイル */
  files: BuildFile[];
  /** 実装する側が書き換えてはいけないファイル (files のうち、設計から作ったもの)。完了の検査の前に、元に戻す */
  protectedPaths: string[];
  /** 業務ルールのモデル。前提の状態も条件も無いシステムでは null */
  model: BuildModel | null;
  /** 受け入れテストのケースの数 (0 なら、受け入れテストは無い) */
  acceptanceCases: number;
  /** 完了の検査で流すコマンド (どれも、終了コードが 0 で、通ったテストが 1 件以上あること) */
  checks: { name: string; command: string }[];
  /** 実装する側への依頼文 */
  task: string;
}

export const BUILD_DESIGN_DIR = "design";
export const BUILD_MODEL_DIR = "model";
export const BUILD_DESIGN_FILE = `${BUILD_DESIGN_DIR}/design.md`;
/** 作業フォルダの土台が使うパッケージ (業務ルールのモデルを呼ぶためのもの。版は、Souther の版に合わせて固定する) */
export const BUILD_MODEL_DEPENDENCIES: Record<string, string> = { "@raoh/core": "0.9.0", "@souther-lang/wasm": "0.4.1" };
export const BUILD_APP_TEST_COMMAND = "npm test";
export const BUILD_ACCEPTANCE_COMMAND = `node --test ${ACCEPTANCE_DIR}/${ACCEPTANCE_RUNNER_FILE}`;

/** モデルのファイルの名前 (システムの id から。sys_pms → pms) */
function modelBaseName(systemId: string): string {
  return systemId.replace(/^sys_/, "").replace(/[^A-Za-z0-9_-]/g, "_") || "rules";
}

/** 作業フォルダの土台: 依存と、動かし方・テストの仕方の決まり */
function scaffoldPackageJson(systemId: string, withModel: boolean): string {
  const pkg = {
    name: modelBaseName(systemId).toLowerCase().replace(/_/g, "-"),
    private: true,
    type: "module",
    scripts: { start: "node app/src/server.ts", test: 'node --test "app/test/**/*.test.ts"' },
    dependencies: withModel ? BUILD_MODEL_DEPENDENCIES : {},
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** 実装する側への依頼文 */
function taskText(plan: Pick<BuildPlan, "system" | "operations" | "ready" | "model" | "checks">, hasAcceptance: boolean): string {
  const lines: string[] = [];
  const push = (...xs: string[]) => lines.push(...xs);
  push(`${BUILD_DESIGN_FILE} は、「${plan.system}」の設計です (業務分析ツール Untie から書き出したもの)。この設計の操作を、HTTP の API として app/ に作ってください。`, "");
  push("## 作るもの", "", "設計書の「操作」の節にある、次の操作を HTTP で行える API:", "", ...plan.operations.map((o) => `- ${o}`), "");
  push("設計書で「ほかのシステム」「帳票」と書いてある操作は、作りません。確かめるのに要る最小限の操作 (ものを用意する・今の状態を見る) は、足してかまいません。", "");
  if (!plan.ready) {
    push(
      "設計書の終わりの「まだ決まっていないこと」に挙がっているものは、今回作る範囲の外です。それに当たるところは、勝手に決めて作らずに、app/README.md の「決まっていないこと」に書いてください。",
      "",
    );
  }
  push("## 決まり", "");
  push("- TypeScript。Node 22 で、ビルドせずにそのまま動かす (`npm start` = `node app/src/server.ts`)。");
  push("- **ネットワークは使えません。** パッケージは、作業フォルダの node_modules に入れてあるもの (package.json のもの) と、Node の標準のものだけを使う。`npm install` はできない。");
  if (plan.model) {
    push(
      `- **業務ルールを、アプリケーションのコードに書き直さない。** 操作の前提の状態・状態の移り変わり・条件のときの別の結果は、${plan.model.wasm} (${plan.model.source} を Souther でコンパイルしたもの) が答える。TypeScript から呼ぶコードは ${plan.model.bindings} にある (そのまま import できる。写さなくてよい)。使い方は、まずこの 2 つと node_modules の @souther-lang/wasm を読んで確かめること。`,
    );
  }
  push("- データは、プロセスのメモリに持てばよい (データベースは要らない)。画面も作らない (HTTP の API だけ)。");
  push("- アプリのテストは app/test/ に `*.test.ts` で書き、作業フォルダで `npm test` で動くようにする。設計書の「業務の流れ」の、ふだんの流れと、すべての分岐 (条件のときにどうなるか) を、HTTP を通して確かめる。前提の状態が違う操作・無いもの・入力の誤りも確かめる。");
  push("- 設計書で決まっていないこと (条件を判断する式、など) は、勝手に決めずに、呼び出す側が渡す値にするか、app/README.md の「決まっていないこと」に書く。");
  push(`- ${BUILD_DESIGN_DIR}/${plan.model ? `・${BUILD_MODEL_DIR}/` : ""}${hasAcceptance ? `と、${ACCEPTANCE_DIR}/ の \`*.cases.json\`・\`${ACCEPTANCE_RUNNER_FILE}\`・\`${ACCEPTANCE_README_FILE}\`` : ""} は、書き換えない (書き換えても、検査の前に元に戻されます)。`, "");
  if (hasAcceptance) {
    push("## 受け入れテスト", "");
    push(`${ACCEPTANCE_DIR}/ に、Untie が設計から作った受け入れテストがあります (${ACCEPTANCE_DIR}/${ACCEPTANCE_README_FILE} を読むこと)。あなたが書くのは **${ACCEPTANCE_DIR}/driver.ts** だけです。`, "");
    push("- driver.ts は、**アプリケーションの HTTP API を通して** 操作を行う (アプリを起こして、HTTP で呼ぶ)。業務ルールのモデルを driver.ts から直に呼んで答えを作らない。");
    push("- 操作のあとの状態は、アプリケーションに保存されているものを、HTTP で読み直して返す。");
    push("- ケースは、操作の前の状態 (states) を指定してきます。その状態のものは、できるだけ、ふだんの操作を順に行って用意する。それができないもの (その状態にする操作が、このシステムに無い) だけ、用意する手段を API に足す (確かめるための操作だと分かるようにする)。", "");
  }
  push("## 完了の検査", "");
  push("あなたが「できた」と答えると、実行基盤が、あなたの外で次を実行します。どれかが落ちると、結果と一緒に戻ってきます。", "", "```sh", ...plan.checks.map((c) => c.command), "```", "");
  push("先に自分で実行して、すべて通ることを確かめてから答えてください。通っていないのに「できた」と言わない。", "");
  push("## 終わりに", "");
  push("app/README.md に、動かし方・テストの仕方・API の一覧・決まっていないことを書いてください。最後の答えには、作ったもの・テストの結果 (件数)・気づいた設計の抜けを、短くまとめてください。");
  return `${lines.join("\n")}\n`;
}

/** そのシステムの実装を始めるときに渡すものを、まとめて組み立てる。準備がそろっているかも、あわせて返す (そろっていなければ、呼び出す側は始めない) */
export function planBuild(model: UntieModel, systemId: string): BuildPlan {
  const system = model.elements.find((e) => e.id === systemId && e.kind === "system");
  const systemName = system?.name?.trim() || "(名前なし)";
  const readiness = checkReadiness(model, systemId);
  const places = usecasePlaces(model);
  const operations = model.elements.filter((e) => e.kind === "usecase" && places.get(e.id) === systemId).map((u) => u.name.trim() || "(名前なし)");

  const files: BuildFile[] = [];
  const protectedPaths: string[] = [];
  const protect = (file: BuildFile) => {
    files.push(file);
    protectedPaths.push(file.path);
  };
  protect({ path: BUILD_DESIGN_FILE, text: exportDesignBrief(model, systemId).text });

  // 業務ルール: 前提の状態か条件のある操作が 1 つでもあれば、Souther のソースを付ける
  const souther = exportSouther(model, systemId);
  let buildModel: BuildModel | null = null;
  if (souther.behaviors > 0) {
    const source = `${BUILD_DESIGN_DIR}/${souther.fileName}`;
    protect({ path: source, text: souther.text });
    const base = modelBaseName(systemId);
    buildModel = { source, wasm: `${BUILD_MODEL_DIR}/${base}.wasm`, bindings: `${BUILD_MODEL_DIR}/${base}.ts`, moduleName: souther.moduleName };
    protectedPaths.push(buildModel.wasm, buildModel.bindings);
  }

  // 受け入れテスト: このシステムのケースと、テストの本体と、説明 (ケースも保留も無ければ、付けない)
  const suite = deriveAcceptanceCases(model, systemId);
  const hasAcceptance = suite.cases.length + suite.pending.length > 0;
  if (hasAcceptance) {
    const wanted = new Set([acceptanceCasesFileName(systemId), ACCEPTANCE_RUNNER_FILE, ACCEPTANCE_README_FILE]);
    for (const f of exportAcceptanceTests(model).files) if (wanted.has(f.name)) protect({ path: `${ACCEPTANCE_DIR}/${f.name}`, text: f.text });
  }

  files.push({ path: "package.json", text: scaffoldPackageJson(systemId, buildModel !== null) });

  const checks = [...(hasAcceptance ? [{ name: "受け入れテスト", command: BUILD_ACCEPTANCE_COMMAND }] : []), { name: "アプリのテスト", command: BUILD_APP_TEST_COMMAND }];
  const base = { system: systemName, operations, ready: readiness.ready, model: buildModel, acceptanceCases: suite.cases.length, checks };
  return { systemId, ...base, readiness, remaining: readinessRemaining(readiness), files, protectedPaths, task: taskText(base, hasAcceptance) };
}
