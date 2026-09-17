/**
 * バックアップ・復元まわりのテスト（Phase 4A）。
 *
 * 確かめたいこと。
 *   ・控える表の一覧に、抜けがないこと（増やしたのに足し忘れる事故を防ぐ）
 *   ・削除台帳に本文が入らないこと
 *   ・「残さない」「期限切れ」の候補の本文が、ちゃんと消えること
 *   ・復元した直後は、誰も使えず、有料の処理も走らないこと
 */
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  BACKUP_TABLES,
  LEDGERS,
  FORBIDDEN_IN_BACKUP,
  NOT_BACKED_UP,
  RESTORE_SCHEMA,
} from "@/config/backup";

loadEnv({ path: ".env.test.local", override: true });

const url = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const PERMISSION_DENIED = "42501";

let a: SupabaseClient;
let idA: string;
let conv: string;

beforeAll(async () => {
  const pa = process.env.TEST_USER_A_PASSWORD;
  if (!url || !anonKey || !pa) throw new Error(".env.test.local の設定が足りません");

  a = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await a.auth.signInWithPassword({
    email: "kasshi-test-a@example.com",
    password: pa,
  });
  if (error) throw error;
  idA = data.user!.id;

  const { data: c } = await a
    .from("conversations")
    .insert({ user_id: idA, title: "バックアップのテスト" })
    .select("id")
    .single();
  conv = c!.id as string;
});

afterAll(async () => {
  if (conv) await a.from("conversations").delete().eq("id", conv);
});

async function newCandidate(text: string, expiresAt?: string): Promise<string> {
  const { data: msg } = await a
    .from("messages")
    .insert({ conversation_id: conv, user_id: idA, role: "user", content: `出典：${text}` })
    .select("id")
    .single();
  const { data, error } = await a
    .from("memory_candidates")
    .insert({
      user_id: idA,
      conversation_id: conv,
      source_message_id: msg!.id,
      candidate_index: 1,
      suggested_text: text,
      extraction_reason: `テスト用の理由：${text}`,
      origin: "self_experience",
      status: "pending",
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    })
    .select("id")
    .single();
  if (error) throw new Error(`候補: ${error.message}`);
  return data.id as string;
}

// =============================================================
// 控える表の一覧に、抜けがないか
// =============================================================
describe("控える表の一覧", () => {
  it("いまDBにあるすべての表が、控える一覧に入っている", async () => {
    /* 表を増やしたのに一覧へ足し忘れると、復元したときにその表だけ空になる。
       気づきにくいので、テストで止める。 */
    const { data, error } = await a.rpc("backup_table_names");
    expect(error).toBeNull();

    const inDb: string[] = (data as { name: string }[]).map((r) => r.name);
    // 名前が取れていること自体も確かめる（黙って通り抜けないように）
    expect(inDb.length).toBeGreaterThan(0);
    expect(inDb).toContain("memory_candidates");

    for (const t of inDb) {
      expect(BACKUP_TABLES as readonly string[]).toContain(t);
    }
    // 逆に、一覧にあるのにDBに無い表もない
    for (const t of BACKUP_TABLES) {
      expect(inDb).toContain(t);
    }
  });

  it("控える順番は、親から子の順になっている", () => {
    const order = BACKUP_TABLES as readonly string[];
    expect(order.indexOf("conversations")).toBeLessThan(order.indexOf("messages"));
    expect(order.indexOf("messages")).toBeLessThan(order.indexOf("memory_candidates"));
    expect(order.indexOf("memory_candidates")).toBeLessThan(order.indexOf("memory_references"));
    expect(order.indexOf("memory_candidates")).toBeLessThan(
      order.indexOf("memory_revision_requests"),
    );
  });

  it("控えないものには、必ず理由が書いてある", () => {
    expect(NOT_BACKED_UP.length).toBeGreaterThan(0);
    for (const item of NOT_BACKED_UP) {
      expect(item.reason.length).toBeGreaterThan(10);
    }
  });

  it("鍵らしい文字を調べる決まりがある", () => {
    expect(FORBIDDEN_IN_BACKUP).toContain("sb_secret_");
    expect(FORBIDDEN_IN_BACKUP).toContain("sk-ant-");
    expect(FORBIDDEN_IN_BACKUP).toContain("ANTHROPIC_API_KEY");
  });
});

// =============================================================
// 削除台帳に、本文が入らないこと
// =============================================================
describe("削除台帳の中身", () => {
  it("台帳に入れる項目に、本文らしいものが1つもない", () => {
    for (const field of LEDGERS.deletions.fields) {
      expect(field).not.toMatch(/text|content|body|suggested|reason|title/i);
    }
  });

  it("台帳に入れるのは、削除を当て直すのに要る最小限だけ", () => {
    expect(LEDGERS.deletions.fields).toEqual([
      "memory_id",
      "user_id",
      "source_message_id",
      "conversation_id",
      "scope",
      "deleted_at",
    ]);
  });

  it("同じ削除を二重に持たないための鍵が決まっている", () => {
    expect(LEDGERS.deletions.key).toEqual(["user_id", "memory_id"]);
  });

  it("変更台帳には、訂正後の本文が入る（いま有効な内容なので）", () => {
    expect(LEDGERS.revisions.fields as readonly string[]).toContain("text");
  });

  it("削除の記録は、本人にもアプリにも書き換えられない", async () => {
    const { data: rows } = await a.from("memory_deletions").select("id, scope").limit(1);
    if (!rows || rows.length === 0) return; // 記録がなければこの確認は省略

    await a.from("memory_deletions").update({ scope: "conversation" }).eq("id", rows[0].id);
    await a.from("memory_deletions").delete().eq("id", rows[0].id);

    const { data: still } = await a
      .from("memory_deletions")
      .select("id, scope")
      .eq("id", rows[0].id);
    expect(still).toHaveLength(1);
    expect(still![0].scope).toBe(rows[0].scope);
  });
});

