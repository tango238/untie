import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { currentRoute, formatRoute, navigate, parseRoute, useRoute } from "../router";

beforeEach(() => {
  window.location.hash = "";
});

describe("parseRoute", () => {
  it("空や不明なハッシュはホーム", () => {
    for (const hash of ["", "#", "#/", "#/unknown", "#/f", "#/f/", "#/local/x", "#/f/a/b", "#/f/%E0%A4%A"]) {
      expect(parseRoute(hash)).toEqual({ name: "home" });
    }
  });

  it("各画面を読む", () => {
    expect(parseRoute("#/local")).toEqual({ name: "local" });
    expect(parseRoute("#/f/abc123")).toEqual({ name: "file", fileId: "abc123" });
    expect(parseRoute("#/invite/tok")).toEqual({ name: "invite", token: "tok" });
    expect(parseRoute("#/link/tok")).toEqual({ name: "link", token: "tok" });
  });

  it("id・トークンが英数字と _ - の 1〜64 文字でなければホーム", () => {
    const ok = "A".repeat(64);
    expect(parseRoute(`#/f/${ok}`)).toEqual({ name: "file", fileId: ok });
    expect(parseRoute("#/invite/a_b-C9")).toEqual({ name: "invite", token: "a_b-C9" });
    for (const bad of ["a%2Fb", "a.b", "a%20b", "%3Cscript%3E", "あ", "A".repeat(65), "a%00"]) {
      for (const head of ["f", "invite", "link"]) {
        expect(parseRoute(`#/${head}/${bad}`), `${head}/${bad}`).toEqual({ name: "home" });
      }
    }
  });

  it("末尾のスラッシュとクエリは無視する", () => {
    expect(parseRoute("#/f/abc/")).toEqual({ name: "file", fileId: "abc" });
    expect(parseRoute("#/f/abc?x=1")).toEqual({ name: "file", fileId: "abc" });
  });

  it("formatRoute と往復できる", () => {
    for (const route of [
      { name: "home" },
      { name: "local" },
      { name: "file", fileId: "a_b-c" },
      { name: "invite", token: "t-1" },
      { name: "link", token: "t_2" },
    ] as const) {
      expect(parseRoute(formatRoute(route))).toEqual(route);
    }
  });
});

describe("navigate / useRoute", () => {
  it("navigate はハッシュを書き換え、いまの画面になる", () => {
    navigate({ name: "local" });
    expect(window.location.hash).toBe("#/local");
    expect(currentRoute()).toEqual({ name: "local" });
    navigate({ name: "file", fileId: "x1" });
    expect(window.location.hash).toBe("#/f/x1");
  });

  it("useRoute は navigate とブラウザ側のハッシュ変更の両方に追従する", () => {
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ name: "home" });
    act(() => navigate({ name: "local" }));
    expect(result.current).toEqual({ name: "local" });
    act(() => {
      window.location.hash = "#/f/zzz";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(result.current).toEqual({ name: "file", fileId: "zzz" });
  });
});
