import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { editDatabaseDsl } from "@untie/core/model/commands";
import { PRISMA_SCALAR_TYPES } from "@untie/core/model/prisma";
import { parsePrismaDslCached } from "@untie/core/model/prismaCache";
import { freePrismaFieldName, freePrismaModelName, oppositeRelationField, type PrismaEdit } from "@untie/core/model/prismaEdit";
import type { Database } from "@untie/core/model/types";
import { useUntieStore } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import {
  buildDataDiagram,
  columnOfHandle,
  DIAGRAM_NODE_WIDTH,
  renameDiagramPosition,
  resetDiagramPositions,
  setDiagramPosition,
  sourceHandleId,
  tableNodeId,
  targetHandleId,
  type DiagramEdge,
  type DiagramNode,
  type DiagramRow,
  type EnumNodeData,
  type TableNodeData,
} from "./dataDiagramFlow";

interface DiagramActions {
  editable: boolean;
  enumNames: string[];
  selectedTable?: string;
  editing?: { table: string; field: string; focus?: boolean };
  renaming?: string;
  /** 図の操作を DSL に当てる。失敗はトーストで知らせ、false を返す */
  edit: (e: PrismaEdit) => boolean;
  openColumn: (table: string, field: string | undefined, focus?: boolean) => void;
  setRenaming: (table: string | undefined) => void;
  addColumn: (table: string) => void;
  requestRemoveTable: (table: string) => void;
  renameTable: (from: string, to: string) => void;
}

const ActionsContext = createContext<DiagramActions | null>(null);
const useActions = () => useContext(ActionsContext)!;

