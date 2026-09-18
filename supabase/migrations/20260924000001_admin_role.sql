-- =============================================================
-- 0015: 運営（管理者）と通常利用者を分ける
--
-- 【なぜ要るのか】
-- AIの利用料・原価は「運営の情報」であって、柏村さんに見せるものではない。
-- いまは `/cost` を誰でも開けるので、ここを管理者だけに限る。
--
-- 【考え方】
--   * 権限は **DBの列**（profiles.role）で持つ。
--     「このメールアドレスなら管理者」と画面側で判定する作り方はしない。
--     判定が画面の中にあると、画面を通らない経路（API直叩き）が素通りになる。
--   * 新しい表は作らない。すでにある profiles に列を1つ足すだけ。
--   * **本人からは role を変えられない**。二重に止める（下の①②）。
--   * 管理者が見えるようになるのは **ai_usage（原価の記録）だけ**。
--     会話・発言・記憶には管理者用のポリシーを作らない。
--     ＝ 管理者でもアプリ画面から柏村さんの会話は読めない。
-- =============================================================

-- ---------- 権限の列 ----------
alter table public.profiles
  add column role text not null default 'user'
    check (role in ('user', 'admin'));

comment on column public.profiles.role is
  '権限。user＝通常利用者／admin＝運営。本人からは変更できない（列権限＋トリガーで二重に止めている）。付与は npm run admin から行う。';

-- 管理者を探すのは「たまに」なので、admin の行だけに索引を張る
create index profiles_admin_idx on public.profiles (id) where role = 'admin';

-- =============================================================
-- ① 列の権限：authenticated には role を書かせない
--
-- これまでは表ごと update を許していた。そのままだと
-- 「自分の行を update できる」＝「自分を admin にできる」になってしまう。
-- そこで表ごとの権限をいったん外し、**書いてよい列だけ**を挙げ直す。
--
-- select は表ごとのままでよい（自分の role を読めても害はない）。
-- RLS（自分の行だけ）は今までどおり効く。権限と RLS は別の仕組みで、両方通る必要がある。
-- =============================================================
revoke insert, update on table public.profiles from authenticated;
grant insert (id, display_name, memo) on table public.profiles to authenticated;
grant update (display_name, memo) on table public.profiles to authenticated;

-- =============================================================
-- ② 念のための二重の守り：role が動く書き込みを DB 側で拒む
--
-- ①（列の権限）だけでも防げるが、将来うっかり
-- `grant update on profiles to authenticated` と書き戻したときに
-- 静かに穴が開く。そうならないよう、もう一段止める。
--
-- 止めるのは PostgREST 経由（authenticated / anon）だけ。
-- 付与するときは Supabase CLI ＝ postgres として入るので、ここは通る。
-- テストは service_role を使うので、こちらも通る（tests/ と scripts/ だけ）。
-- =============================================================
create function public.profiles_guard_role()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' and new.role <> 'user' then
      raise exception '役割（role）は、この経路からは設定できません';
    end if;
    if tg_op = 'UPDATE' and new.role is distinct from old.role then
      raise exception '役割（role）は、この経路からは変更できません';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_guard_role
  before insert or update on public.profiles
  for each row execute function public.profiles_guard_role();

-- =============================================================
-- 管理者かどうかを答える関数
--
-- 誰について答えるかは **auth.uid()（ログイン情報）だけ**で決まる。
-- 呼ぶ側が user_id を渡す作りにはしない＝なりすましようがない。
--
-- security definer なのは、RLS の条件の中から profiles を読むため
-- （invoker のままだと、ポリシーの中でポリシーを見に行く形になって分かりにくい）。
-- 返すのは true / false だけなので、これで他人の情報が漏れることはない。
-- =============================================================
create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

comment on function public.is_admin() is
  'ログイン中の本人が管理者かどうか。引数は取らない（auth.uid() だけで決まる）。';

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- =============================================================
-- ai_usage：管理者だけ、全員ぶんの原価を読める
--
-- 既存の ai_usage_select_own（自分のぶんだけ）はそのまま残す。
-- 同じ種類のポリシーは「どちらかに当てはまれば通る」なので、
--   通常利用者 … 自分のぶんだけ
--   管理者　　 … 全員ぶん
-- になる。
--
-- **足すのは select だけ。** insert / update / delete は増やさない。
-- 原価の記録は誰であっても後から書き換えない（請求との突き合わせを守るため）。
-- =============================================================
create policy "ai_usage_select_admin" on public.ai_usage
  for select to authenticated
  using (public.is_admin());

-- 管理者の照会は「今月ぶんを新しい順に」なので、その形に合わせる
create index ai_usage_created_at_idx on public.ai_usage (created_at desc);
