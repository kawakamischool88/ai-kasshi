/**
 * 運営バックアップの30日の片付けと、完全削除の台帳の38日（Phase D ／ D2・D5）のテスト。
 * DB には触れない。一時フォルダに、架空の控えのフォルダを作って確かめる。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planCleanup, splitAccountLedger } from "../scripts/lib/cleanup";

const CANARY = "CANARY-本文-cleanup";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

let root: string;

/** npm run backup が作る名前の形で、架空の控えを作る */
function makeBackup(daysAgo: number, kind: "dev" | "prod" | null, opts: { manifest?: "ok" | "none" | "broken" } = {}) {
  const t = new Date(NOW - daysAgo * DAY);
  const name = t.toISOString().replace(/[:.]/g, "-");
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  // 表のファイルには本文（目印）を入れておく。片付けはこれを開いてはいけない
  writeFileSync(path.join(dir, "messages.jsonl"), JSON.stringify({ content: CANARY }) + "\n");
  const m = opts.manifest ?? "ok";
  if (m === "ok") {
    writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ createdAt: t.toISOString(), totalRows: 12, ...(kind ? { target: { kind, name: `ai-kasshi-${kind}` } } : {}) }),
    );
  } else if (m === "broken") {
    writeFileSync(path.join(dir, "manifest.json"), "{壊れた");
  }
  return name;
}

function ledgerFiles() {
  const dev = path.join(root, "ledger", "dev");
  mkdirSync(dev, { recursive: true });
  writeFileSync(path.join(dev, "deletions.jsonl"), JSON.stringify({ memory_id: "x" }) + "\n");
  return dev;
}