/** 名前の入力。Enter か blur で確定、Esc で取り消す */
function NameInput({ value, label, autoFocus, onCommit, onCancel }: { value: string; label: string; autoFocus?: boolean; onCommit: (v: string) => void; onCancel?: () => void }) {
  const [text, setText] = useState(value);
  const done = useRef(false);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (done.current) return;
    const v = text.trim();
    if (v !== value && v !== "") onCommit(v);
    else onCancel?.();
  };
  return (
    <input
      className="nodrag nokey diagram-name-input"
      aria-label={label}
      value={text}
      autoFocus={autoFocus}
      spellCheck={false}
      onFocus={(e) => {
        done.current = false;
        if (autoFocus) e.currentTarget.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          done.current = true;
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          done.current = true;
          setText(value);
          onCancel?.();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** 選んだ列の編集: 名前・型・NULL 可・リスト・主キー・一意・削除。関連の列は関連を消すだけ */
function ColumnEditor({ table, row }: { table: string; row: DiagramRow }) {
  const a = useActions();
  const update = (patch: Parameters<typeof updatePatch>[0]) => a.edit(updatePatch(patch, table, row.name));
  const types = [...PRISMA_SCALAR_TYPES, ...a.enumNames];
  if (!types.includes(row.baseType as never)) types.push(row.baseType as never);
  if (row.isRelation) {
    return (
      <div className="diagram-column-editor nodrag nokey" data-column-editor={row.name}>
        <p className="hint">{table}.{row.name} は {row.baseType} への関連です。外部キーの列は残ります。</p>
        <button type="button" className="danger" onClick={() => a.edit({ type: "removeRelation", model: table, field: row.name }) && a.openColumn(table, undefined)}>
          関連を消す
        </button>
      </div>
    );
  }
  return (
    <div className="diagram-column-editor nodrag nokey" data-column-editor={row.name}>
      <label className="diagram-editor-line">
        <span>名前</span>
        <NameInput
          value={row.name}
          label="列の名前"
          autoFocus={a.editing?.focus}
          onCommit={(v) => {
            if (a.edit(updatePatch({ name: v }, table, row.name))) a.openColumn(table, v);
          }}
        />
      </label>
      <label className="diagram-editor-line">
        <span>型</span>
        <select aria-label="列の型" value={row.baseType} onChange={(e) => update({ type: e.target.value })}>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <div className="diagram-editor-flags">
        <label>
          <input type="checkbox" checked={row.isId} onChange={(e) => update({ isId: e.target.checked })} /> 主キー
        </label>
        <label>
          <input type="checkbox" checked={row.isUnique} onChange={(e) => update({ isUnique: e.target.checked })} /> 一意
        </label>
        <label>
          <input type="checkbox" checked={row.isOptional} onChange={(e) => update({ isOptional: e.target.checked })} /> NULL 可
        </label>
        <label>
          <input type="checkbox" checked={row.isList} onChange={(e) => update({ isList: e.target.checked })} /> リスト
        </label>
      </div>
      <div className="diagram-editor-actions">
        <button type="button" className="danger" onClick={() => a.edit({ type: "removeField", model: table, field: row.name }) && a.openColumn(table, undefined)}>
          列を消す
        </button>
        <button type="button" onClick={() => a.openColumn(table, undefined)}>
          閉じる
        </button>
      </div>
    </div>
  );
}

const updatePatch = (patch: Extract<PrismaEdit, { type: "updateField" }>["patch"], model: string, field: string): PrismaEdit => ({ type: "updateField", model, field, patch });

function TableNode({ data }: NodeProps<Extract<DiagramNode, { type: "table" }>>) {
  const a = useActions();
  const { table, rows } = data as TableNodeData;
  const selected = a.selectedTable === table;
  const renaming = a.renaming === table;
  return (
    <div className={`diagram-table${selected ? " is-selected" : ""}`} data-diagram-table={table} style={{ width: DIAGRAM_NODE_WIDTH }}>
      <div className="diagram-table-head">
        {renaming ? (
          <NameInput value={table} label="テーブルの名前" autoFocus onCommit={(v) => a.renameTable(table, v)} onCancel={() => a.setRenaming(undefined)} />
        ) : (
          <span
            className="diagram-table-name"
            title={a.editable ? `${table} (ダブルクリックで名前を変える)` : table}
            onDoubleClick={() => a.editable && a.setRenaming(table)}
          >
            {table}
          </span>
        )}
        {data.mapName && !renaming && <small className="diagram-map-name" title={`@@map("${data.mapName}")`}>{data.mapName}</small>}
        {a.editable && !renaming && (
          <>
            <button type="button" className="icon-button nodrag" aria-label={`${table} の名前を変える`} title="名前を変える" onClick={() => a.setRenaming(table)}>
              ✎
            </button>
            <button type="button" className="icon-button nodrag" aria-label={`${table} を消す`} title="テーブルを消す" onClick={() => a.requestRemoveTable(table)}>
              ×
            </button>
          </>
        )}
      </div>
      {rows.map((r) => {
        const open = a.editing?.table === table && a.editing.field === r.name;
        return (
          <div key={r.name}>
            <div
              className={`diagram-row${r.isRelation ? " is-relation" : ""}${open ? " is-open" : ""}`}
              data-column={r.name}
              role={a.editable ? "button" : undefined}
              tabIndex={a.editable ? 0 : undefined}
              aria-label={a.editable ? `列 ${table}.${r.name} を編集` : undefined}
              aria-expanded={a.editable ? open : undefined}
              onClick={() => a.editable && a.openColumn(table, open ? undefined : r.name)}
              onKeyDown={(e) => {
                if (a.editable && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                  e.preventDefault();
                  a.openColumn(table, open ? undefined : r.name);
                }
              }}
            >
              <Handle id={targetHandleId(r.name)} type="target" position={Position.Left} isConnectable={a.editable && !r.isRelation} />
              <span className="diagram-key">{r.isId ? "PK" : r.isForeignKey ? "FK" : r.isUnique ? "UQ" : ""}</span>
              <span className="diagram-row-name">{r.name}</span>
              <code className="diagram-row-type">{r.type}</code>
              <Handle id={sourceHandleId(r.name)} type="source" position={Position.Right} isConnectable={a.editable && !r.isRelation} />
            </div>
            {open && <ColumnEditor table={table} row={r} />}
          </div>
        );
      })}
      {a.editable && (
        <button type="button" className="diagram-add-column nodrag" onClick={() => a.addColumn(table)}>
          ＋列
        </button>
      )}
    </div>
  );
}

function EnumNode({ data }: NodeProps<Extract<DiagramNode, { type: "enum" }>>) {
  const { name, values } = data as EnumNodeData;
  return (
    <div className="diagram-table diagram-enum" data-diagram-enum={name} style={{ width: 180 }}>
      <div className="diagram-table-head">
        <span className="diagram-table-name">{name}</span>
        <small className="diagram-map-name">enum</small>
      </div>
      {values.map((v) => (
        <div key={v} className="diagram-enum-value">
          {v}
        </div>
      ))}
    </div>
  );
}

const nodeTypes = { table: TableNode, enum: EnumNode };

function DataDiagramInner({ database, editable }: { database: Database; editable: boolean }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const selectDesignTable = useUntieStore((s) => s.selectDesignTable);
  const selectedTable = useUntieStore((s) => (s.ui.designDatabaseId === database.id ? s.ui.designTableName : undefined));
  const schema = parsePrismaDslCached(database.dsl);
  const [editing, setEditing] = useState<DiagramActions["editing"]>();
  const [renaming, setRenaming] = useState<string>();
  const [removing, setRemoving] = useState<string>();
  const [selectedEdge, setSelectedEdge] = useState<{ model: string; field: string }>();
  const [layoutSeq, setLayoutSeq] = useState(0);
  const rf = useReactFlow();

  const flow = useMemo(() => buildDataDiagram(schema, database.id), [schema, database.id, layoutSeq]);
  const [nodes, setNodes] = useState<DiagramNode[]>(flow.nodes);
  // DSL が変わったら作り直す。React Flow が測った大きさは引き継ぐ
  useEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return flow.nodes.map((n) => {
        const p = byId.get(n.id);
        return p?.measured ? ({ ...n, measured: p.measured } as DiagramNode) : n;
      });
    });
  }, [flow.nodes]);

  const edges: DiagramEdge[] = useMemo(
    () => flow.edges.map((e) => (selectedEdge && e.data?.model === selectedEdge.model && e.data.field === selectedEdge.field ? { ...e, selected: true, className: "is-selected" } : e)),
    [flow.edges, selectedEdge],
  );

  const edit = (e: PrismaEdit): boolean => {
    const r = dispatch((m) => editDatabaseDsl(m, { id: database.id, edit: e }));
    if (!r.ok) pushToast(r.reason, "error");
    return r.ok;
  };

  const actions: DiagramActions = {
    editable,
    enumNames: schema.enums.map((e) => e.name),
    selectedTable,
    editing,
    renaming,
    edit,
    openColumn: (table, field, focus) => {
      setEditing(field === undefined ? undefined : { table, field, focus });
      if (field !== undefined) selectDesignTable(table, database.id);
    },
    setRenaming,
    addColumn: (table) => {
      const name = freePrismaFieldName(useUntieStore.getState().model.databases.find((d) => d.id === database.id)?.dsl ?? "", table);
      if (edit({ type: "addField", model: table, field: { name, type: "String" } })) setEditing({ table, field: name, focus: true });
    },
    requestRemoveTable: (table) => setRemoving(table),
    renameTable: (from, to) => {
      setRenaming(undefined);
      if (!edit({ type: "renameModel", from, to })) return;
      renameDiagramPosition(database.id, from, to);
      if (editing?.table === from) setEditing({ ...editing, table: to });
      if (selectedTable === from) selectDesignTable(to, database.id);
      setLayoutSeq((n) => n + 1);
    },
  };

  const addTable = () => {
    const name = freePrismaModelName(database.dsl);
    // 今あるノードの右に空けて置く (重ならないように)。置いたところが見えるよう寄せる
    const right = nodes.reduce((max, n) => Math.max(max, n.position.x + (n.measured?.width ?? DIAGRAM_NODE_WIDTH)), Number.NEGATIVE_INFINITY);
    const top = nodes.reduce((min, n) => Math.min(min, n.position.y), Number.POSITIVE_INFINITY);
    const p = nodes.length === 0 ? { x: 0, y: 0 } : { x: right + 70, y: top };
    setDiagramPosition(database.id, tableNodeId(name), p);
    if (!edit({ type: "addModel", name })) return;
    selectDesignTable(name, database.id);
    setRenaming(name);
    window.requestAnimationFrame(() => void rf.setCenter(p.x + DIAGRAM_NODE_WIDTH / 2, p.y + 120, { zoom: rf.getZoom(), duration: 200 }));
  };

  const onNodesChange = (changes: NodeChange<DiagramNode>[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
    for (const c of changes) if (c.type === "position" && c.position) setDiagramPosition(database.id, c.id, c.position);
  };

  const onConnect = (c: Connection) => {
    const from = schema.models.find((m) => tableNodeId(m.name) === c.source)?.name;
    const to = schema.models.find((m) => tableNodeId(m.name) === c.target)?.name;
    const fk = columnOfHandle(c.sourceHandle);
    const ref = columnOfHandle(c.targetHandle);
    if (!from || !to || !fk || !ref) return;
    edit({ type: "addRelation", from, fields: [fk], to, references: [ref] });
  };

  const relationLabel = selectedEdge ? describeRelation(schema, selectedEdge) : "";

  return (
    <ActionsContext.Provider value={actions}>
      <div className="data-diagram-flow">
        <ReactFlow<DiagramNode, DiagramEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onConnect={editable ? onConnect : undefined}
          nodesConnectable={editable}
          nodesFocusable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, node) => {
            if (node.type === "table") selectDesignTable((node.data as TableNodeData).table, database.id);
            setSelectedEdge(undefined);
          }}
          onEdgeClick={(_, edge) => setSelectedEdge(edge.data ? { model: edge.data.model, field: edge.data.field } : undefined)}
          onPaneClick={() => {
            setSelectedEdge(undefined);
            setEditing(undefined);
            selectDesignTable(undefined, database.id);
          }}
        >
          <Background />
          <Controls showInteractive={false} />
          <Panel position="top-left" className="diagram-panel">
            {editable && (
              <button type="button" onClick={addTable}>
                ＋テーブル
              </button>
            )}
            <button
              type="button"
              title="動かした位置を捨てて並べ直す"
              onClick={() => {
                resetDiagramPositions(database.id);
                setLayoutSeq((n) => n + 1);
                window.requestAnimationFrame(() => void rf.fitView({ padding: 0.2, maxZoom: 1 }));
              }}
            >
              並べ直す
            </button>
            {editable && <span className="hint diagram-hint">列の右の点から、参照する列 (主キー) の左の点へ引くと関連になります</span>}
          </Panel>
          {selectedEdge && (
            <Panel position="top-right" className="diagram-panel" aria-label="選んだ関連">
              <span>{relationLabel}</span>
              {editable && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    if (edit({ type: "removeRelation", model: selectedEdge.model, field: selectedEdge.field })) setSelectedEdge(undefined);
                  }}
                >
                  関連を消す
                </button>
              )}
            </Panel>
          )}
        </ReactFlow>
      </div>
      {removing !== undefined && (
        <ConfirmDialog
          title="テーブルを消す"
          message={`${removing} を DSL から消します。ほかのテーブルからの関連と、テーブルが表す情報の対応も消えます。`}
          confirmLabel="消す"
          danger
          onConfirm={() => {
            const name = removing;
            setRemoving(undefined);
            if (edit({ type: "removeModel", name })) {
              if (editing?.table === name) setEditing(undefined);
              if (selectedTable === name) selectDesignTable(undefined, database.id);
            }
          }}
          onCancel={() => setRemoving(undefined)}
        />
      )}
    </ActionsContext.Provider>
  );
}

