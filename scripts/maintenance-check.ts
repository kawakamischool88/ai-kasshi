/**
 * 自動の期限処理（Phase B）が動いているかを点検する。
 *
 * 実行： npm run maintenance:check
 *
 * 【読むのは件数と日時だけ】
 * 本文・メールアドレス・利用者や候補の番号は読まないし、表示しない。
 * 開発用のAIツールが画面を読んでも、本文は出ない。
 *
 * 【読み取りだけ】
 * DB を書き換えない。本番でも使える（CLI のリンク先を点検する）。
 * 異常があれば、終了の番号を 1 にする。
 */
import { linkedTarget } from "./lib/target";
import { runSql } from "./lib/db";
import { EXPIRE_JOB, HISTORY_JOB, judgeMaintenance, type MaintenanceStatus } from "./lib/maintenance";

type Row = {
  last_ok: unknown;
  last_run: unknown;
  overdue: number | string;
  jobs: unknown;
  last_cron: unknown;
};

function asObj<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === "string") return JSON.parse(v) as T;
  return v as T;
}

function main() {
  const target = linkedTarget();
  console.log("自動の期限処理の点検（読み取りだけ）");
  console.log(`  点検する DB：${target.label}\n`);

  const [row] = runSql<Row>(`
    select
      (select jsonb_build_object('ranAt', ran_at, 'affected', affected)
         from public.maintenance_runs
        where job = 'expire_candidates' and ok
        order by ran_at desc limit 1) as last_ok,
      (select jsonb_build_object('ranAt', ran_at, 'ok', ok, 'errorCode', error_code)
         from public.maintenance_runs
        where job = 'expire_candidates'
        order by ran_at desc limit 1) as last_run,
      (select count(*)
         from public.memory_candidates
        where status = 'pending' and expires_at < now() - interval '1 day') as overdue,
      (select coalesce(jsonb_agg(jsonb_build_object('name', jobname, 'schedule', schedule, 'active', active)), '[]'::jsonb)
         from cron.job
        where jobname in ('${EXPIRE_JOB}', '${HISTORY_JOB}')) as jobs,
      (select jsonb_build_object('status', d.status, 'endTime', d.end_time)
         from cron.job_run_details d
         join cron.job j on j.jobid = d.jobid
        where j.jobname = '${EXPIRE_JOB}'
        order by d.start_time desc limit 1) as last_cron
  `);

  if (!row) {
    console.error("× 点検の結果を読めませんでした。");
    process.exit(1);
  }

  const status: MaintenanceStatus = {
    lastOk: asObj(row.last_ok),
    lastRun: asObj(row.last_run),
    overdue: Number(row.overdue),
    jobs: asObj(row.jobs) ?? [],
    lastCron: asObj(row.last_cron),
  };

  const { level, lines } = judgeMaintenance(status);
  for (const l of lines) console.log(l);

  console.log("");
  if (level === "ng") {
    console.log("× 異常があります。上の × の行を確かめてください。");
    process.exit(1);
  }
  console.log(level === "warn" ? "△ 注意があります（上の △ の行）。" : "○ 異常はありません。");
}

main();
