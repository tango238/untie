import type { ElementKind } from "./types";

export type IdKind =
  | ElementKind
  | "relation"
  | "board"
  | "designScreen"
  | "transition"
  | "database"
  | "navGroup"
  | "boundedContext"
  | "aggregate"
  | "invariant"
  | "domainCommand"
  | "domainEvent"
  | "domainPolicy"
  | "contextRelation"
  | "domainTerm";

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
  event: "ev",
  screen: "scr",
  nfr: "nfr",
  relation: "rel",
  board: "board",
  // 設計データ (0.5.0): サイトマップの画面と遷移
  designScreen: "ds",
  transition: "tr",
  database: "db",
  // ナビゲーションのグループ (レイアウト)
  navGroup: "nav",
  // ドメインモデル (0.6.0)
  boundedContext: "bc",
  aggregate: "ag",
  invariant: "inv",
  domainCommand: "cm",
  domainEvent: "de",
  domainPolicy: "po",
  contextRelation: "cr",
  domainTerm: "tm",
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
