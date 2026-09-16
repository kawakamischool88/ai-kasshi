/**
 * ログイン状態を保つ Cookie の設定。
 *
 * @supabase/ssr の既定は最大400日。長すぎるため90日に縮める（Phase 2 方針）。
 * ただし「縮める」だけで、短い Cookie を伸ばすことはしない。
 * 一時的にしか使わない Cookie（ログインの途中で使うもの）まで
 * 90日持たせてしまわないようにするため。
 *
 * 使うたびに Cookie は書き直されるので、90日以上あいだが空いたときだけ
 * ログインし直しになる。
 */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90日

type WithMaxAge = { maxAge?: number };

export function cookieOptions<T extends WithMaxAge>(options: T) {
  const maxAge =
    options?.maxAge != null && options.maxAge > SESSION_MAX_AGE_SECONDS
      ? SESSION_MAX_AGE_SECONDS
      : options?.maxAge;

  return {
    ...options,
    maxAge,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}
