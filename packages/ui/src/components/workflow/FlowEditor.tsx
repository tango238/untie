import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { moveBusinessOrder, removeElement, updateElement, type CommandResult } from "@untie/core/model/commands";
import { adjacentBusinessInFlow } from "@untie/core/model/activityFlow";
import { fixedBoardId } from "@untie/core/model/fixedBoards";
import { NAME_MAX_LENGTH } from "@untie/core/model/limits";
import type { Actor, Element, UntieModel } from "@untie/core/model/types";
import { activityParentOptions, addWorkflowElement } from "@untie/core/model/workflow";
import { useUntieStore } from "../../store";
import { canvasApi } from "../canvas/canvasApi";
import { planRemoval, RemovalConfirmDialog, type RemovalPlan } from "../RemovalConfirm";
import { nameOf } from "./WorkflowBoard";

type DialogKind = "addBusiness" | "addActivity";

/**
 * 情報整理の業務フローの見出しの右上に置く、業務と作業を足す・消すボタンと、業務の並び順のボタン。
 * 名前・担当・順序・きっかけなどは、選んだときの右のプロパティで直す。閲覧専用では呼ばない
 */
export function FlowEditBar() {
  const model = useUntieStore((s) => s.model);
  const selectedId = useUntieStore((s) => (s.ui.selection?.type === "element" ? s.ui.selection.id : null));
  const dispatch = useUntieStore((s) => s.dispatch);
  const select = useUntieStore((s) => s.select);
  const setRightPanel = useUntieStore((s) => s.setRightPanel);
  const pushToast = useUntieStore((s) => s.pushToast);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  // 削除の確認は、開いたときの要素の id を持ち、描くたびにモデルから引き直す (同時編集・Undo で消えたら閉じる)
  const [removal, setRemoval] = useState<{ id: string; plan: RemovalPlan } | null>(null);

  const selected = selectedId ? model.elements.find((e) => e.id === selectedId) : undefined;
  const business = selected?.kind === "business" ? selected : undefined;
  const activity = selected?.kind === "activity" ? selected : undefined;

  const removing = removal ? model.elements.find((e) => e.id === removal.id) : undefined;
  useEffect(() => {
    if (removal && !removing) {
      setRemoval(null);
      pushToast("削除しようとしていた業務・作業が見つからなくなったので、確認を閉じました");
    }
  }, [removal, removing, pushToast]);

  /** 足した要素を選んで、図の中のその場所へスクロールする */
  const reveal = (id: string) => {
    select({ type: "element", id });
    setRightPanel("properties");
    setTimeout(() => canvasApi.focus?.(id), 50);
  };

  const remove = (element: Element) => {
    const r = dispatch((m) => removeElement(m, { id: element.id }));
    if (!r.ok) pushToast(r.reason, "error");
  };
  const askRemove = (element: Element | undefined) => {
    if (!element) return;
    // PropertyPanel の「削除」と同じ: つながっているものや設計データが巻き込まれるときは、確かめてから消す
    const plan = planRemoval(model, element.id, true);
    if (plan) setRemoval({ id: element.id, plan });
    else remove(element);
  };

  /** 業務を、図に出ている隣の業務と入れ替える。選択は保ち、動いた山形が見えるようにスクロールする (dispatch 1 回 = 履歴 1 件) */
  const moveBusiness = (direction: "before" | "after") => {
    if (!business) return;
    const targetId = adjacentBusinessInFlow(model, business.id, direction);
    if (!targetId) return;
    const r = dispatch((m) => moveBusinessOrder(m, { id: business.id, targetId, position: direction }));
    if (!r.ok) {
      pushToast(r.reason, "error");
      return;
    }
    setTimeout(() => canvasApi.focus?.(business.id), 50);
  };
  // 押せない理由を title で伝える
  const moveButton = (direction: "before" | "after") => {
    const label = direction === "before" ? "← 前へ" : "後ろへ →";
    const neighbor = business ? adjacentBusinessInFlow(model, business.id, direction) : null;
    const title = !business
      ? "業務を選ぶと使えます"
      : neighbor
        ? `選んでいる業務を${direction === "before" ? "前へ (左へ)" : "後ろへ (右へ)"}動かす`
        : direction === "before"
          ? "図の左端の業務です"
          : "図の右端の業務です";
    return (
      <button type="button" aria-label={`業務を${direction === "before" ? "前へ" : "後ろへ"}`} disabled={!neighbor} title={title} onClick={() => moveBusiness(direction)}>
        {label}
      </button>
    );
  };

  const group = (kind: "業務" | "作業", target: Element | undefined, add: DialogKind, del: () => void, extra?: ReactNode) => (
    <div className="flow-edit-group" role="group" aria-label={`${kind}の操作`}>
      <span className="flow-edit-label">{kind}</span>
      <button type="button" aria-label={`${kind}を追加`} title={`${kind}を足す`} onClick={() => setDialog(add)}>
        ＋追加
      </button>
      {extra}
      <button type="button" className="danger" aria-label={`${kind}を削除`} disabled={!target} title={target ? `選んでいる${kind}を削除する` : `${kind}を選ぶと使えます`} onClick={del}>
        削除
      </button>
    </div>
  );

  return (
    <>
      <div className="flow-edit">
        {group("業務", business, "addBusiness", () => askRemove(business), <>{moveButton("before")}{moveButton("after")}</>)}
        {group("作業", activity, "addActivity", () => askRemove(activity))}
      </div>
      {/* 見出しは横スクロールで残すために sticky にしていて、重なりの文脈を作る。その中に置くと図の下に潜るので、ダイアログは body の直下に描く */}
      {createPortal(
        <>
      {dialog === "addBusiness" && (
        <AddBusinessDialog
          model={model}
          onClose={() => setDialog(null)}
          onAdded={(id) => {
            setDialog(null);
            reveal(id);
          }}
        />
      )}
      {dialog === "addActivity" && <AddActivityDialog model={model} selected={selected} onClose={() => setDialog(null)} onAdded={(id) => { setDialog(null); reveal(id); }} />}
      {removal && removing && (
        <RemovalConfirmDialog
          element={removing}
          plan={removal.plan}
          onCancel={() => setRemoval(null)}
          onConfirm={() => {
            setRemoval(null);
            remove(removing);
          }}
        />
      )}
        </>,
        document.body,
      )}
    </>
  );
}