function describeRelation(schema: ReturnType<typeof parsePrismaDslCached>, sel: { model: string; field: string }): string {
  const f = schema.models.find((m) => m.name === sel.model)?.fields.find((x) => x.name === sel.field);
  if (!f) return "";
  const opposite = oppositeRelationField(schema, sel.model, sel.field);
  return `${sel.model}.${(f.relation?.fields ?? []).join(", ")} → ${f.type}.${(f.relation?.references ?? []).join(", ")}${opposite ? ` (${opposite.model}.${opposite.field})` : ""}`;
}

/**
 * データボードの図 (ER 図)。テーブルと列を図で直す (テーブルの追加・名前変更・削除、列の追加・編集・削除、
 * 列から列へ線を引いて関連を足す、線を選んで関連を消す)。操作はすべて DSL の書き換え (editDatabaseDsl) になるので、
 * テキストに切り替えると同じ内容が出る。DSL に解析エラーがあれば、読めたところだけを見せて編集はできない
 */
export function DataDiagram({ database, readOnly }: { database: Database; readOnly: boolean }) {
  const schema = parsePrismaDslCached(database.dsl);
  const hasErrors = schema.errors.length > 0;
  return (
    <div className="data-diagram" aria-label="データの図">
      {hasErrors && <p className="hint is-error diagram-error">DSL に解析エラーが {schema.errors.length} 件あるので、図では直せません。「テキスト」で直してください。</p>}
      {!hasErrors && schema.models.length === 0 && schema.enums.length === 0 && (
        <p className="hint diagram-empty">{readOnly ? "テーブルがありません" : "「＋テーブル」でテーブルを足すか、「テキスト」で DSL を書いてください"}</p>
      )}
      <ReactFlowProvider>
        <DataDiagramInner database={database} editable={!readOnly && !hasErrors} />
      </ReactFlowProvider>
    </div>
  );
}
