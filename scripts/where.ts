/**
 * いま、どのSupabaseを向いているかを表示する。
 *
 * 実行： npm run where
 *
 * 【なぜ必要か】
 * 「どのプロジェクトを指すか」の決まり方が命令によって違うため、
 * **作業を始める前に、必ずこれで確かめる**。
 *
 * 秘密の値（鍵）は一切表示しない。プロジェクトの名前と場所だけを出す。
 */
import { appTarget, linkedTarget, testTarget, type Target } from "./lib/target";

const ROWS: { title: string; target: Target; uses: string }[] = [
  {
    title: "① CLIのリンク",
    target: linkedTarget(),
    uses: "db:push / config:push / backup / ledger / restore / restore:ledger / restore:verify / export:check",
  },
  {
    title: "② 開発中のアプリ",
    target: appTarget(),
    uses: "npm run dev（手元で開くアプリ）",
  },
  {
    title: "③ テストと開発用スクリプト",
    target: testTarget(),
    uses: "npm test / reset:test / seed / dev:otp / invite",
  },
];

function mark(kind: string): string {
  if (kind === "prod") return "◆ 本番";
  if (kind === "dev") return "○ 開発";
  return "× 不明";
}

console.log("");
console.log("  いま向いているSupabase");
console.log("  ════════════════════════════════════════════════════════");

for (const row of ROWS) {
  console.log("");
  console.log(`  ${row.title}　${mark(row.target.kind)}　${row.target.label}`);
  console.log(`      （${row.target.source}）`);
  console.log(`      使う命令：${row.uses}`);
}

console.log("");
console.log("  ════════════════════════════════════════════════════════");

const kinds = ROWS.map((r) => r.target.kind);
const hasProd = kinds.includes("prod");
const hasUnknown = kinds.includes("unknown");
const mixed = new Set(kinds).size > 1;

if (hasUnknown) {
  console.log("  × 向き先が分からないものがあります。");
  console.log("     破壊的な命令（reset:test / seed / restore など）は止まります。");
} else if (!hasProd) {
  console.log("  ○ すべて開発用です。ふだんの作業はこの状態で行ってください。");
} else if (mixed) {
  console.log("  ◆ 本番と開発が混ざっています。**取り違えに注意してください。**");
  console.log("");
  console.log("     ・backup / ledger は ① の向き先（本番の控えを取るなら、これでよい）");
  console.log("     ・reset:test / seed は ③ の向き先（開発用のままなら安全）");
  console.log("     ・破壊的な命令は、本番を向いていれば自動で止まります");
} else {
  console.log("  ◆ すべて本番を向いています。**作業内容をよく確かめてください。**");
}

console.log("");
console.log("  本番作業が終わったら、CLIのリンクは開発用へ戻すことをおすすめします。");
console.log("");
