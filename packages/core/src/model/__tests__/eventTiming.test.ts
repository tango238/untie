import { describe, expect, it } from "vitest";
import { addElement, setEventTiming } from "../commands";
import { DESCRIPTION_MAX_LENGTH } from "../limits";
import { repairModel } from "../repair";
import { truncateModelStrings } from "../truncate";
import { describeEventTiming, emptyModel, normalizeEventTiming, type EventTiming, type UntieModel } from "../types";
import { validateModel } from "../validate";
import { okModel } from "./helpers";

const withEvent = (): UntieModel => okModel(addElement(emptyModel(), { kind: "event", name: "入金が確認された" }));
const eventId = (m: UntieModel) => m.elements.find((e) => e.kind === "event")!.id;
const timingOf = (m: UntieModel) => (m.elements.find((e) => e.kind === "event") as { timing?: EventTiming }).timing;
const long = (n: number) => "あ".repeat(n);

describe("normalizeEventTiming", () => {
  it("種類が分からなければ null", () => {
    expect(normalizeEventTiming(undefined)).toBeNull();
    expect(normalizeEventTiming({})).toBeNull();
    expect(normalizeEventTiming({ type: "bogus" })).toBeNull();
    expect(normalizeEventTiming([])).toBeNull();
  });

  it("定期は周期に合う項目だけ残す (日は毎月、時は毎月・毎日、分は定期)。周期が無ければ毎日", () => {
    expect(normalizeEventTiming({ type: "scheduled", every: "month", day: 25, hour: 9, minute: 0 })).toEqual({ type: "scheduled", every: "month", day: 25, hour: 9, minute: 0 });
    expect(normalizeEventTiming({ type: "scheduled", every: "day", day: 25, hour: 2, minute: 30 })).toEqual({ type: "scheduled", every: "day", hour: 2, minute: 30 });
    expect(normalizeEventTiming({ type: "scheduled", every: "hour", day: 1, hour: 2, minute: 15 })).toEqual({ type: "scheduled", every: "hour", minute: 15 });
    expect(normalizeEventTiming({ type: "scheduled" })).toEqual({ type: "scheduled", every: "day" });
    // 範囲外・整数でない数は外す
    expect(normalizeEventTiming({ type: "scheduled", every: "month", day: 32, hour: 1.5, minute: -1 })).toEqual({ type: "scheduled", every: "month" });
  });

  it("不定期は周期と時刻を持たない。補足は前後の空白を除き、空なら持たない", () => {
    expect(normalizeEventTiming({ type: "adhoc", every: "day", hour: 3, note: "  Webhook を受けたとき " })).toEqual({ type: "adhoc", note: "Webhook を受けたとき" });
    expect(normalizeEventTiming({ type: "adhoc", note: "  " })).toEqual({ type: "adhoc" });
  });
});

describe("describeEventTiming", () => {
  it("定期は周期と時刻、不定期は補足を短く書く", () => {
    expect(describeEventTiming({ type: "scheduled", every: "month", day: 25, hour: 9, minute: 0 })).toBe("定期: 毎月 25日 9:00");
    expect(describeEventTiming({ type: "scheduled", every: "day", hour: 2, minute: 30, note: "営業日だけ" })).toBe("定期: 毎日 2:30 (営業日だけ)");
    expect(describeEventTiming({ type: "scheduled", every: "hour", minute: 15 })).toBe("定期: 毎時 15分");
    expect(describeEventTiming({ type: "scheduled", every: "day" })).toBe("定期: 毎日 --:--");
    expect(describeEventTiming({ type: "adhoc", note: "入金の Webhook を受けたとき" })).toBe("不定期: 入金の Webhook を受けたとき");
    expect(describeEventTiming({ type: "adhoc" })).toBe("不定期");
  });
});

describe("setEventTiming", () => {
  it("イベントに発生タイミングを置き、正規化して持つ。null で消す", () => {
    const m = withEvent();
    const id = eventId(m);
    const a = okModel(setEventTiming(m, { id, timing: { type: "scheduled", every: "day", day: 3, hour: 2, minute: 0 } }));
    expect(timingOf(a)).toEqual({ type: "scheduled", every: "day", hour: 2, minute: 0 });
    expect(validateModel(JSON.parse(JSON.stringify(a))).ok).toBe(true);
    const b = okModel(setEventTiming(a, { id, timing: { type: "adhoc", note: "Webhook を受けたとき" } }));
    expect(timingOf(b)).toEqual({ type: "adhoc", note: "Webhook を受けたとき" });
    const c = okModel(setEventTiming(b, { id, timing: null }));
    expect(c.elements.find((e) => e.id === id)).not.toHaveProperty("timing");
  });

  it("同じなら model をそのまま返す", () => {
    const base = withEvent();
    const m = okModel(setEventTiming(base, { id: eventId(base), timing: { type: "adhoc" } }));
    const r = setEventTiming(m, { id: eventId(m), timing: { type: "adhoc" } });
    expect(r.ok && r.model).toBe(m);
  });

  it("イベント以外・不正な種類・周期・範囲外の数・長すぎる補足は失敗", () => {
    const m = withEvent();
    const id = eventId(m);
    const actor = okModel(addElement(m, { kind: "actor", name: "A" }));
    const actorId = actor.elements.find((e) => e.kind === "actor")!.id;
    expect(setEventTiming(actor, { id: actorId, timing: { type: "adhoc" } }).ok).toBe(false);
    expect(setEventTiming(m, { id: "nope", timing: { type: "adhoc" } }).ok).toBe(false);
    expect(setEventTiming(m, { id, timing: { type: "bogus" } as never }).ok).toBe(false);
    expect(setEventTiming(m, { id, timing: { type: "scheduled", every: "week" } as never }).ok).toBe(false);
    expect(setEventTiming(m, { id, timing: { type: "scheduled", every: "day", hour: 24 } }).ok).toBe(false);
    expect(setEventTiming(m, { id, timing: { type: "scheduled", every: "month", day: 0 } }).ok).toBe(false);
    expect(setEventTiming(m, { id, timing: { type: "adhoc", note: long(DESCRIPTION_MAX_LENGTH + 1) } }).ok).toBe(false);
  });
});

describe("発生タイミングの切り詰めと修復", () => {
  const withTiming = (timing: unknown): UntieModel => {
    const m = withEvent();
    return { ...m, elements: m.elements.map((e) => (e.kind === "event" ? { ...e, timing } : e)) as UntieModel["elements"] };
  };

  it("長すぎる補足は切り詰める", () => {
    const r = truncateModelStrings(withTiming({ type: "adhoc", note: long(DESCRIPTION_MAX_LENGTH + 1) }));
    expect(timingOf(r.model)!.note).toBe(long(DESCRIPTION_MAX_LENGTH));
    expect(r.changes).toHaveLength(1);
  });

  it("種類が分からなければ repair が外し、周期に合わない項目は外して知らせる。正しければ何も変えない", () => {
    const bad = repairModel(withTiming({ type: "bogus" }));
    expect(bad.model.elements.find((e) => e.kind === "event")).not.toHaveProperty("timing");
    expect(bad.changes).toHaveLength(1);
    const extra = repairModel(withTiming({ type: "adhoc", every: "day", hour: 3 }));
    expect(timingOf(extra.model)).toEqual({ type: "adhoc" });
    expect(extra.changes).toHaveLength(1);
    expect(validateModel(JSON.parse(JSON.stringify(extra.model))).ok).toBe(true);
    const ok = withTiming({ type: "scheduled", every: "month", day: 25, hour: 9, minute: 0 });
    expect(repairModel(ok).model).toBe(ok);
  });
});