/** 小さなダイアログの枠。Esc で閉じる (背景のクリックでは閉じない。入力の途中を失わないため) */
function FormDialog({ title, onClose, onSubmit, children, actions }: { title: string; onClose: () => void; onSubmit: (e: FormEvent) => void; children: ReactNode; actions: ReactNode }) {
  return (
    <div
      className="dialog-backdrop"
      onKeyDown={(e) => {
        // 変換中の Esc (変換の取り消し) では閉じない
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="dialog flow-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <form onSubmit={onSubmit}>
          <h2>{title}</h2>
          {children}
          <div className="dialog-actions">{actions}</div>
        </form>
      </div>
    </div>
  );
}

/** 名前の入力 (開いたら先頭にフォーカス)。変換確定の Enter では送らない */
function NameField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // WebKit は変換確定の Enter を compositionend の後に isComposing=false, keyCode=229 で送ることがある
    if ((e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) && e.key === "Enter") e.preventDefault();
  };
  return (
    <label className="flow-dialog-field">
      <span>{label}</span>
      <input ref={ref} aria-label={label} maxLength={NAME_MAX_LENGTH} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />
    </label>
  );
}

/** 名前を入れる更新を、作成と同じ 1 回の dispatch (履歴 1 件) に入れる */
function withName(created: CommandResult<{ id: string }>, name: string): CommandResult<{ id: string }> {
  if (!created.ok) return created;
  const named = updateElement(created.model, { id: created.id, patch: { name } });
  return named.ok ? { ok: true, model: named.model, id: created.id } : named;
}

const actorsOf = (model: UntieModel): Actor[] => model.elements.filter((e): e is Actor => e.kind === "actor");

