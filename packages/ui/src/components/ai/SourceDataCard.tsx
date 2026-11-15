import { useEffect, useId, useRef, useState } from "react";
import { getPlatform } from "../../platform";
import { commitStageModel } from "../../ai/reverseCommit";
import {
  applyDataImport,
  canImportPreview,
  dataImportSummary,
  defaultDatabaseName,
  defaultSchemaSelection,
  describeSchemaNotes,
  findSchemaCandidates,
  planDataImport,
  previewSchema,
  comparePaths,
  type SchemaCandidate,
  type SchemaInput,
  type SchemaPreview,
} from "../../ai/reverseData";
import type { SourceTree } from "../../ai/sourceTree";
import { useUntieStore } from "../../store";

/** データの段階が見る、登録したソースの 1 行 */
export interface DataSourceRow {
  key: number;
  label: string;
  tree: SourceTree | null;
  /** フォルダを選んだ回数 (選び直したら、候補を探し直す) */
  picks: number;
}

/** 段階が終わったことを、ダイアログへ知らせる内容 */
export interface StageDone {
  stage: "data" | "screens" | "logic";
  summary: string;
  warnings: string[];
  /** AI のペインへ引き継ぐ会話 */
  seed: { role: "user" | "assistant"; text: string }[];
}

/** 候補 (どのソースの行のものか・画面に出すパス・選択の識別) */
interface ShownCandidate extends SchemaCandidate {
  id: string;
  rowKey: number;
  display: string;
  rowLabel: string;
  folder: string;
}

/** 直接選んだファイル */
interface PickedFile {
  id: string;
  name: string;
  text: string;
  kind: "sql" | "prisma";
}

const kb = (n: number): string => (n < 1024 ? `${n} B` : `${Math.max(1, Math.round(n / 1024))} KB`);
const PREVIEW_TABLES = 30;

