/**
 * アカウントの完全削除（Phase D ／ D3〜D6）で使う、件数を数える道具。
 *
 * 数えるのは「その人にひも付く行の件数」だけ。本文・メールアドレスは読まない・返さない。
 */
import { runSql, lit } from "./db";
import { USER_TABLES } from "./ledger-apply";

/** ログイン情報の側で、その人にひも付く表（Supabase が管理する auth スキーマ） */
export const AUTH_TABLES: { table: string; column: string; cast?: string }[] = [
  { table: "auth.users", column: "id" },
  { table: "auth.identities", column: "user_id" },
  { table: "auth.sessions", column: "user_id" },
  // refresh_tokens の user_id は文字列の列
  { table: "auth.refresh_tokens", column: "user_id", cast: "::text" },
  { table: "auth.mfa_factors", column: "user_id" },
  { table: "auth.one_time_tokens", column: "user_id" },
  { table: "auth.flow_state", column: "user_id" },
];

/** 数える表の一覧（名前だけ）。public の表は USER_TABLES と同じ */
export function allCountedTables(): { label: string; table: string; column: string; cast?: string }[] {
  return [
    ...AUTH_TABLES.map((t) => ({ label: t.table, ...t })),
    ...USER_TABLES.map((t) => ({ label: `public.${t.table}`, table: `public.${t.table}`, column: t.column })),
  ];
}

/** その人にひも付く行の件数（表ごと） */
export function countsFor(userId: string): Record<string, number> {
  const tables = allCountedTables();
  const cols = tables.map(
    (t, i) => `(select count(*) from ${t.table} where ${t.column} = ${lit(userId)}${t.cast ?? ""})::int as c${i}`,
  );
  const [row] = runSql<Record<string, number>>(`select ${cols.join(", ")}`);
  const out: Record<string, number> = {};
  tables.forEach((t, i) => (out[t.label] = Number(row?.[`c${i}`] ?? -1)));
  return out;
}

/** 表ごとの全体の件数（ほかの利用者の件数が変わっていないかを見るため） */
export function totals(): Record<string, number> {
  const tables = allCountedTables();
  const cols = tables.map((t, i) => `(select count(*) from ${t.table})::int as c${i}`);
  const [row] = runSql<Record<string, number>>(`select ${cols.join(", ")}`);
  const out: Record<string, number> = {};
  tables.forEach((t, i) => (out[t.label] = Number(row?.[`c${i}`] ?? -1)));
  return out;
}

export function sum(r: Record<string, number>): number {
  return Object.values(r).reduce((a, b) => a + b, 0);
}
