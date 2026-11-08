import { describe, expect, it } from "vitest";
import { expectedLayers, lineage } from "../lineage";
import { addElement, setUsecaseTarget } from "../commands";
import { okModel, sample } from "./helpers";

const view = (rows: { layer: string; elements: { name: string }[] }[]) =>
  Object.fromEntries(rows.map((r) => [r.layer, r.elements.map((e) => e.name)]));

describe("lineage (トレース)", () => {
  it("作業から上へ、業務 (既定の活動は飛ばす)・担当・業務の主担当まで、下へ操作・情報・条件・状態・バリエーションまで辿る", () => {
    const t = lineage(sample(), "act_verify_identity");
    expect(view(t.up)).toEqual({ actor: ["フロント担当", "宿泊客"], business: ["チェックイン"] });
    const down = view(t.down);
    expect(down.usecase).toEqual(["チェックインを記録する", "宿泊者名簿に記入する"]);
    expect(down.information).toEqual(["予約", "宿泊客"]);
    expect(down.condition).toEqual(["早めのチェックインができる"]);
    expect(down.state).toEqual(expect.arrayContaining(["確定", "チェックイン済", "準備完了"]));
    // 自分と同じレイヤー (作業) は出さない
    expect(down.activity).toBeUndefined();
  });

  it("情報から上へ、操作・作業・活動・業務・登場人物 (担い手と置き場所)・コンテキストまで辿る", () => {
    const up = view(lineage(sample(), "info_cleaning_record").up);
    expect(up.usecase).toEqual(["清掃状況を更新する"]);
    expect(up.activity).toEqual(["清掃を指示する", "清掃する", "部屋を点検する"]);
    expect(up.business).toEqual(["清掃・準備"]);
    expect(up.context).toEqual(["客室"]);
    // 置き場所 (清掃チェック表) は、扱う操作の対象として上に来る
    expect(up.actor).toEqual(expect.arrayContaining(["清掃担当", "支配人", "清掃チェック表"]));
  });

  it("活動を通る作業は、活動を経て業務まで辿る", () => {
    const up = view(lineage(sample(), "act_room_service").up);
    expect(up.buc).toEqual(["飲食提供"]);
    expect(up.business).toEqual(["滞在中の対応"]);
  });

  it("課題・存在しない要素は空", () => {
    expect(lineage(sample(), "nope")).toEqual({ up: [], down: [] });
  });
});

describe("globalFilterScope (グローバルフィルター)", async () => {
  const { globalFilterScope, globalFilterCount } = await import("../lineage");
  const { fixedGroups, scopeGroups } = await import("../fixedBoards");

  it("空なら null (絞り込まない)。存在しない要素は無視する", () => {
    const m = sample();
    expect(globalFilterScope(m, undefined)).toBeNull();
    expect(globalFilterScope(m, { actor: [] })).toBeNull();
    expect(globalFilterScope(m, { actor: ["nope"] })).toBeNull();
    expect(globalFilterCount(m, { actor: ["actor_front", "nope"], business: ["biz_stay"] })).toBe(2);
  });

  it("選んだ要素につながる要素だけを残す。レイヤーの中は OR、レイヤーどうしは AND", () => {
    const m = sample();
    const housekeeping = globalFilterScope(m, { actor: ["actor_housekeeping"] })!;
    expect(housekeeping.has("act_clean")).toBe(true);
    // 主担当の業務 (清掃・準備) の作業も、トレースと同じく含む
    expect(housekeeping.has("act_instruct_cleaning")).toBe(true);
    expect(housekeeping.has("act_hand_key")).toBe(false);
    expect(housekeeping.has("actor_front")).toBe(false);
    const either = globalFilterScope(m, { actor: ["actor_housekeeping", "actor_reservation"] })!;
    expect(either.has("act_clean") && either.has("act_accept_reservation")).toBe(true);
    // フロント担当 かつ 業務「チェックアウト」
    const both = globalFilterScope(m, { actor: ["actor_front"], business: ["biz_checkout"] })!;
    expect(both.has("act_settle")).toBe(true);
    expect(both.has("act_hand_key")).toBe(false);
    // 作業に属さない自動の処理 (請求金額を計算する) は、フロント担当にも業務にもつながらないので含まない
    expect(both.has("uc_calc_charge")).toBe(false);
  });

  it("コンテキストを選ぶと、属する要素につながる操作・作業・担い手も残す", () => {
    const m = sample();
    const s = globalFilterScope(m, { actor: ["actor_reservation"], context: ["ctx_customer"] })!;
    // 予約担当 かつ 顧客 (宿泊客の情報) → 予約を受け付ける (予約を登録する が宿泊客を扱う)
    expect(s.has("act_accept_reservation")).toBe(true);
    expect(s.has("info_guest")).toBe(true);
    expect(s.has("act_confirm_reservation")).toBe(false);
    expect(view(lineage(m, "ctx_customer").up).usecase).toEqual(["予約を登録する", "チェックインを記録する", "宿泊者名簿に記入する"]);
  });

  it("合う要素のコンテキストと、合う操作の対象 (情報の置き場所) も含める", () => {
    const s = globalFilterScope(sample(), { actor: ["actor_housekeeping"] })!;
    expect(s.has("info_cleaning_record")).toBe(true);
    expect(s.has("ctx_room")).toBe(true);
    expect(s.has("ldg_cleaning_sheet")).toBe(true);
  });

  it("システムを選ぶと、そのシステムの画面を使う操作とその情報も残す (画面を使う操作は、画面のシステムを対象とみなす)", () => {
    const m = sample();
    let m2 = okModel(addElement(m, { kind: "screen", name: "清掃画面", id: "scr_clean", init: { systemId: "sys_pms" } }));
    m2 = okModel(setUsecaseTarget(m2, { usecaseId: "uc_update_cleaning", targetId: "scr_clean" }));
    const s = globalFilterScope(m2, { actor: ["sys_pms"] })!;
    expect(s.has("scr_clean")).toBe(true);
    expect(s.has("uc_update_cleaning")).toBe(true);
    expect(s.has("info_cleaning_record")).toBe(true);
    // 別のシステムの画面を使う操作は残らない
    expect(s.has("uc_record_payment")).toBe(false);
  });

  it("固定ボードの枠は、中身か見出しが合うものだけ残す", () => {
    const m = sample();
    const scope = globalFilterScope(m, { actor: ["actor_housekeeping"] });
    const gs = scopeGroups(fixedGroups(m, "activity"), scope);
    expect(gs.map((g) => g.title)).toEqual(["清掃・準備"]);
    expect(gs[0]!.items.map((e) => e.id)).toEqual(["act_instruct_cleaning", "act_clean", "act_inspect_room"]);
  });
});

