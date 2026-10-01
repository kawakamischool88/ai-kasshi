/**
 * Claude Code の「実行前の見張り」（PreToolUse フック）（Phase E ／ E3）。
 *
 * Claude Code（開発用のAIツール）が命令を実行する前に、その命令の文字を見て、
 * 本番のデータを読む・書く・消すおそれのある命令を止める。
 *
 *   いつでも止める（AIには実行させない）：
 *     完全削除・利用停止・本番復旧の当て直し・詳しいエラーの表示・CLI のつなぎ先の変更・Vercel の環境変数の取り出し
 *   CLI が本番を向いているときに止める：
 *     DB を読む・書く命令（backup・ledger・restore・db push・admin・invite・cleanup・scripts の直接実行 など）
 *   本番のプロジェクト番号を名指しした DB の命令も止める
 *   CLI が本番を向いているときの読み取りだけの点検（maintenance:check）は、運営者に確かめる
 *
 * 【これで防げないもの】
 * 命令の文字を見て判断するので、わざと書き換えた命令は通り抜けうる。
 * AGENTS.md の「本番データの扱い」の決まりと一緒に守る。
 *
 * 止めるとき：終了の番号 2 と、理由（標準エラー）。確かめるとき：JSON で "ask"。
 * このファイル自体が壊れても、Claude Code は命令を止めずに進む（フックの失敗は止める扱いにならない）ため、
 * テスト（tests/prod-guard.test.ts）で動きを確かめている。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** ai-kasshi の作業フォルダ（このファイルは ai-kasshi/.claude/hooks/ にある） */
const ROOT = path.resolve(HERE, "..", "..");

/** いつでも止める命令 */
const ALWAYS_DENY = [
  [/account:delete|account-delete\.ts\b/, "完全削除（account:delete）は、運営者が自分の端末で実行します"],
  [/account:suspend|account-suspend\.ts\b/, "利用の停止・再開（account:suspend）は、運営者が自分の端末で実行します"],
  [/account:verify-deleted|account-verify-deleted\.ts\b/, "完全削除の確かめは、運営者が自分の端末で実行します"],
  [/recover:ledger|recover-ledger\.ts\b/, "本番復旧の当て直し（recover:ledger）は、運営者が自分の端末で実行します"],
  [/AI_KASSHI_SHOW_SQL_ERROR/, "詳しいエラーの表示（AI_KASSHI_SHOW_SQL_ERROR）は、開発用のAIツールには使わせません"],
  [/\bsupabase\s+link\b/, "CLI のつなぎ先の変更（supabase link）は、運営者が自分で行います"],
  [/\bvercel\s+env\s+pull\b/, "Vercel の環境変数の取り出し（vercel env pull）はしません"],
];

/** CLI が本番を向いているときに止める命令（DB を読む・書く） */
const PROD_DENY = [
  /\bsupabase\s+(db|migration|config|backups|inspect|storage|functions|secrets)\b/,
  /\bnpm\b[^|;&]*\brun\b[^|;&]*\b(backup|backup:cleanup|ledger|restore|restore:ledger|restore:verify|export:check|db:push|config:push|admin|invite|seed|reset:test|dev:otp)\b/,
  /\b(npx\s+)?tsx\s+[^|;&]*scripts[\\/]/,
  /\bnode\s+[^|;&]*scripts[\\/]/,
];

/** CLI が本番を向いているときに、運営者に確かめる命令（読み取りだけの点検） */
const PROD_ASK = [/\bnpm\b[^|;&]*\brun\b[^|;&]*\bmaintenance:check\b/];

/** 本番のプロジェクト番号（scripts/lib/target.ts から読む。ここには書かない） */
function prodRef() {
  try {
    const t = readFileSync(path.join(ROOT, "scripts", "lib", "target.ts"), "utf8");
    const m = t.match(/ref:\s*"([a-z0-9]{20})",\s*name:\s*"ai-kasshi-prod"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** CLI（supabase link）が本番を向いているか */
function linkedIsProd(ref) {
  if (process.env.AI_KASSHI_HOOK_ASSUME_PROD === "1") return true; // テスト用
  const f = path.join(ROOT, "supabase", ".temp", "project-ref");
  if (!ref || !existsSync(f)) return false;
  return readFileSync(f, "utf8").trim() === ref;
}

/**
 * 命令を見て、どうするか決める。
 * @returns {{ decision: "allow" | "deny" | "ask", reason?: string }}
 */
export function decide(command, opts = {}) {
  const cmd = String(command ?? "");
  for (const [re, reason] of ALWAYS_DENY) {
    if (re.test(cmd)) return { decision: "deny", reason };
  }
  const ref = opts.prodRef !== undefined ? opts.prodRef : prodRef();
  if (ref && cmd.includes(ref) && /\bsupabase\b|\bpsql\b|\bnpm\b|\bnpx\b|\btsx\b/.test(cmd)) {
    return { decision: "deny", reason: "本番のプロジェクトを名指しした DB の命令は、開発用のAIツールには実行させません" };
  }
  const prod = opts.prodLinked !== undefined ? opts.prodLinked : linkedIsProd(ref);
  if (prod) {
    for (const re of PROD_DENY) {
      if (re.test(cmd)) {
        return { decision: "deny", reason: "CLI が本番を向いています。DB を読む・書く命令は、運営者が自分の端末で実行します（npm run where で確かめる）" };
      }
    }
    for (const re of PROD_ASK) {
      if (re.test(cmd)) return { decision: "ask", reason: "CLI が本番を向いています。読み取りだけの点検ですが、実行してよいか運営者が確かめてください" };
    }
  }
  return { decision: "allow" };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// 直接実行されたとき（Claude Code から呼ばれたとき）だけ動く
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const raw = await readStdin();
  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    process.exit(0); // 読めないときは Claude Code のふだんの確認に任せる
  }
  const { decision, reason } = decide(input?.tool_input?.command);
  if (decision === "deny") {
    process.stderr.write(`【AIカッシーの本番データの守り】止めました：${reason}\n`);
    process.exit(2);
  }
  if (decision === "ask") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason },
      }),
    );
  }
  process.exit(0);
}
