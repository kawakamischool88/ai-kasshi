import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { BUDGET } from "@/config/ai";
import { judgeBudget } from "@/lib/ai/budget";
import { isAdmin } from "@/lib/auth/admin";
import { formatCost } from "@/lib/ai/cost";
import { dateKeyJst, formatDateJst, monthStartJst } from "@/lib/time";
import { Header } from "@/app/Header";

/**
 * AIの利用状況と推定原価。**運営（管理者）だけが見る画面**。
 *
 * 【守り方】
 *   ① 未ログイン       … ログイン画面へ
 *   ② 管理者ではない人 … 404（「ここに何かある」ことも見せない）
 *   ③ データそのもの   … DB側の RLS で、管理者以外は他人の記録を引けない
 *
 * ②だけだと画面を消しただけになる。③があるので、
 * この画面を通らずに直接データを取りに行っても原価は出てこない。
 */
export default async function CostPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  /* 管理者でなければ、この画面は「無い」ことにする。
     ログイン画面へ送ったり「権限がありません」と出したりすると、
     そこに運営用の画面があること自体を教えてしまう。 */
  if (!(await isAdmin(supabase))) notFound();

  const since = monthStartJst();
  /* 管理者なので、RLS により**全員ぶん**が返る。
     原価は運営全体で見るものなので、ここは本人のぶんに絞らない。 */
  const { data: rows } = await supabase
    .from("ai_usage")
    .select(
      "created_at, model, status, error_code, operation_type, input_tokens, output_tokens, thinking_tokens, estimated_cost, duration_ms, pricing_version",
    )
    .gte("created_at", since.toISOString())
    .order("created_at", { ascending: false });

  const all = rows ?? [];
  const success = all.filter((r) => r.status === "success");
  const failed = all.filter((r) => r.status === "error");
  const blocked = all.filter((r) => r.status === "blocked");

  /* しきい値の判定は、いま引いた行（＝全員ぶん）の合計で行う。
     getBudgetStatus は「本人のぶん」を見る関数なので、ここでは使わない。 */
  const spentUsd = success.reduce((sum, r) => sum + Number(r.estimated_cost ?? 0), 0);
  const budget = {
    spentUsd,
    warningUsd: BUDGET.monthlyWarningUsd,
    stopUsd: BUDGET.monthlyStopUsd,
    state: judgeBudget(spentUsd, BUDGET.monthlyWarningUsd, BUDGET.monthlyStopUsd),
  };

  const inputTokens = success.reduce((s, r) => s + Number(r.input_tokens ?? 0), 0);
  const outputTokens = success.reduce((s, r) => s + Number(r.output_tokens ?? 0), 0);
  const thinkingTokens = success.reduce((s, r) => s + Number(r.thinking_tokens ?? 0), 0);
  const avgMs =
    success.length > 0
      ? Math.round(success.reduce((s, r) => s + Number(r.duration_ms ?? 0), 0) / success.length)
      : 0;
  const perCall = success.length > 0 ? budget.spentUsd / success.length : 0;

  // 日ごと（日本時間）
  const byDay = new Map<string, { count: number; usd: number }>();
  for (const r of success) {
    const key = dateKeyJst(new Date(r.created_at as string));
    const cur = byDay.get(key) ?? { count: 0, usd: 0 };
    byDay.set(key, { count: cur.count + 1, usd: cur.usd + Number(r.estimated_cost ?? 0) });
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));

  /* 何のための呼び出しかごとの内訳（Phase 3C）。
     会話・記憶の検索・記憶候補の抽出・記憶の操作の対象探しで、
     それぞれどれだけかかっているかを見るため。 */
  const byOperation = new Map<string, { count: number; usd: number }>();
  for (const r of success) {
    const key = (r.operation_type as string) ?? "不明";
    const cur = byOperation.get(key) ?? { count: 0, usd: 0 };
    byOperation.set(key, { count: cur.count + 1, usd: cur.usd + Number(r.estimated_cost ?? 0) });
  }
  const operations = [...byOperation.entries()].sort((a, b) => b[1].usd - a[1].usd);

  const stateLabel =
    budget.state === "stopped" ? "停止中" : budget.state === "warning" ? "警告" : "通常";

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-8">
      <Header backHref="/" />

      <h2 className="mt-8 text-xl font-bold">利用状況（運営用）</h2>
      <p className="m-0 mt-1 text-sm text-neutral-600">
        {formatDateJst(since)} 以降（日本時間の今月）／金額は推定です
        <br />
        利用者全員ぶんの合計です。会話の中身はここには出ません。
      </p>

      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4">
        <Item label="今月の推定原価" value={formatCost(budget.spentUsd)} />
        <Item label="状態" value={stateLabel} />
        <Item label="警告値" value={formatCost(budget.warningUsd)} />
        <Item label="停止値" value={formatCost(budget.stopUsd)} />
        <Item label="成功した呼び出し" value={`${success.length} 回`} />
        <Item label="1回あたり" value={success.length ? formatCost(perCall) : "—"} />
        <Item label="失敗" value={`${failed.length} 回`} />
        <Item label="停止で見送り" value={`${blocked.length} 回`} />
        <Item label="入力トークン" value={inputTokens.toLocaleString("ja-JP")} />
        <Item label="出力トークン" value={outputTokens.toLocaleString("ja-JP")} />
        <Item label="うち思考ぶん" value={thinkingTokens.toLocaleString("ja-JP")} />
        <Item label="平均の待ち時間" value={avgMs ? `${(avgMs / 1000).toFixed(1)} 秒` : "—"} />
      </dl>

      <h3 className="mt-10 text-lg font-bold">何のための呼び出しか</h3>
      {operations.length === 0 ? (
        <p className="mt-3 text-neutral-600">まだ記録がありません。</p>
      ) : (
        <table className="mt-3 w-full border-collapse text-base">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="py-2">種類</th>
              <th className="py-2">回数</th>
              <th className="py-2">推定原価</th>
              <th className="py-2">1回あたり</th>
            </tr>
          </thead>
          <tbody>
            {operations.map(([op, v]) => (
              <tr key={op} className="border-b border-line">
                <td className="py-2">{OPERATION_LABEL[op] ?? op}</td>
                <td className="py-2">{v.count}</td>
                <td className="py-2">{formatCost(v.usd)}</td>
                <td className="py-2">{formatCost(v.usd / v.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="mt-10 text-lg font-bold">日ごと</h3>
      {days.length === 0 ? (
        <p className="mt-3 text-neutral-600">まだ記録がありません。</p>
      ) : (
        <table className="mt-3 w-full border-collapse text-base">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="py-2">日付</th>
              <th className="py-2">回数</th>
              <th className="py-2">推定原価</th>
            </tr>
          </thead>
          <tbody>
            {days.map(([day, v]) => (
              <tr key={day} className="border-b border-line">
                <td className="py-2">{day}</td>
                <td className="py-2">{v.count}</td>
                <td className="py-2">{formatCost(v.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {failed.length > 0 && (
        <>
          <h3 className="mt-10 text-lg font-bold">失敗の内訳</h3>
          <ul className="m-0 mt-3 list-none p-0 text-base">
            {[...new Set(failed.map((r) => r.error_code ?? "不明"))].map((code) => (
              <li key={code} className="border-b border-line py-2">
                {code}：{failed.filter((r) => (r.error_code ?? "不明") === code).length} 回
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="mt-10 text-sm text-neutral-600">
        モデル：{[...new Set(all.map((r) => r.model))].join("、") || "—"}
        <br />
        単価の版：{[...new Set(all.map((r) => r.pricing_version))].join("、") || "—"}
      </p>
    </main>
  );
}

/** 呼び出しの種類の言い換え */
const OPERATION_LABEL: Record<string, string> = {
  chat: "会話の返事",
  memory_search: "記憶の検索",
  memory_extract: "記憶候補の取り出し",
  memory_revise: "訂正・削除の対象探し",
};

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm text-neutral-600">{label}</dt>
      <dd className="m-0 text-lg font-bold">{value}</dd>
    </div>
  );
}
