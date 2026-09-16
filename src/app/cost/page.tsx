import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getBudgetStatus } from "@/lib/ai/budget";
import { formatCost } from "@/lib/ai/cost";
import { dateKeyJst, monthStartJst } from "@/lib/time";
import { Header } from "@/app/Header";

/**
 * 開発確認用の利用状況。
 * 柏村さんが使い始める前に、見えないようにするか管理者だけに限ること。
 */
export default async function CostPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const since = monthStartJst();
  const [{ data: rows }, budget] = await Promise.all([
    supabase
      .from("ai_usage")
      .select(
        "created_at, model, status, error_code, input_tokens, output_tokens, thinking_tokens, estimated_cost, duration_ms, pricing_version",
      )
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false }),
    getBudgetStatus(supabase),
  ]);

  const all = rows ?? [];
  const success = all.filter((r) => r.status === "success");
  const failed = all.filter((r) => r.status === "error");
  const blocked = all.filter((r) => r.status === "blocked");

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

  const stateLabel =
    budget.state === "stopped" ? "停止中" : budget.state === "warning" ? "警告" : "通常";

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-8">
      <Header backHref="/" />

      <h2 className="mt-8 text-xl font-bold">利用状況（開発確認用）</h2>
      <p className="m-0 mt-1 text-sm text-neutral-600">
        {since.toLocaleDateString("ja-JP")} 以降（日本時間の今月）／金額は推定です
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

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm text-neutral-600">{label}</dt>
      <dd className="m-0 text-lg font-bold">{value}</dd>
    </div>
  );
}