/** 段階 1: データ。登録したソースの SQL・schema.prisma から機械的に DSL を作り、データベースに取り込む (AI は使わない) */
export function SourceDataCard({
  rows,
  progress,
  disabled,
  onDone,
  onError,
}: {
  rows: readonly DataSourceRow[];
  progress: string;
  disabled: boolean;
  onDone: (done: StageDone) => void;
  onError: (message: string) => void;
}) {
  const headingId = useId();
  const [scanned, setScanned] = useState<Map<string, { candidates: SchemaCandidate[]; notes: string[] }>>(new Map());
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [preview, setPreview] = useState<SchemaPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ name: string; droppedBindings: number; droppedMappings: string[] } | null>(null);
  const known = useRef(new Set<string>());
  const pickedSeq = useRef(0);

  // ソースのフォルダが選ばれた・選び直されたら、スキーマ定義の候補を探す
  const scanKey = rows.map((r) => (r.tree ? `${r.key}:${r.picks}` : "-")).join(",");
  useEffect(() => {
    let cancelled = false;
    setScanning(true);
    void (async () => {
      const next = new Map<string, { candidates: SchemaCandidate[]; notes: string[] }>();
      for (const r of rows) {
        if (!r.tree) continue;
        const key = `${r.key}:${r.picks}`;
        next.set(key, await findSchemaCandidates(r.tree).catch(() => ({ candidates: [], notes: [] })));
      }
      if (cancelled) return;
      setScanned(next);
      setScanning(false);
    })();
    return () => {
      cancelled = true;
    };
    // 木の組が替わったときだけ探し直す (ラベルの入力では探し直さない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanKey]);

  const candidates: ShownCandidate[] = rows.flatMap((r) => {
    const found = r.tree ? scanned.get(`${r.key}:${r.picks}`) : undefined;
    const label = r.label.trim();
    return (found?.candidates ?? []).map((c) => ({ ...c, id: `${r.key}:${c.path}`, rowKey: r.key, rowLabel: label, folder: r.tree!.name, display: label ? `${label}/${c.path}` : c.path }));
  });
  const scanNotes = rows.flatMap((r) => (r.tree ? (scanned.get(`${r.key}:${r.picks}`)?.notes ?? []) : []));
  const candidateKey = candidates.map((c) => c.id).join("\n");
  // 探し終えたら、新しく見つかった候補のうち、既定の選び方に当たるものを選ぶ (利用者が外したものは、見つけ直しても戻さない)。無くなった候補は外す
  useEffect(() => {
    if (scanning) return;
    const ids = new Set(candidates.map((c) => c.id));
    // 新しく見つかったもの (更新関数は後で走るので、いま決めておく)
    const fresh = [...defaultSchemaSelection(candidates)].filter((id) => !known.current.has(id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      for (const id of fresh) next.add(id);
      return next;
    });
    known.current = ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey, scanning]);

  const chosen = candidates.filter((c) => selected.has(c.id));
  const defaultName = chosen[0] ? defaultDatabaseName(chosen[0].rowLabel, chosen[0].folder) : defaultDatabaseName("", "");
  useEffect(() => {
    if (!nameTouched) setName(defaultName);
  }, [defaultName, nameTouched]);

  // 選ぶ組が替わったら、変換の結果は古い
  const choiceKey = `${[...selected].sort().join("\n")}|${picked.map((p) => p.id).join(",")}`;
  useEffect(() => {
    setPreview(null);
    setConfirm(null);
  }, [choiceKey]);

  const pickFile = async () => {
    setBusy(true);
    try {
      const file = await getPlatform().openTextFile({ description: "SQL・Prisma のスキーマ", extensions: ["sql", "prisma"] });
      if (file) setPicked((p) => [...p, { id: `file-${++pickedSeq.current}`, name: file.name, text: file.text, kind: /\.prisma$/i.test(file.name) ? "prisma" : "sql" }]);
    } catch (e) {
      onError(`ファイルを読めませんでした。(${String(e)})`);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const hasInput = chosen.length > 0 || picked.length > 0;

  /** 選んだファイルを読んで、変換して見せる。SQL は、パスの名前順に当てる (マイグレーションの積み重ね。直接選んだファイルは選んだ順で、そのあと) */
  const convert = async () => {
    setBusy(true);
    onError("");
    try {
      const inputs: SchemaInput[] = [];
      for (const c of [...chosen].sort((a, b) => comparePaths(a.display, b.display))) inputs.push({ path: c.display, kind: c.kind, text: await c.read() });
      for (const p of picked) inputs.push({ path: p.name, kind: p.kind, text: p.text });
      setPreview(previewSchema(inputs));
      setConfirm(null);
    } catch (e) {
      onError(`ファイルを読めませんでした。(${String(e)})`);
    } finally {
      setBusy(false);
    }
  };

  const doImport = (replaceOk: boolean) => {
    if (!preview || !canImportPreview(preview)) return;
    const st = useUntieStore.getState();
    const base = st.model;
    const input = { name, dsl: preview.dsl };
    const plan = planDataImport(base, input);
    if (plan.replaces && !replaceOk) {
      setConfirm({ name: name.trim(), droppedBindings: plan.droppedBindings, droppedMappings: plan.droppedMappings });
      return;
    }
    const r = applyDataImport(base, input);
    if (r.failure) {
      onError(r.failure);
      return;
    }
    const c = commitStageModel(base, r.model, st.docSeq);
    if (!c.ok) {
      onError(c.reason);
      return;
    }
    setConfirm(null);
    const summary = dataImportSummary(preview, name.trim(), r);
    const warnings = [
      ...describeSchemaNotes(preview.notes).map((n) => `変換: ${n}`),
      ...(r.droppedBindings > 0 ? [`画面の項目と列の対応 ${r.droppedBindings} 件を、無くなったテーブル・列のため外しました`] : []),
      ...(r.droppedMappings.length > 0 ? [`情報との対応を、無くなったテーブル (${r.droppedMappings.slice(0, 5).join("、")}${r.droppedMappings.length > 5 ? " ほか" : ""}) から外しました`] : []),
      ...(r.keptMappings > 0 ? [`同じ名前のテーブル ${r.keptMappings} 件の、情報との対応は残しました`] : []),
      ...r.warnings.filter((w) => !/がどのテーブルにも対応していません/.test(w)),
      "テーブルと情報の対応は、ここでは付けていません (業務の段階が付けます。データボードで手で結ぶこともできます)",
    ];
    onDone({
      stage: "data",
      summary,
      warnings,
      seed: [
        { role: "user", text: `ソースコードの SQL・Prisma のスキーマから、データベース「${name.trim()}」を取り込みました。` },
        { role: "assistant", text: `${summary}\nテーブル: ${preview.tables.slice(0, 40).map((t) => t.name).join("、")}${preview.tables.length > 40 ? " ほか" : ""}` },
      ],
    });
    setPreview(null);
  };

  const columnTotal = preview ? preview.tables.reduce((n, t) => n + t.columns, 0) : 0;

  return (
    <section className="stage-card" aria-labelledby={headingId}>
      <div className="stage-card-head">
        <h3 id={headingId}>1. データ</h3>
        <span className="stage-progress">進み具合: {progress}</span>
      </div>
      <p className="source-note">
        ソースにある SQL (CREATE TABLE) と schema.prisma を、AI を使わずに機械的に変換して、データベースに取り込みます。<strong>AI には何も送りません</strong> (API キーも要りません。ファイルはこの画面の中だけで読みます)。
      </p>
      <div className="stage-sub">スキーマ定義の候補 (ソースから探したもの)</div>
      {scanning ? (
        <p className="source-note" role="status">
          探しています…
        </p>
      ) : candidates.length === 0 ? (
        <p className="source-note">{rows.some((r) => r.tree) ? "登録したソースに、SQL と schema.prisma は見つかりませんでした。" : "ソースを登録すると、SQL と schema.prisma を探します。"}</p>
      ) : (
        <ul className="stage-list" aria-label="スキーマ定義の候補">
          {candidates.map((c) => (
            <li key={c.id}>
              <label className="candidate-row">
                <input type="checkbox" checked={selected.has(c.id)} disabled={disabled || busy} onChange={() => toggle(c.id)} />
                <span className="candidate-text">
                  <span className="candidate-path">{c.display}</span>
                  <span className="candidate-meta">
                    {kb(c.size)}・{c.kind === "prisma" ? (c.hasTables ? "model あり" : "model なし") : c.hasTables ? "CREATE TABLE あり" : "CREATE TABLE なし"}
                    {c.migration ? "・マイグレーション" : ""}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {scanNotes.map((n) => (
        <p key={n} className="source-note">
          {n}
        </p>
      ))}
      <p className="source-note">既定では、schema.prisma があればそれだけ、無ければ CREATE TABLE を含む SQL (ダンプ)、それも無ければマイグレーションの SQL を選びます。複数選んだ SQL は、パスの名前順に当てます。</p>
      <div className="source-folder">
        <button type="button" disabled={disabled || busy} onClick={() => void pickFile()}>
          SQL のファイルを選ぶ…
        </button>
        <span className="source-folder-count">ソースに無いときは、ファイルを直接選べます (何度でも足せます)</span>
      </div>
      {picked.length > 0 && (
        <ul className="stage-list" aria-label="直接選んだファイル">
          {picked.map((p) => (
            <li key={p.id} className="candidate-row">
              <span className="candidate-path">{p.name}</span>
              <span className="candidate-meta">{kb(p.text.length)}・直接選んだ</span>
              <button type="button" className="link-plain" disabled={disabled || busy} aria-label={`${p.name} を外す`} onClick={() => setPicked((all) => all.filter((x) => x.id !== p.id))}>
                外す
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="stage-field">
        <span>データベースの名前</span>
        <input
          value={name}
          maxLength={200}
          disabled={disabled || busy}
          onChange={(e) => {
            setName(e.target.value);
            setNameTouched(true);
          }}
        />
      </label>
      <div className="stage-actions">
        <button type="button" disabled={disabled || busy || !hasInput} onClick={() => void convert()}>
          変換して確かめる
        </button>
      </div>
      {preview && (
        <div className="stage-preview">
          <div className="prompt-step" role="status">
            {preview.failure
              ? preview.failure
              : preview.tables.length === 0
                ? "テーブルが 1 つも見つかりませんでした。"
                : `変換の結果: テーブル ${preview.tables.length} (列 ${columnTotal})${preview.enums.length > 0 ? `・enum ${preview.enums.length}` : ""}`}
          </div>
          {preview.tables.length > 0 && (
            <ul className="stage-tables" aria-label="変換したテーブル">
              {preview.tables.slice(0, PREVIEW_TABLES).map((t) => (
                <li key={t.name}>
                  {t.name} <span className="candidate-meta">列 {t.columns}</span>
                </li>
              ))}
              {preview.tables.length > PREVIEW_TABLES && <li className="candidate-meta">ほか {preview.tables.length - PREVIEW_TABLES} テーブル</li>}
            </ul>
          )}
          {preview.notes.length > 0 && (
            <>
              <div className="prompt-step">気づいたこと ({preview.notes.length} 件)</div>
              <ul className="stage-notes">
                {describeSchemaNotes(preview.notes).map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </>
          )}
          {preview.dslErrors.length > 0 && (
            <>
              <div className="prompt-step prompt-error">DSL のエラー ({preview.dslErrors.length} 件。直るまで取り込めません)</div>
              <ul className="stage-notes">
                {preview.dslErrors.slice(0, 10).map((e, i) => (
                  <li key={i}>
                    {e.line} 行 {e.column} 列: {e.message}
                  </li>
                ))}
              </ul>
            </>
          )}
          {confirm ? (
            <div className="stage-confirm" role="alert">
              <p>
                データベース「{confirm.name}」はすでにあります。置き換えると、
                {confirm.droppedBindings > 0 || confirm.droppedMappings.length > 0
                  ? `無くなったテーブル・列への、画面の項目と列の対応 ${confirm.droppedBindings} 件と、情報との対応 ${confirm.droppedMappings.length} 件が外れます。`
                  : "外れる対応はありません (同じ名前のテーブルの、情報との対応は残ります)。"}
              </p>
              <div className="stage-actions">
                <button type="button" className="primary" disabled={disabled} onClick={() => doImport(true)}>
                  置き換える
                </button>
                <button type="button" disabled={disabled} onClick={() => setConfirm(null)}>
                  やめる
                </button>
              </div>
            </div>
          ) : (
            <div className="stage-actions">
              <button type="button" className="primary" disabled={disabled || busy || !canImportPreview(preview) || name.trim() === ""} onClick={() => doImport(false)}>
                取り込む
              </button>
            </div>
          )}
        </div>
      )}
      <p className="source-note">SQL も schema.prisma も無いプロジェクト (ORM のモデル定義だけ) は、この段階では取り込めません。AI のペインにモデル定義を貼って、データボードの DSL に写してもらってください。</p>
    </section>
  );
}
