import { describe, expect, it } from "vitest";
import { lineage } from "../lineage";
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