describe("expectedLayers (トレースに出す上下のレイヤー)", () => {
  it("種類ごとに、上下に来うるレイヤーを FIXED_LAYERS の順で返す", () => {
    expect(expectedLayers("activity")).toEqual({
      up: ["actor", "business", "buc"],
      down: ["usecase", "screen", "information", "condition", "state", "variation"],
    });
    expect(expectedLayers("variation")).toEqual({
      up: ["actor", "business", "buc", "activity", "usecase", "context", "information", "condition"],
      down: [],
    });
    // コンテキストは属する要素の上を上、属する要素を下とする (イベントは操作のボードで扱うので、下のレイヤーには数えない)
    expect(expectedLayers("context")).toEqual({
      up: ["actor", "business", "buc", "activity", "usecase"],
      down: ["information", "condition", "state", "variation"],
    });
    // 画面は属するシステムと使う操作の下。扱う情報は操作から導くので、画面の下には何も来ない。非機能要件は属するシステムと求める人の下
    expect(expectedLayers("screen")).toEqual({
      up: ["actor", "business", "buc", "activity", "usecase"],
      down: [],
    });
    expect(expectedLayers("nfr")).toEqual({ up: ["actor"], down: [] });
  });

  it("登場人物は種類ごとに、なれる役割の先だけを下に出す", () => {
    expect(expectedLayers("actor").up).toEqual([]);
    // アクターは業務の主担当・作業の担当と、非機能要件を求める人
    expect(expectedLayers("actor").down).toEqual(["business", "buc", "activity", "usecase", "screen", "information", "condition", "state", "variation", "nfr"]);
    // 外部アクターは作業の担当と、非機能要件を求める人 (業務の主担当にはならない)
    expect(expectedLayers("externalActor").down).toEqual(["activity", "usecase", "screen", "information", "condition", "state", "variation", "nfr"]);
    // システムは操作の対象と、画面・非機能要件の持ち主 (作業の担当にはならない)。情報は操作を通って下に来る
    expect(expectedLayers("system").down).toEqual(["usecase", "screen", "information", "condition", "state", "variation", "nfr"]);
    // 帳票は操作の対象。情報は操作を通って下に来る
    expect(expectedLayers("ledger").down).toEqual(["usecase", "screen", "information", "condition", "state", "variation"]);
  });

  it("includeEmpty: つながる要素が無いレイヤーも空の行で出す。見つかった行はそのまま", () => {
    const m = sample();
    const t = lineage(m, "act_verify_identity", { includeEmpty: true });
    expect(t.up.map((r) => [r.layer, r.elements.length > 0])).toEqual([
      ["actor", true],
      ["business", true],
      ["buc", false],
    ]);
    expect(t.down.find((r) => r.layer === "usecase")!.elements.length).toBeGreaterThan(0);
  });
});

describe("lineage: 作業の起点 (0.4.1)", () => {
  it("起点の作業・イベントは、上にも下にも入らない", () => {
    const t = lineage(sample(), "act_clean");
    const names = [...t.up, ...t.down].flatMap((r) => r.elements.map((e) => e.name));
    expect(names).not.toContain("清掃を指示する");
    expect(names).not.toContain("部屋を点検する");
    const bill = lineage(sample(), "act_create_bill");
    expect([...bill.up, ...bill.down].flatMap((r) => r.elements.map((e) => e.name))).not.toContain("チェックアウトの日になった");
  });
});