function run(args: string[] = []) {
  const r = spawnSync(`npx tsx scripts/backup-cleanup.ts ${args.join(" ")}`, {
    shell: true,
    encoding: "utf8",
    env: { ...process.env, AI_KASSHI_BACKUP_DIR: root },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "kasshi-cleanup-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("判定（何も消さない）", () => {
  it("31日前だけが消す候補。29日前は残す。名前・目録・向き先がおかしいものは手で確認", () => {
    const old = makeBackup(31, "dev");
    const recent = makeBackup(29, "dev");
    const noManifest = makeBackup(40, "dev", { manifest: "none" });
    const broken = makeBackup(40, "dev", { manifest: "broken" });
    const legacy = makeBackup(40, null); // 向き先の無い古い形式
    mkdirSync(path.join(root, "my-folder"));
    ledgerFiles();

    const plan = planCleanup(root, new Date(NOW), 30);
    const by = Object.fromEntries(plan.entries.map((e) => [e.name, e]));
    expect(by[old].decision).toBe("delete");
    expect(by[recent].decision).toBe("keep");
    expect(by[noManifest].decision).toBe("manual");
    expect(by[broken].decision).toBe("manual");
    expect(by[legacy].decision).toBe("manual");
    expect(by[legacy].reason).toContain("向き先が分からない");
    expect(by["my-folder"].decision).toBe("manual");
    expect(by["ledger"]).toBeUndefined(); // 台帳は一覧にも出さない
  });

  it("リンク（junction）はたどらない。中にリンクがあるフォルダも自動で消さない", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "kasshi-outside-"));
    try {
      writeFileSync(path.join(outside, "keep.txt"), "消えてはいけない");
      const linkName = new Date(NOW - 50 * DAY).toISOString().replace(/[:.]/g, "-");
      symlinkSync(outside, path.join(root, linkName), "junction");
      const withLink = makeBackup(45, "dev");
      symlinkSync(outside, path.join(root, withLink, "inner"), "junction");

      const plan = planCleanup(root, new Date(NOW), 30);
      const by = Object.fromEntries(plan.entries.map((e) => [e.name, e]));
      expect(by[linkName].decision).toBe("manual");
      expect(by[withLink].decision).toBe("manual");

      const r = run(["--yes"]);
      expect(r.code).toBe(0);
      expect(existsSync(path.join(outside, "keep.txt"))).toBe(true);
      expect(existsSync(path.join(root, withLink))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("本番の消す候補があるのに、30日以内の本番の控えが無い → 止める印が立つ", () => {
    makeBackup(35, "prod");
    makeBackup(10, "dev");
    const plan = planCleanup(root, new Date(NOW), 30);
    expect(plan.prodBlocked).toBe(true);
    expect(plan.recentProd).toBe(0);
  });
});

describe("コマンド（npm run backup:cleanup）", () => {
  it("既定は表示だけ：何も消さない。表示に本文が出ない", () => {
    const old = makeBackup(31, "dev");
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("消す候補");
    expect(r.out).toContain(old);
    expect(r.out).toContain("表示だけで終わりました");
    expect(existsSync(path.join(root, old))).toBe(true);
    expect(r.out).not.toContain("CANARY");
  });

  it("--yes：31日前の開発用だけ消える。29日前・台帳・手で確認のものは残る", () => {
    const old = makeBackup(31, "dev");
    const recent = makeBackup(29, "dev");
    const legacy = makeBackup(40, null);
    const dev = ledgerFiles();
    const r = run(["--yes"]);
    expect(r.code).toBe(0);
    expect(existsSync(path.join(root, old))).toBe(false);
    expect(existsSync(path.join(root, recent))).toBe(true);
    expect(existsSync(path.join(root, legacy))).toBe(true);
    expect(readFileSync(path.join(dev, "deletions.jsonl"), "utf8")).toContain('"x"');
    expect(r.out).not.toContain("CANARY");
  });

  it("本番の候補があるのに --prod なし → 止まり、何も消さない", () => {
    const oldProd = makeBackup(31, "prod");
    makeBackup(5, "prod"); // 30日以内の本番もある
    const oldDev = makeBackup(32, "dev");
    const r = run(["--yes"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("--prod");
    expect(existsSync(path.join(root, oldProd))).toBe(true);
    expect(existsSync(path.join(root, oldDev))).toBe(true);
  });

  it("--yes --prod：30日以内の本番があれば、古い本番も消える", () => {
    const oldProd = makeBackup(31, "prod");
    const recentProd = makeBackup(5, "prod");
    const r = run(["--yes", "--prod"]);
    expect(r.code).toBe(0);
    expect(existsSync(path.join(root, oldProd))).toBe(false);
    expect(existsSync(path.join(root, recentProd))).toBe(true);
  });

  it("30日以内の本番の控えが無い → --yes --prod でも止まり、本番の古い控えを消さない", () => {
    const oldProd = makeBackup(31, "prod");
    const oldProd2 = makeBackup(40, "prod");
    const r = run(["--yes", "--prod"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("30日以内の本番の控えが1つもありません");
    expect(existsSync(path.join(root, oldProd))).toBe(true);
    expect(existsSync(path.join(root, oldProd2))).toBe(true);
  });
});

describe("完全削除の台帳（38日）", () => {
  it("38日を過ぎた行だけ分ける。日時が読めない行は残す", () => {
    const rows = [
      { user_id: "a", deleted_at: new Date(NOW - 39 * DAY).toISOString() },
      { user_id: "b", deleted_at: new Date(NOW - 37 * DAY).toISOString() },
      { user_id: "c", deleted_at: "読めない" },
    ];
    const { keep, expired } = splitAccountLedger(rows, new Date(NOW), 38);
    expect(expired.map((r) => r.user_id)).toEqual(["a"]);
    expect(keep.map((r) => r.user_id)).toEqual(["b", "c"]);
  });

  it("コマンド：表示だけでは消さず、--yes で38日を過ぎた行だけ消す。ほかの台帳は触らない", () => {
    const dev = ledgerFiles();
    const file = path.join(dev, "account-deletions.jsonl");
    writeFileSync(
      file,
      [
        { user_id: "11111111-0000-4000-8000-000000000001", deleted_at: new Date(NOW - 39 * DAY).toISOString() },
        { user_id: "11111111-0000-4000-8000-000000000002", deleted_at: new Date(NOW - 37 * DAY).toISOString() },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    const dry = run();
    expect(dry.out).toContain("38日を過ぎた行 1 行");
    expect(readFileSync(file, "utf8")).toContain("000000000001");

    const r = run(["--yes"]);
    expect(r.code).toBe(0);
    const left = readFileSync(file, "utf8");
    expect(left).not.toContain("000000000001");
    expect(left).toContain("000000000002");
    expect(readFileSync(path.join(dev, "deletions.jsonl"), "utf8")).toContain('"x"');
  });
});
