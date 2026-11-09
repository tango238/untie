import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDatabase, setDatabaseDsl, setTableInformation } from "@untie/core/model/commands";
import { parsePrismaDsl } from "@untie/core/model/prisma";
import { emptyModel, type Element, type UntieModel } from "@untie/core/model/types";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { DataDiagram } from "../design/DataDiagram";
import { DslEditor } from "../design/DslEditor";
import { buildDataDiagram, diagramPositions, resetDiagramPositions, setDiagramPosition, tableNodeId } from "../design/dataDiagramFlow";

vi.mock("../../ai/keys", () => ({ getApiKey: async () => null, setApiKey: async () => {}, deleteApiKey: async () => {}, isApiKeyRemembered: () => false }));

const st = () => useUntieStore.getState();

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class DOMMatrixStub {
  m22 = 1;
  constructor(_init?: string) {}
}

const DSL = `model Reservation {
  id      String @id
  guestId String
  guest   Guest  @relation(fields: [guestId], references: [id])
  note    String?
}

model Guest {
  id           String        @id
  reservations Reservation[]
}

enum Status {
  OPEN
  CLOSED
}
`;

function ok(r: { ok: boolean; model?: UntieModel; reason?: string }): UntieModel {
  if (!r.ok) throw new Error(r.reason);
  return r.model!;
}

function prepare(dsl = DSL) {
  let m = emptyModel();
  m.elements = [
    { id: "sys_a", kind: "system", name: "予約システム" },
    { id: "info_a", kind: "information", name: "予約", contextId: null },
  ] as Element[];
  m.boards = [{ id: "board_1", name: "全体", nodes: [] }];
  m = ok(addDatabase(m, { id: "db_default", name: "既定のデータベース" }));
  m = ok(setDatabaseDsl(m, { id: "db_default", dsl }));
  m = ok(setTableInformation(m, { id: "db_default", table: "Reservation", informationIds: ["info_a"] }));
  resetStore(m);
  act(() => st().enterDesign("sys_a"));
  act(() => st().setCurrentBoard("design:data"));
}

const dsl = () => st().model.databases.find((d) => d.id === "db_default")!.dsl;
const table = (name: string) => document.querySelector(`[data-diagram-table="${name}"]`) as HTMLElement;
const row = (t: string, c: string) => table(t).querySelector(`[data-column="${c}"]`) as HTMLElement;
// React Flow は大きさを測るまでノードを隠し (jsdom では測れない)、隠れたボタンには役割の名前が付かないので、ノードの中のボタンは aria-label か文字で探す
function btn(name: string, root: ParentNode = document): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === name || b.textContent === name);
  if (!found) throw new Error(`ボタンがありません: ${name}`);
  return found;
}
const noBtn = (name: string) => [...document.querySelectorAll("button")].every((b) => b.getAttribute("aria-label") !== name && b.textContent !== name);
const lastToast = () => st().toasts[st().toasts.length - 1]?.message;

