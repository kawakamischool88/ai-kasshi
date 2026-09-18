/**
 * 運営（管理者）の権限を付ける・外す・一覧する。
 *
 * 実行：
 *   npm run admin                         … いまの管理者を一覧する
 *   npm run admin -- someone@example.com  … 管理者にする
 *   npm run admin -- someone@example.com --remove   … 管理者を外す
 *
 * 本番に対して行うときは、確認のため --yes も付ける：
 *   npm run admin -- kawakami@example.com --yes
 *
 * 【なぜ Secret（service_role）を使わないのか】
 * アプリ本体にも、この命令にも、Secret 鍵を持たせたくない。
 * ここは **Supabase CLI（supabase link した先）** に SQL を流すだけ。
 * つまり「CLI にログインしている人」＝川上さんしか実行できない。
 *
 * 【なぜ本番で止めないのか】
 * 本番の管理者は本番でしか付けられない。だから stopIfNotDev は使わない。
 * そのかわり、**どのプロジェクトに対して行うかを必ず表示**し、
 * 本番のときは --yes が無いと実行しない。
 *
 * 【role は誰が変えられるのか】
 * DB のトリガーで、PostgREST 経由（＝アプリやブラウザ）からは変えられない。
 * 変えられるのは、この命令のように postgres として入ったときだけ。
 */
import { runSql, lit } from "./lib/db";
import { linkedTarget } from "./lib/target";

type Row = { email: string; role: string; id: string };

function list(): void {
  const rows = runSql<Row>(`
    select u.email, p.role, p.id::text as id
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.role = 'admin'
    order by u.email;`);

  if (rows.length === 0) {
    console.log("  管理者はまだ一人もいません。");
    return;
  }
  console.log(`  管理者 ${rows.length} 名：`);
  for (const r of rows) console.log(`    ・${r.email}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const remove = args.includes("--remove");
  const yes = args.includes("--yes");
  const email = args.find((a) => !a.startsWith("--"));

  const target = linkedTarget();

  console.log("");
  console.log("  ────────────────────────────────────────");
  console.log(`  対象：${target.label}`);
  console.log(`  （${target.source}）`);
  console.log("  ────────────────────────────────────────");
  console.log("");

  if (!email) {
    list();
    console.log("");
    console.log("  付けるとき： npm run admin -- メールアドレス");
    console.log("");
    return;
  }

  /* 本番は、取り違えると柏村さんに運営情報が見えることになる。
     見間違いを防ぐため、もう一段はさむ。 */
  if (target.kind !== "dev" && !yes) {
    console.error("  この先は本番（または向き先不明）です。");
    console.error("  内容を確かめたうえで、末尾に --yes を付けて実行してください。");
    console.error(`    npm run admin -- ${email}${remove ? " --remove" : ""} --yes`);
    console.error("");
    process.exit(1);
  }

  // その人がログインできる人として登録されているか、先に確かめる
  const [found] = runSql<{ id: string }>(
    `select id::text as id from auth.users where email = ${lit(email)};`,
  );
  if (!found) {
    console.error(`  中止：${email} は、まだログインできる人として登録されていません。`);
    console.error("  先に  npm run invite -- メールアドレス  を行ってください。");
    console.error("");
    process.exit(1);
  }

  const role = remove ? "user" : "admin";
  runSql(`update public.profiles set role = ${lit(role)} where id = ${lit(found.id)};`);

  console.log(remove ? `  外しました：${email}` : `  管理者にしました：${email}`);
  console.log("");
  list();
  console.log("");
  console.log("  ※ その人が開いている画面には、次に読み込み直したときから反映されます。");
  console.log("");
}

main();
