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
import { runSql, lit, setSqlPurpose } from "./lib/db";

// 管理者の一覧と、メールアドレスでの検索のため（運営者が自分で実行する命令）（Phase E）
setSqlPurpose("account-lookup");
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

  /* その人がログインできる人として登録されているか、先に確かめる。

     【小文字にそろえて突き合わせる理由】
     Supabase はメールアドレスを小文字で保存する。
     打ち込んだほうに大文字が1文字でも混ざっていると、
     完全一致では見つからず「登録されていません」と誤って出る。 */
  const [found] = runSql<{ id: string; mail: string }>(
    `select id::text as id, email as mail
       from auth.users
      where lower(email) = lower(${lit(email)});`,
  );
  if (!found) {
    console.error(`  中止：${email} は、この Supabase にまだ登録されていません。`);
    console.error("");
    if (target.kind === "dev") {
      console.error("  開発用なら  npm run invite -- メールアドレス  で登録できます。");
    } else {
      /* npm run invite は .env.test.local（＝開発用）を見る。
         本番のつもりで実行すると、**開発用に別の人が作られるだけ**で
         本番には何も起きない。だから本番では案内しない。 */
      console.error("  **本番では npm run invite を使わないでください。**");
      console.error("  これは .env.test.local（開発用）を見るため、開発用に作られてしまいます。");
      console.error("");
      console.error("  Supabase の画面から登録してください：");
      console.error("    Authentication → Users → Add user → Send invitation");
      console.error("  登録できたら、もう一度この命令を実行してください。");
    }
    console.error("");
    process.exit(1);
  }

  /* 打ち込んだ文字ではなく、**保存されている文字**を以後は使う。
     取り違えていたときに、本人が画面で気づけるようにするため。 */
  if (found.mail !== email) {
    console.log(`  保存されているアドレス：${found.mail}`);
    console.log("");
  }

  /* Auth には居るのに profiles の行が無いことへの備え。
     ふだんは auth.users への追加と同時にトリガーが作るので、ここは通らない。
     通るとしたら、その仕組みが無かった頃に作られた人だけ。

     作るのは「すでに Auth に居る人」の行だけなので、新しい人は増えない。
     role は既定の 'user' で入るので、この時点では権限は上がらない。 */
  const [made] = runSql<{ id: string }>(`
    insert into public.profiles (id, display_name)
    select u.id, coalesce(u.raw_user_meta_data ->> 'display_name', '')
    from auth.users u
    where u.id = ${lit(found.id)}
    on conflict (id) do nothing
    returning id::text as id;`);
  if (made) {
    console.log("  profiles の行がなかったので、先に作りました。");
    console.log("");
  }

  /* 本当に書けたかを確かめる。
     returning で戻ってきた行が無ければ、書けていない。
     ここを確かめないと、0件しか更新していなくても「しました」と出てしまう。 */
  const role = remove ? "user" : "admin";
  const changed = runSql<{ id: string }>(
    `update public.profiles
        set role = ${lit(role)}
      where id = ${lit(found.id)}
      returning id::text as id;`,
  );
  if (changed.length === 0) {
    console.error("  中止：権限を書き込めませんでした（profiles の行が見つかりません）。");
    console.error("  何も変わっていません。ご連絡ください。");
    console.error("");
    process.exit(1);
  }

  console.log(remove ? `  外しました：${found.mail}` : `  管理者にしました：${found.mail}`);
  console.log("");
  list();
  console.log("");
  console.log("  ※ その人が開いている画面には、次に読み込み直したときから反映されます。");
  console.log("");
}

main();
