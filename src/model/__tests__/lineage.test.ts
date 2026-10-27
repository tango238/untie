import { describe, expect, it } from "vitest";
import { expectedLayers, lineage } from "../lineage";
import { sample } from "./helpers";

const view = (rows: { layer: string; elements: { name: string }[] }[]) =>
  Object.fromEntries(rows.map((r) => [r.layer, r.elements.map((e) => e.name)]));

describe("lineage (トレース)", () => {
  it("作業から上へ、業務 (既定の活動は飛ばす)・担当・業務の主担当まで、下へ操作・情報・条件・状態・バリエーションまで辿る", () => {
    const t = lineage(sample(), "act_verify_identity");
    expect(view(t.up)).toEqual({ actor: ["フロント担当", "宿泊客"], business: ["チェックイン"] });
    const down = view(t.down);
    expect(down.usecase).toEqual(["チェックインを記録する"]);
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
    // 担当は宿泊管理システムだが、フロント担当が主担当の業務「チェックアウト」の作業なので含む
    expect(both.has("act_calc_charge")).toBe(true);
  });

  it("コンテキストを選ぶと、属する要素につながる操作・作業・担い手も残す", () => {
    const m = sample();
    const s = globalFilterScope(m, { actor: ["actor_reservation"], context: ["ctx_customer"] })!;
    // 予約担当 かつ 顧客 (宿泊客の情報) → 予約を受け付ける (予約を登録する が宿泊客を扱う)
    expect(s.has("act_accept_reservation")).toBe(true);
    expect(s.has("info_guest")).toBe(true);
    expect(s.has("act_confirm_reservation")).toBe(false);
    expect(view(lineage(m, "ctx_customer").up).usecase).toEqual(["予約を登録する", "チェックインを記録する"]);
  });

  it("合う要素のコンテキストと、合う情報の置き場所も含める", () => {
    const s = globalFilterScope(sample(), { actor: ["actor_housekeeping"] })!;
    expect(s.has("info_cleaning_record")).toBe(true);
    expect(s.has("ctx_room")).toBe(true);
    expect(s.has("ldg_cleaning_sheet")).toBe(true);
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
      down: ["usecase", "information", "condition", "state", "variation"],
    });
    expect(expectedLayers("variation")).toEqual({
      up: ["actor", "business", "buc", "activity", "usecase", "context", "information", "condition"],
      down: [],
    });
    // コンテキストは属する要素の上を上、属する要素を下とする
    expect(expectedLayers("context")).toEqual({
      up: ["actor", "business", "buc", "activity", "usecase"],
      down: ["information", "condition", "state", "variation"],
    });
  });

  it("登場人物は種類ごとに、なれる役割の先だけを下に出す", () => {
    expect(expectedLayers("actor").up).toEqual([]);
    // アクターは業務の主担当と作業の担当
    expect(expectedLayers("actor").down).toEqual(["business", "buc", "activity", "usecase", "information", "condition", "state", "variation"]);
    // 外部アクターは作業の担当だけ (業務の主担当にはならない)
    expect(expectedLayers("externalActor").down).toEqual(["activity", "usecase", "information", "condition", "state", "variation"]);
    // 帳票は情報の置き場所だけ
    expect(expectedLayers("ledger").down).toEqual(["information", "variation"]);
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