// =============================================================
// 「残さない」「期限切れ」の本文が消えること
// =============================================================
describe("確定しなかった候補の本文を残さない", () => {
  it("［残さない］を選ぶと、本文も理由も消える", async () => {
    const id = await newCandidate("残さないと言われる予定の内容");

    const { data: updated, error } = await a
      .from("memory_candidates")
      .update({
        status: "rejected",
        confirmed_at: new Date().toISOString(),
        suggested_text: null,
        confirmed_text: null,
        extraction_reason: null,
      })
      .eq("id", id)
      .eq("status", "pending")
      .select("status, suggested_text, confirmed_text, extraction_reason")
      .single();

    expect(error).toBeNull();
    expect(updated?.status).toBe("rejected");
    expect(updated?.suggested_text).toBeNull();
    expect(updated?.confirmed_text).toBeNull();
    expect(updated?.extraction_reason).toBeNull();
  });

  it("期限切れになると、本文も理由も消える", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const id = await newCandidate("期限切れになる予定の内容", past);

    await a
      .from("memory_candidates")
      .update({
        status: "expired",
        suggested_text: null,
        confirmed_text: null,
        extraction_reason: null,
      })
      .eq("status", "pending")
      .lte("expires_at", new Date().toISOString());

    const { data } = await a
      .from("memory_candidates")
      .select("status, suggested_text, extraction_reason")
      .eq("id", id)
      .single();

    expect(data?.status).toBe("expired");
    expect(data?.suggested_text).toBeNull();
    expect(data?.extraction_reason).toBeNull();
  });

  it("本文を持ったまま「残さない」にはできない（DBが受け付けない）", async () => {
    const id = await newCandidate("本文を残したまま却下しようとする内容");
    const { error } = await a
      .from("memory_candidates")
      .update({ status: "rejected" }) // 本文を消さずに状態だけ変える
      .eq("id", id);
    expect(error?.code).toBe("23514"); // 決まりに反する
  });

  it("本文を持ったまま「期限切れ」にはできない", async () => {
    const id = await newCandidate("本文を残したまま期限切れにしようとする内容");
    const { error } = await a
      .from("memory_candidates")
      .update({ status: "expired" })
      .eq("id", id);
    expect(error?.code).toBe("23514");
  });

  it("本人が確定した記憶の本文は、消されない", async () => {
    const id = await newCandidate("これは残すと決めた内容");
    const { data, error } = await a
      .from("memory_candidates")
      .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
      .eq("id", id)
      .select("suggested_text")
      .single();
    expect(error).toBeNull();
    expect(data?.suggested_text).toBe("これは残すと決めた内容");
  });

  it("古い記録にも、本文が残っていない", async () => {
    const { data } = await a
      .from("memory_candidates")
      .select("id")
      .in("status", ["rejected", "expired"])
      .not("suggested_text", "is", null);
    expect(data ?? []).toHaveLength(0);
  });
});

// =============================================================
// 復元した直後の止まった状態
// =============================================================
describe("復元した直後は、誰も使えない", () => {
  afterAll(() => {
    delete process.env.AI_KASSHI_MODE;
  });

  it("ふだんは、止まっていない", async () => {
    vi.resetModules();
    delete process.env.AI_KASSHI_MODE;
    const mod = await import("@/config/mode");
    expect(mod.isRestoreMode()).toBe(false);
    expect(mod.appMode()).toBe("normal");
  });

  it("復元モードにすると、止まった状態になる", async () => {
    vi.resetModules();
    process.env.AI_KASSHI_MODE = "restore";
    const mod = await import("@/config/mode");
    expect(mod.isRestoreMode()).toBe(true);
    expect(mod.appMode()).toBe("restore");
  });

  it("知らない値を入れても、勝手に止まらない（ふだんの環境を守るため）", async () => {
    vi.resetModules();
    process.env.AI_KASSHI_MODE = "maintenance";
    const mod = await import("@/config/mode");
    expect(mod.isRestoreMode()).toBe(false);
  });

  it("復元中に通ってよいのは、お知らせの画面だけ", async () => {
    vi.resetModules();
    const mod = await import("@/config/mode");
    expect(mod.RESTORE_ALLOWED_PATHS).toEqual(["/maintenance"]);
  });
});

// =============================================================
// 隔離した復元先
// =============================================================
describe("隔離した復元先", () => {
  it("戻す先は、いま動いている場所とは別の名前", () => {
    expect(RESTORE_SCHEMA).not.toBe("public");
  });

  it("戻す先は、アプリのAPIに公開されていない", async () => {
    /* 公開されていると、利用者が戻した古いデータを触れてしまう。
       アプリと同じつなぎ方で読もうとして、読めないことを確かめる。 */
    const { error } = await a.from("memory_candidates").select("id").limit(1);
    expect(error).toBeNull(); // 本番の場所は読める

    const restoreClient = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: RESTORE_SCHEMA },
    });
    const { error: restoreError } = await restoreClient.from("memory_candidates").select("id");
    // 公開していないので、そもそも届かない
    expect(restoreError).not.toBeNull();
    expect(restoreError?.code).not.toBe(PERMISSION_DENIED); // 権限以前に、道がない
  });
});
