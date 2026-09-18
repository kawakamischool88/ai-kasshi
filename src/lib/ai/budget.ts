import type { SupabaseClient } from "@supabase/supabase-js";
import { BUDGET } from "@/config/ai";
import { monthStartJst } from "@/lib/time";

/**
 * 原価の安全装置（二段階）。
 *
 *   ok      … ふつう
 *   warning … 警告値を超えた。川上さんが気づけるよう画面に出す
 *   stopped … 停止値に達した。新しい有料AI処理を行わない
 *
 * 停止中でも、ログイン・過去の会話を読む・ログアウトは、これまで通りできる
 * （お金のかからない処理は止めない）。
 */
export type BudgetState = "ok" | "warning" | "stopped";

export type BudgetStatus = {
  state: BudgetState;
  /** 今月（日本時間）の推定原価の合計・USD */
  spentUsd: number;
  warningUsd: number;
  stopUsd: number;
};

/** しきい値の判定だけを取り出した関数（金額から状態を決める。テストしやすいよう分離） */
export function judgeBudget(spentUsd: number, warningUsd: number, stopUsd: number): BudgetState {
  if (spentUsd >= stopUsd) return "stopped";
  if (spentUsd >= warningUsd) return "warning";
  return "ok";
}

/**
 * 今月の推定原価を合計して状態を返す。
 *
 * 【user_id を必ず渡す理由】
 * 管理者は RLS で全員ぶんの ai_usage を読めるようになった。
 * そのままだと、管理者のときだけ「全員の合計」で止まる判定に変わってしまう。
 * 誰であっても同じ動きにするため、ここでは**本人のぶんに絞る**。
 *
 * 渡す userId は、呼ぶ側が supabase.auth.getUser() で得たものだけ。
 * 画面から送られてきた値を渡してはいけない。
 *
 * 1か月ぶんの件数は多くないので、取り出して足し合わせる。
 */
export async function getBudgetStatus(
  supabase: SupabaseClient,
  userId: string,
): Promise<BudgetStatus> {
  const since = monthStartJst().toISOString();

  const { data, error } = await supabase
    .from("ai_usage")
    .select("estimated_cost")
    .eq("user_id", userId)
    .gte("created_at", since);

  if (error) {
    // 合計できないときは、安全側に倒して「停止」にはせず、警告として扱う。
    // （読み取り失敗でAIが使えなくなるのは、利用者にとって不便が大きすぎるため）
    console.error("[budget] 集計に失敗:", error);
    return {
      state: "warning",
      spentUsd: 0,
      warningUsd: BUDGET.monthlyWarningUsd,
      stopUsd: BUDGET.monthlyStopUsd,
    };
  }

  const spentUsd =
    Math.round((data ?? []).reduce((sum, row) => sum + Number(row.estimated_cost ?? 0), 0) * 1_000_000) /
    1_000_000;

  return {
    state: judgeBudget(spentUsd, BUDGET.monthlyWarningUsd, BUDGET.monthlyStopUsd),
    spentUsd,
    warningUsd: BUDGET.monthlyWarningUsd,
    stopUsd: BUDGET.monthlyStopUsd,
  };
}
