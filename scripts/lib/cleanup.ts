/**
 * 運営バックアップの30日の片付け（Phase D ／ D2）の判定。DB に触れない。
 *
 * 【見るのは目録（manifest.json）だけ】
 * 表のファイル（本文が入っている）は開かない・読まない・表示しない。
 *
 * 【自動では消さないもの】
 *   ・ledger/（台帳）… 絶対に触れない
 *   ・リンク（symlink・junction）… たどらない
 *   ・名前が作成日時の形でないフォルダ
 *   ・目録が無い・壊れている・向き先が分からない（Phase D より前の古い控え）
 *   ・中にリンクがあるフォルダ
 * これらは「運営者が確かめて手で扱う」と表示するだけ。
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Row } from "./ledger-file";

/** 控えのフォルダの名前の形（npm run backup が作る。例 2026-09-29T06-35-21-149Z） */
export const BACKUP_DIR_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export type Kind = "dev" | "prod" | "unknown";

export type Entry = {
  name: string;
  createdAt: string | null;
  kind: Kind;
  totalRows: number | null;
  ageDays: number | null;
  /** delete＝消す候補 ／ keep＝残す ／ manual＝自動では扱わない（運営者が確かめる） */
  decision: "delete" | "keep" | "manual";
  reason: string;
};

export type Plan = {
  entries: Entry[];
  /** 30日以内の本番の控えの数 */
  recentProd: number;
  /** 本番の消す候補があるのに、30日以内の本番の控えが1つも無い（＝全部消えてしまう） */
  prodBlocked: boolean;
};

const DAY = 24 * 60 * 60 * 1000;

function manual(name: string, reason: string, extra: Partial<Entry> = {}): Entry {
  return { name, createdAt: null, kind: "unknown", totalRows: null, ageDays: null, decision: "manual", reason, ...extra };
}

/** 控えのフォルダを1つ判定する */
function judge(root: string, name: string, now: Date, retentionDays: number): Entry | null {
  const full = path.join(root, name);
  const st = lstatSync(full);

  if (name === "ledger") return null; // 台帳には触れない（一覧にも出さない）
  if (st.isSymbolicLink()) return manual(name, "リンク（たどらない）");
  if (!st.isDirectory()) return null; // ファイルは対象外
  if (!BACKUP_DIR_NAME.test(name)) return manual(name, "名前が作成日時の形ではない");

  const inner = readdirSync(full, { withFileTypes: true });
  if (inner.some((d) => d.isSymbolicLink())) return manual(name, "中にリンクがある");

  const manifestPath = path.join(full, "manifest.json");
  if (!existsSync(manifestPath)) return manual(name, "目録（manifest.json）が無い");
  if (lstatSync(manifestPath).isSymbolicLink()) return manual(name, "目録がリンク");

  let m: { createdAt?: unknown; totalRows?: unknown; target?: { kind?: unknown } };
  try {
    m = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return manual(name, "目録が壊れている");
  }

  const createdAt = typeof m.createdAt === "string" ? m.createdAt : null;
  const t = createdAt ? new Date(createdAt).getTime() : NaN;
  const totalRows = typeof m.totalRows === "number" ? m.totalRows : null;
  if (!createdAt || Number.isNaN(t)) return manual(name, "目録の作成日時が読めない", { totalRows });

  const kind: Kind = m.target?.kind === "dev" || m.target?.kind === "prod" ? m.target.kind : "unknown";
  const ageDays = (now.getTime() - t) / DAY;
  if (kind === "unknown") {
    return manual(name, "向き先が分からない（Phase D より前の古い控え）", { createdAt, totalRows, ageDays });
  }
  if (ageDays > retentionDays) {
    return { name, createdAt, kind, totalRows, ageDays, decision: "delete", reason: `${retentionDays}日を過ぎた` };
  }
  return { name, createdAt, kind, totalRows, ageDays, decision: "keep", reason: `${retentionDays}日以内` };
}

/** backups/ 直下を調べて、片付けの計画を作る（何も消さない） */
export function planCleanup(root: string, now: Date, retentionDays: number): Plan {
  const entries: Entry[] = [];
  if (existsSync(root)) {
    for (const name of readdirSync(root).sort()) {
      const e = judge(root, name, now, retentionDays);
      if (e) entries.push(e);
    }
  }
  const recentProd = entries.filter((e) => e.kind === "prod" && e.decision === "keep").length;
  const prodBlocked = recentProd === 0 && entries.some((e) => e.kind === "prod" && e.decision === "delete");
  return { entries, recentProd, prodBlocked };
}

/** アカウントの完全削除の台帳のうち、保存日数を過ぎた行と残す行に分ける */
export function splitAccountLedger(rows: Row[], now: Date, keepDays: number): { keep: Row[]; expired: Row[] } {
  const limit = now.getTime() - keepDays * DAY;
  const keep: Row[] = [];
  const expired: Row[] = [];
  for (const r of rows) {
    const t = new Date(String(r.deleted_at)).getTime();
    // 日時が読めない行は、消さずに残す（守りを外さない側に倒す）
    if (!Number.isNaN(t) && t < limit) expired.push(r);
    else keep.push(r);
  }
  return { keep, expired };
}
