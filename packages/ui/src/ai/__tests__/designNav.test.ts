import { describe, expect, it } from "vitest";
import { NAME_MAX_LENGTH } from "@untie/core/model/limits";
import { emptyModel } from "@untie/core/model/types";
import type { SystemDesign } from "@untie/core/model/types";
import { navRequest, readNavigation, sanitizeNavigation } from "../designNav";

const design: SystemDesign = {
  systemId: "s",
  databaseIds: [],
  screens: [
    { id: "d_in", source: { kind: "builtin", builtin: "signIn" } },
    { id: "d_top", source: { kind: "builtin", builtin: "top" } },
    { id: "d1", source: { kind: "screen", screenId: "scr_1" } },
  ],
  transitions: [],
  layout: { shell: "shell", navigation: [] },
};

describe("sanitizeNavigation", () => {
  it("グループ名・表示名を上限で切り詰め、空のグループ名は「(名前なし)」にする", () => {
    const long = "あ".repeat(NAME_MAX_LENGTH + 50);
    const { groups } = sanitizeNavigation(design, [
      { group: long, items: [{ screenId: "d1", label: long }] },
      { group: "  ", items: [{ screenId: "d_top" }] },
    ]);
    expect(groups[0]!.group).toHaveLength(NAME_MAX_LENGTH);
    expect(groups[0]!.items[0]!.label).toHaveLength(NAME_MAX_LENGTH);
    expect(groups[1]!.group).toBe("(名前なし)");
  });

  it("存在しない画面・サインイン・重複は捨て、数を返す。項目の無いグループも捨てる", () => {
    const r = sanitizeNavigation(design, [
      { group: "a", items: [{ screenId: "d_in" }, { screenId: "nope" }, { screenId: "d1" }] },
      { group: "b", items: [{ screenId: "d1" }] },
    ]);
    expect(r.dropped).toBe(3);
    expect(r.groups).toEqual([{ group: "a", items: [{ screenId: "d1" }] }]);
  });

  it("ホームがあるときはトップページも捨てて数える。ホームが無ければトップページは残す", () => {
    const withHome: SystemDesign = { ...design, screens: [...design.screens, { id: "d_home", source: { kind: "builtin", builtin: "home" } }] };
    const r = sanitizeNavigation(withHome, [{ group: "a", items: [{ screenId: "d_home" }, { screenId: "d_top" }, { screenId: "d1" }] }]);
    expect(r.dropped).toBe(1);
    expect(r.groups).toEqual([{ group: "a", items: [{ screenId: "d_home" }, { screenId: "d1" }] }]);
    const noHome = sanitizeNavigation(design, [{ group: "a", items: [{ screenId: "d_top" }] }]);
    expect(noHome.dropped).toBe(0);
    expect(noHome.groups).toEqual([{ group: "a", items: [{ screenId: "d_top" }] }]);
  });

  it("navRequest: ホームがあるときトップページは依頼文に出ない。ホームが無ければ出る", () => {
    const model = emptyModel();
    const withHome: SystemDesign = { ...design, screens: [...design.screens, { id: "d_home", source: { kind: "builtin", builtin: "home" } }] };
    expect(navRequest(model, "s", withHome)).not.toContain("d_top");
    expect(navRequest(model, "s", withHome)).toContain("d_home");
    expect(navRequest(model, "s", design)).toContain("d_top");
  });

  it("readNavigation は形の違うものを null にする", () => {
    expect(readNavigation({})).toBeNull();
    expect(readNavigation({ groups: [{ group: "a", items: [{ screenId: "x", label: " 短 " }] }, 1] })).toEqual([{ group: "a", items: [{ screenId: "x", label: "短" }] }]);
  });
});
