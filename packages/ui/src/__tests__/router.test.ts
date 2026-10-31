import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { currentRoute, formatRoute, navigate, parseRoute, replaceRoute, resumePendingRoute, toLoginReturn, useRoute } from "../router";

beforeEach(() => {
  window.location.hash = "";
  sessionStorage.clear();
});

describe("ログインの戻り先とトークンの預かり", () => {
  it("招待・リンクのハッシュはトークンを抜いて sessionStorage に預け、それ以外はそのまま返す", () => {
    expect(toLoginReturn("#/invite/abc_-1")).toBe("#/invite");
    expect(toLoginReturn("#/link/xyz")).toBe("#/link");
    expect(sessionStorage.getItem("untie.pendingInvite")).toBe("abc_-1");
    expect(sessionStorage.getItem("untie.pendingLink")).toBe("xyz");
    expect(toLoginReturn("#/f/f1")).toBe("#/f/f1");
    expect(toLoginReturn("#/")).toBe("#/");
  });

  it("戻ってきた #/invite・#/link は、預けたトークンで本来の画面に置き換え、預かりは消す", () => {
    window.location.hash = "#/invite";
    sessionStorage.setItem("untie.pendingInvite", "tok1");
    resumePendingRoute();
    expect(currentRoute()).toEqual({ name: "invite", token: "tok1" });
    expect(sessionStorage.getItem("untie.pendingInvite")).toBeNull();
    window.location.hash = "#/link";
    sessionStorage.setItem("untie.pendingLink", "tok2");
    resumePendingRoute();
    expect(currentRoute()).toEqual({ name: "link", token: "tok2" });
    expect(sessionStorage.getItem("untie.pendingLink")).toBeNull();
  });

  it("預かりが無い・形が違うトークン・他のハッシュなら、何も変えない", () => {
    window.location.hash = "#/invite";
    resumePendingRoute();
    expect(window.location.hash).toBe("#/invite");
    sessionStorage.setItem("untie.pendingLink", "bad token!");
    window.location.hash = "#/link";
    resumePendingRoute();
    expect(window.location.hash).toBe("#/link");
    window.location.hash = "#/f/f1";
    sessionStorage.setItem("untie.pendingInvite", "tok");
    resumePendingRoute();
    expect(window.location.hash).toBe("#/f/f1");
    expect(sessionStorage.getItem("untie.pendingInvite")).toBe("tok");
  });

  it("replaceRoute は履歴に積まずに画面を置き換える", () => {
    const before = window.history.length;
    replaceRoute({ name: "file", fileId: "f9" });
    expect(currentRoute()).toEqual({ name: "file", fileId: "f9" });
    expect(window.history.length).toBe(before);
  });
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
