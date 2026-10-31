import type { ElementKind } from "./types";

export type IdKind = ElementKind | "relation" | "board";

export const ID_PREFIXES: Record<IdKind, string> = {
  actor: "actor",
  externalActor: "ext",
  system: "sys",
  ledger: "ldg",
  business: "biz",
  buc: "buc",
  activity: "act",
  usecase: "uc",
  context: "ctx",
  information: "info",
  state: "st",
  variation: "var",
  condition: "cond",
  issue: "issue",
  relation: "rel",
  board: "board",
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

// 同時編集では別々の端末で同じ id を引く恐れがあるので 8 文字 (36^8 ≈ 2.8 兆通り。設計書 6 章)
function randomSuffix(length = 8): string {
  let s = "";
  for (let i = 0; i < length; i++) {
    s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return s;
}

/** 種類の接頭辞 + ランダム文字列の id を作る (例: act_k3f9x2ab) */
export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${randomSuffix()}`;
}

/** used に含まれない id を作る */
export function newUniqueId(kind: IdKind, used: ReadonlySet<string>): string {
  for (;;) {
    const id = newId(kind);
    if (!used.has(id)) return id;
  }
}