function AddBusinessDialog({ model, onClose, onAdded }: { model: UntieModel; onClose: () => void; onAdded: (id: string) => void }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const setCurrentBoard = useUntieStore((s) => s.setCurrentBoard);
  const actors = useMemo(() => actorsOf(model), [model]);
  const [name, setName] = useState("");
  const [actorId, setActorId] = useState(actors[0]?.id ?? "");
  const valid = name.trim() !== "" && actorId !== "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const r = dispatch((m) => withName(addWorkflowElement(m, "business", actorId), name));
    if (!r.ok) {
      pushToast(r.reason, "error");
      return;
    }
    onAdded(r.id);
  };

  if (actors.length === 0) {
    return (
      <FormDialog
        title="業務を追加"
        onClose={onClose}
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
          setCurrentBoard(fixedBoardId("actor"));
        }}
        actions={
          <>
            <button type="button" onClick={onClose}>
              キャンセル
            </button>
            <button type="submit" className="primary" autoFocus>
              登場人物ボードへ
            </button>
          </>
        }
      >
        <p>業務の主担当にする登場人物がまだいません。先に「登場人物」ボードで登場人物を足してください。</p>
      </FormDialog>
    );
  }
  return (
    <FormDialog
      title="業務を追加"
      onClose={onClose}
      onSubmit={submit}
      actions={
        <>
          <button type="button" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            追加
          </button>
        </>
      }
    >
      <NameField value={name} onChange={setName} label="業務の名前" />
      <label className="flow-dialog-field">
        <span>主担当の登場人物</span>
        <select aria-label="主担当の登場人物" value={actorId} onChange={(e) => setActorId(e.target.value)}>
          {actors.map((a) => (
            <option key={a.id} value={a.id}>
              {nameOf(a)}
            </option>
          ))}
        </select>
      </label>
    </FormDialog>
  );
}

/** 選んでいる要素に合う、作業の足し先の初期値。業務を選んでいればその業務、作業を選んでいればその作業と同じ足し先 */
function defaultParentId(model: UntieModel, options: { id: string }[], selected: Element | undefined): string {
  let wanted: string | undefined;
  if (selected?.kind === "business") {
    wanted = selected.id;
    // 活動のある業務は、業務そのものではなく活動が足し先。その業務の最初の活動を初期値にする
    if (!options.some((o) => o.id === wanted)) wanted = model.elements.find((e) => e.kind === "buc" && !e.isDefault && e.businessId === selected.id && options.some((o) => o.id === e.id))?.id;
  } else if (selected?.kind === "activity") {
    const buc = selected.bucId ? model.elements.find((e) => e.id === selected.bucId) : undefined;
    if (buc?.kind === "buc") wanted = buc.isDefault ? buc.businessId : buc.id;
  }
  return options.find((o) => o.id === wanted)?.id ?? options[0]?.id ?? "";
}

function AddActivityDialog({ model, selected, onClose, onAdded }: { model: UntieModel; selected: Element | undefined; onClose: () => void; onAdded: (id: string) => void }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const options = useMemo(() => activityParentOptions(model), [model]);
  const actors = useMemo(() => actorsOf(model), [model]);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState(() => defaultParentId(model, options, selected));
  // 担当は任意 (空は「担当なし」)
  const [assigneeId, setAssigneeId] = useState("");
  const valid = name.trim() !== "" && parentId !== "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const r = dispatch((m) => withName(addWorkflowElement(m, "activity", parentId, assigneeId ? { assigneeId } : {}), name));
    if (!r.ok) {
      pushToast(r.reason, "error");
      return;
    }
    onAdded(r.id);
  };

  if (options.length === 0) {
    return (
      <FormDialog
        title="作業を追加"
        onClose={onClose}
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
        }}
        actions={
          <button type="submit" className="primary" autoFocus>
            閉じる
          </button>
        }
      >
        <p>作業を足せる業務がまだありません。先に「業務」の「＋追加」で業務を足してください。</p>
      </FormDialog>
    );
  }
  return (
    <FormDialog
      title="作業を追加"
      onClose={onClose}
      onSubmit={submit}
      actions={
        <>
          <button type="button" onClick={onClose}>
            キャンセル
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            追加
          </button>
        </>
      }
    >
      <NameField value={name} onChange={setName} label="作業の名前" />
      <label className="flow-dialog-field">
        <span>足し先 (業務・活動)</span>
        <select aria-label="足し先" value={parentId} onChange={(e) => setParentId(e.target.value)}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flow-dialog-field">
        <span>担当の登場人物 (任意)</span>
        <select aria-label="担当の登場人物" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
          <option value="">担当なし</option>
          {actors.map((a) => (
            <option key={a.id} value={a.id}>
              {nameOf(a)}
            </option>
          ))}
        </select>
      </label>
    </FormDialog>
  );
}