beforeEach(() => {
  cleanup();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  (globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = DOMMatrixStub;
  localStorage.clear();
  useUntieStore.setState({ cloud: null });
  resetDiagramPositions("db_default");
});

describe("図の計算 (buildDataDiagram)", () => {
  it("テーブルと enum をノードに、外部キーの列 → 参照先の列を線にする", () => {
    const { nodes, edges } = buildDataDiagram(parsePrismaDsl(DSL), "db_test");
    expect(nodes.map((n) => n.id)).toEqual(["table:Reservation", "table:Guest", "enum:Status"]);
    const res = nodes[0]!.data as { rows: { name: string; isId: boolean; isForeignKey: boolean; isRelation: boolean; type: string }[] };
    expect(res.rows.map((r) => [r.name, r.type, r.isId, r.isForeignKey, r.isRelation])).toEqual([
      ["id", "String", true, false, false],
      ["guestId", "String", false, true, false],
      ["guest", "Guest", false, false, true],
      ["note", "String?", false, false, false],
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "table:Reservation", sourceHandle: "s:guestId", target: "table:Guest", targetHandle: "t:id", data: { model: "Reservation", field: "guest" } });
    resetDiagramPositions("db_test");
  });

  it("動かした位置を使い、並べた位置も覚える。テーブルが増えても今あるノードは動かさない", () => {
    setDiagramPosition("db_test", tableNodeId("Guest"), { x: 900, y: 900 });
    const first = buildDataDiagram(parsePrismaDsl(DSL), "db_test").nodes;
    expect(first.find((n) => n.id === "table:Guest")!.position).toEqual({ x: 900, y: 900 });
    const before = first.find((n) => n.id === "table:Reservation")!.position;
    const more = buildDataDiagram(parsePrismaDsl(`${DSL}\nmodel A {\n  id String @id\n}\nmodel B {\n  id String @id\n}\n`), "db_test").nodes;
    expect(more.find((n) => n.id === "table:Reservation")!.position).toEqual(before);
    expect(diagramPositions("db_test").size).toBe(5);
    resetDiagramPositions("db_test");
  });
});

describe("データボードの図", () => {
  it("最初は図を出し、テキストと行き来できる。選んだ見せ方は覚える", () => {
    prepare();
    render(<DslEditor />);
    expect(screen.getByRole("button", { name: "図" }).getAttribute("aria-pressed")).toBe("true");
    expect(table("Reservation")).not.toBeNull();
    expect(document.querySelector('[data-diagram-enum="Status"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "テキスト" }));
    expect((screen.getByLabelText("DSL") as HTMLTextAreaElement).value).toBe(DSL);
    expect(localStorage.getItem("untie.design.dataView")).toBe("text");
    // テキストの書きかけは、図へ移るときに確定する
    fireEvent.change(screen.getByLabelText("DSL"), { target: { value: `${DSL}\nmodel Room {\n  id Int @id\n}\n` } });
    fireEvent.click(screen.getByRole("button", { name: "図" }));
    expect(dsl()).toContain("model Room");
    expect(table("Room")).not.toBeNull();
  });

  it("＋テーブルで足し、名前をその場で変える。名前の変更は情報の対応にも付いてくる", () => {
    prepare();
    render(<DslEditor />);
    fireEvent.click(screen.getByRole("button", { name: "＋テーブル" }));
    expect(dsl()).toContain("model Table1 {\n  id String @id\n}");
    const input = screen.getByLabelText("テーブルの名前") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Room" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(dsl()).toContain("model Room {");
    expect(dsl()).not.toContain("Table1");

    fireEvent.click(btn("Reservation の名前を変える"));
    const rename = screen.getByLabelText("テーブルの名前");
    fireEvent.change(rename, { target: { value: "Booking" } });
    fireEvent.blur(rename);
    expect(dsl()).toContain("model Booking {");
    expect(dsl()).toContain("reservations Booking[]");
    expect(st().model.databases[0]!.tables).toEqual([{ table: "Booking", informationIds: ["info_a"] }]);
  });

  it("使えない名前はトーストで断り、DSL は変えない", () => {
    prepare();
    render(<DslEditor />);
    fireEvent.click(btn("Reservation の名前を変える"));
    const rename = screen.getByLabelText("テーブルの名前");
    fireEvent.change(rename, { target: { value: "Guest" } });
    fireEvent.keyDown(rename, { key: "Enter" });
    expect(dsl()).toBe(DSL);
    expect(lastToast()).toContain("同じ名前");
  });

  it("列を押すと編集が開き、名前・型・NULL 可・一意を変えられ、消せる", () => {
    prepare();
    render(<DslEditor />);
    fireEvent.click(row("Reservation", "note"));
    const editor = table("Reservation").querySelector('[data-column-editor="note"]') as HTMLElement;
    fireEvent.change(within(editor).getByLabelText("列の型"), { target: { value: "Status" } });
    expect(dsl()).toContain("  note Status?\n");
    fireEvent.click(within(editor).getByLabelText(/NULL 可/));
    expect(dsl()).toContain("  note Status\n");
    fireEvent.click(within(editor).getByLabelText(/一意/));
    expect(dsl()).toContain("  note Status @unique\n");
    const name = within(editor).getByLabelText("列の名前");
    fireEvent.change(name, { target: { value: "status" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(dsl()).toContain("  status Status @unique\n");
    const editor2 = table("Reservation").querySelector('[data-column-editor="status"]') as HTMLElement;
    fireEvent.click(btn("列を消す", editor2));
    expect(dsl()).not.toContain("status");
  });

  it("＋列で String の列を足し、名前の入力が開く", () => {
    prepare();
    render(<DslEditor />);
    fireEvent.click(btn("＋列", table("Guest")));
    expect(dsl()).toContain("  reservations Reservation[]\n  column1 String\n}");
    expect(table("Guest").querySelector('[data-column-editor="column1"]')).not.toBeNull();
  });

  it("テーブルを消すときは確認し、ほかのテーブルからの関連も消す", () => {
    prepare();
    render(<DslEditor />);
    fireEvent.click(btn("Guest を消す"));
    const dialog = screen.getByRole("dialog", { name: "テーブルを消す" });
    fireEvent.click(within(dialog).getByRole("button", { name: "消す" }));
    expect(dsl()).not.toContain("Guest");
    expect(dsl()).not.toContain("guestId");
    expect(table("Guest")).toBeNull();
  });

  it("関連の列の編集からは、関連を消せる (外部キーの列は残る)", () => {
    prepare();
    render(<DslEditor />);
    fireEvent.click(row("Reservation", "guest"));
    fireEvent.click(btn("関連を消す"));
    expect(dsl()).not.toContain("@relation");
    expect(dsl()).not.toContain("reservations");
    expect(dsl()).toContain("guestId String");
  });

  it("DSL に解析エラーがあれば、図では直せない", () => {
    prepare("model A {\n  id Foo\n}\n");
    render(<DslEditor />);
    expect(screen.getByText(/図では直せません/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "＋テーブル" })).toBeNull();
    expect(noBtn("＋列")).toBe(true);
  });

  it("編集できなくなったら (AI の生成中など)、開いていた列の編集を閉じる", () => {
    prepare();
    const db = () => st().model.databases[0]!;
    const r = render(<DataDiagram database={db()} readOnly={false} />);
    fireEvent.click(row("Reservation", "note"));
    expect(table("Reservation").querySelector('[data-column-editor="note"]')).not.toBeNull();
    r.rerender(<DataDiagram database={db()} readOnly />);
    expect(table("Reservation").querySelector("[data-column-editor]")).toBeNull();
    // 編集できるように戻っても、閉じたまま
    r.rerender(<DataDiagram database={db()} readOnly={false} />);
    expect(table("Reservation").querySelector("[data-column-editor]")).toBeNull();
  });

  it("閲覧専用では、図は見るだけ", () => {
    prepare();
    act(() => {
      st().loadCloudDocument(st().model, { fileId: "f", role: "viewer", doc: new (class {})() as never });
    });
    render(<DslEditor />);
    expect(table("Reservation")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "＋テーブル" })).toBeNull();
    expect(noBtn("Reservation を消す")).toBe(true);
    fireEvent.click(row("Reservation", "note"));
    expect(table("Reservation").querySelector("[data-column-editor]")).toBeNull();
  });
});
