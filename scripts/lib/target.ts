/**
 * いま、どのSupabaseを向いているかを調べる（dev / prod の取り違え防止）。
 *
 * 【なぜ必要か】
 * 「どのプロジェクトを指すか」の決まり方が、命令によって2種類ある。
 *
 *   ・CLIのリンク（supabase link で決まる）
 *       → db:push / config:push / backup / ledger / restore / export:check
 *   ・.env.test.local に書いたURL
 *       → npm test / reset:test / seed / dev:otp / invite
 *
 * この2つがちがう場所を向いていると、
 * **「控えを取ったのは本番、消したのは開発」** のような取り違えが起きる。
 *
 * 【安全側に倒す】
 * 分からないときは **本番として扱う**。
 * 「知らない場所だから、たぶん開発だろう」とは考えない。
 *
 * 【ここに秘密の値は書かない】
 * 下に並ぶのは**プロジェクトの番号（ref）だけ**。
 * これはアプリの公開URL（NEXT_PUBLIC_SUPABASE_URL）にそのまま入っている値で、
 * ブラウザからも見える。鍵ではない。
 * **鍵（sb_publishable_ / sb_secret_）は、絶対にここへ書かないこと。**
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type Kind = "dev" | "prod" | "unknown";

type Project = { ref: string; name: string; kind: Kind; place: string };

/** 分かっているプロジェクト。増えたらここに足す */
const KNOWN: Project[] = [
  {
    ref: "gdlfxnacypxsqgzklibz",
    name: "ai-kasshi-dev",
    kind: "dev",
    place: "ap-northeast-2（ソウル）",
  },
  {
    ref: "elociphoqqsoawjmjlvy",
    name: "ai-kasshi-prod",
    kind: "prod",
    place: "ap-northeast-1（東京）",
  },
];

export type Target = {
  /** どこを見て決めたか */
  source: string;
  kind: Kind;
  name: string;
  place: string;
  /** 画面に出す1行 */
  label: string;
};

function classify(ref: string | null, source: string): Target {
  if (!ref) {
    return {
      source,
      kind: "unknown",
      name: "（分かりません）",
      place: "—",
      label: "分かりません",
    };
  }
  const found = KNOWN.find((p) => p.ref === ref);
  if (!found) {
    return {
      source,
      kind: "unknown",
      name: "（知らないプロジェクト）",
      place: "—",
      label: "知らないプロジェクト",
    };
  }
  return {
    source,
    kind: found.kind,
    name: found.name,
    place: found.place,
    label: `${found.name}（${found.kind === "prod" ? "本番" : "開発"}・${found.place}）`,
  };
}

/** ファイルの中から、分かっているプロジェクトの番号を探す。中身は表示しない */
function refInFile(file: string): string | null {
  const full = path.resolve(file);
  if (!existsSync(full)) return null;
  const text = readFileSync(full, "utf8");
  for (const p of KNOWN) {
    if (text.includes(p.ref)) return p.ref;
  }
  return null;
}

/** CLI（supabase link）が向いている先 */
export function linkedTarget(): Target {
  const file = path.resolve("supabase", ".temp", "project-ref");
  const ref = existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  return classify(ref, "supabase link（CLI）");
}

/** 開発中のアプリ（npm run dev）が向いている先 */
export function appTarget(): Target {
  return classify(refInFile(".env.local"), ".env.local");
}

/** テストと開発用スクリプトが向いている先 */
export function testTarget(): Target {
  return classify(refInFile(".env.test.local"), ".env.test.local");
}

export function allTargets(): Target[] {
  return [linkedTarget(), appTarget(), testTarget()];
}

/**
 * 本番を向いていたら、その場で止める。
 *
 * 【安全側】
 * 「分からない」ときも止める。取り違えて本番を壊すより、
 * 止まって確認してもらうほうがよい。
 *
 * @param which  何を見て決めるか
 *   "cli"  … supabase link の向き先（restore など、CLI経由でSQLを流す処理）
 *   "test" … .env.test.local の向き先（reset:test など、秘密鍵で直接触る処理）
 */
export function stopIfNotDev(which: "cli" | "test", commandName: string): void {
  const target = which === "cli" ? linkedTarget() : testTarget();

  if (target.kind === "dev") return;

  const how =
    which === "cli"
      ? "npx supabase link --project-ref <開発用の番号>  で開発用へ戻してください"
      : ".env.test.local を開発用（ai-kasshi-dev）に向けてください";

  console.error("");
  console.error("──────────────────────────────────────────");
  console.error(`  中止しました：${commandName} は開発用でしか実行できません`);
  console.error("──────────────────────────────────────────");
  console.error(`  いまの向き先（${target.source}）：${target.label}`);
  console.error("");
  if (target.kind === "prod") {
    console.error("  **本番（柏村さんのデータが入る場所）を向いています。**");
  } else {
    console.error("  向き先が分からなかったため、安全のため本番として扱いました。");
  }
  console.error("");
  console.error(`  ${how}`);
  console.error("  いまの向き先は  npm run where  で確認できます。");
  console.error("");
  process.exit(1);
}
