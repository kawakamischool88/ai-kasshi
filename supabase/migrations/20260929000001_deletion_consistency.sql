-- =============================================================
-- 0016: 削除の考え方を1つにそろえる（Phase A ／ G1・G3・R1・N-1）
--
-- 【何を直すか】
-- G1  会話ごと消したとき、その会話から作った記憶を「別の会話で使った返事」が、
--     そのあともAIへ送られていた（記憶だけ消したときは送らない印が付く）。
-- G3  記憶を消しても、訂正・削除の提案に、AIが作った文章の案と理由が残っていた。
-- R1  会話ごと消したことが、どこにも記録されていなかった
--     （古いバックアップから戻すと、消した会話が戻ってしまう。台帳への反映は Phase C）。
-- N-1 会話をまたいで訂正・考えの変化をした記憶は、片方の会話を消すと、
--     版の片方だけが残っていた。系列ごと消すことにする。
--
-- 【あわせて直す不具合】
-- 別の会話で訂正した記憶がある会話を消そうとすると、
-- 版のつながり（revision_of）が外れるときに「置き換えの行には種類が付いていること」の
-- 決まりに引っかかり、**会話の削除そのものが失敗していた**（開発用 DB で再現）。
-- 削除済みの行だけは、つながりが外れても種類を残せるようにする。
--
-- 【考え方】
-- 会話ごと消す ＝ その会話から作った記憶を、1件ずつ「記憶だけ消す」と同じ手順で消し、
--                そのあとで会話を消す。
-- 手順が1つなので、どちらの消し方でも同じ約束が守られる。
--   ・つながっている版（訂正前・以前の考え・いまの版）をまとめて本文なしの削除にする
--   ・削除の記録を残す（本文なし）
--   ・元の発言・直後の返事・その記憶を使った返事（別の会話を含む）に「AIへ送らない印」
--   ・提案の文章の案と理由を消し、確認待ちなら閉じる
-- 別の会話そのもの・発言・返事の本文は消さない（本人は画面で読み返せる）。
--
-- 【削除の記録は、実際に行った操作と必ず一致させる】（C2）
-- 共通の手順と、削除の記録を書く処理は、画面の API に出さない場所（app_private）に置く。
-- 本人が「範囲」を自由に指定して呼んだり、削除の記録だけを書いたりはできない。
--   記憶だけ消す（delete_memory）         → 範囲は必ず「記憶だけ」
--   会話ごと消す（delete_conversation_…） → 範囲は必ず「会話ごと」
-- =============================================================

-- -------------------------------------------------------------
-- 1. 削除済みの行は、版のつながりが外れても種類を残せるようにする
-- -------------------------------------------------------------
alter table public.memory_candidates
  drop constraint memory_candidates_revision_pair_check;

alter table public.memory_candidates
  add constraint memory_candidates_revision_pair_check
  check (status = 'deleted' or (revision_of is null) = (revision_kind is null));

comment on constraint memory_candidates_revision_pair_check on public.memory_candidates is
  '置き換えの行には種類が付いていること。削除済みの行は、元の版が消えてつながりが外れても種類を残してよい。';

-- -------------------------------------------------------------
-- 2. 会話の削除の記録（R1）
--
-- 残すのは「誰の・どの会話を・いつ消したか」だけ。
-- 見出し・発言など、本文につながるものは持たない。
-- 会話そのものへの外部キーは張らない（消した会話を指すため）。
-- -------------------------------------------------------------
create table public.conversation_deletions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 消した会話の番号。外部キーは張らない（会話はもう無い）
  conversation_id uuid not null,
  deleted_at timestamptz not null default now()
);

comment on table public.conversation_deletions is
  '会話ごと消した記録。本文・見出しは持たない。古いバックアップから戻したときに、消した会話を消し直すため。';

create unique index conversation_deletions_uniq
  on public.conversation_deletions (user_id, conversation_id);

alter table public.conversation_deletions enable row level security;

create policy "conversation_deletions_select_own" on public.conversation_deletions
  for select to authenticated using (auth.uid() = user_id);

/* 本人は読めるだけ。書くのは「会話ごと消す」処理だけ（下の app_private の関数）。
   本人が記録だけを書けると、実際には消していない会話が
   「消した」ことになり、戻すときに消されてしまう。 */
-- insert / update / delete のポリシーは作らない
-- anon には何も与えない

grant select on table public.conversation_deletions to authenticated;
grant all on table public.conversation_deletions to service_role;

-- -------------------------------------------------------------
-- 2-2. 記憶の削除の記録も、本人が直接は書けないようにする（C2）
--
-- これまでは本人の分なら書けたため、実際に消していない記憶の記録や、
-- 範囲だけ違う記録を作れてしまった。書くのは削除の処理だけにする。
-- 読む権限（本人の分だけ）は変えない。
-- -------------------------------------------------------------
drop policy "memory_deletions_insert_own" on public.memory_deletions;
revoke insert on table public.memory_deletions from authenticated;

-- -------------------------------------------------------------
-- 2-3. 画面の API に出さない場所
--
-- Supabase の API が見せるのは public（と graphql_public）だけ。
-- supabase/config.toml の [api] schemas に app_private を足してはいけない。
-- 削除の処理が中から呼べるよう、ログイン中の本人に「使う」権限だけ与える。
-- -------------------------------------------------------------
create schema app_private;
revoke all on schema app_private from public;
grant usage on schema app_private to authenticated, service_role;

/* 記憶の削除の記録を書く（本文なし）。
   security definer なのは、本人に表への書き込み権限を与えないため。
   その代わり、書くのはログイン中の本人の記憶だけに絞る（auth.uid() で決める）。 */
create function app_private.record_memory_deletions(ids uuid[], in_scope text)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'ログインが必要です' using errcode = '42501';
  end if;
  if in_scope not in ('memory_only', 'conversation') then
    raise exception '削除の範囲が正しくありません' using errcode = '22023';
  end if;

  insert into public.memory_deletions (user_id, memory_id, source_message_id, conversation_id, scope)
  select m.user_id, m.id, m.source_message_id, m.conversation_id, in_scope
  from public.memory_candidates m
  where m.id = any (ids)
    and m.user_id = me
  on conflict (user_id, memory_id) do nothing;
end;
$$;

/* 会話の削除の記録を書く（本文なし）。本人の会話で、まだある会話だけ */
create function app_private.record_conversation_deletion(target uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'ログインが必要です' using errcode = '42501';
  end if;

  insert into public.conversation_deletions (user_id, conversation_id)
  select c.user_id, c.id
  from public.conversations c
  where c.id = target
    and c.user_id = me
  on conflict (user_id, conversation_id) do nothing;
end;
$$;

-- -------------------------------------------------------------
-- 3. 記憶の系列を消す（記憶だけ消す・会話ごと消す の共通の手順）
--
-- security definer にはしない。ログイン中の本人の権限のまま動くので、
-- RLS（他人の行は触れない）がそのまま効く。持ち主は auth.uid() から決める。
-- 戻り値は、本文なしの削除にした件数。0 なら何も起きなかった。
-- -------------------------------------------------------------
create function app_private.delete_memory_chain(target uuid, in_scope text)
  returns integer
  language plpgsql
as $$
declare
  me uuid := auth.uid();
  ids uuid[];
  one uuid;
  affected integer;
begin
  if me is null then
    raise exception 'ログインが必要です' using errcode = '42501';
  end if;
  if in_scope not in ('memory_only', 'conversation') then
    raise exception '削除の範囲が正しくありません' using errcode = '22023';
  end if;

  -- つながっている版（訂正前・以前の考え・いまの版）をまとめて対象にする。
  -- 会話をまたいでいても、つながりをたどって全部集める（N-1）
  select array_agg(c.id) into ids from public.memory_chain(target) c;

  -- 自分のものでない、または見つからない
  if ids is null or array_length(ids, 1) is null then
    return 0;
  end if;

  -- 行を押さえてから消す（同時に走った処理が古い内容を書き戻さないように）
  perform 1
  from public.memory_candidates m
  where m.id = any (ids)
  for update;

  /* 削除の記録を先に残す（本文なし）。
     あとで本文を消すので、消す前に「もとの発言」を控えておく。
     すでに記録があるもの（二度押し）は足さない。 */
  perform app_private.record_memory_deletions(ids, in_scope);

  /* 消した内容が残っているやりとりを、AIへ送らないようにする（G1）。
     元の発言・直後の返事・**その記憶を使った返事（別の会話を含む）**。
     本文を消す前に呼ぶ（もとの発言をたどる必要があるので）。 */
  foreach one in array ids loop
    perform public.exclude_memory_context(one, 'deleted');
  end loop;

  /* 提案の文章の案と理由を消し、確認待ちなら閉じる（G3）。
     番号・操作の種類・日時は残す（同じ発言から提案を作り直さない印になる）。 */
  update public.memory_revision_requests
  set proposed_text = null,
      reason = null,
      status = case when status = 'pending' then 'dismissed' else status end,
      resolved_at = coalesce(resolved_at, now())
  where user_id = me
    and target_memory_id = any (ids)
    and (proposed_text is not null or reason is not null or status = 'pending');

  update public.memory_candidates
  set status = 'deleted',
      suggested_text = null,
      confirmed_text = null,
      -- 抽出の理由も消す（ここから本文の中身が推測できるため）
      extraction_reason = null,
      deleted_at = now()
  where id = any (ids)
    and user_id = me
    and status <> 'deleted';

  get diagnostics affected = row_count;
  return affected;
end;
$$;

comment on function app_private.delete_memory_chain(uuid, text) is
  '記憶の系列を本文なしの削除にする共通の手順。削除の記録・AIへ送らない印・提案の本文消しをまとめて行う。画面の API からは呼べない。';

-- 画面の API には出ない場所だが、念のため権限も絞る（中から呼ぶために本人の権限でだけ使える）
revoke all on function app_private.delete_memory_chain(uuid, text) from public, anon;
revoke all on function app_private.record_memory_deletions(uuid[], text) from public, anon;
revoke all on function app_private.record_conversation_deletion(uuid) from public, anon;
grant execute on function app_private.delete_memory_chain(uuid, text) to authenticated;
grant execute on function app_private.record_memory_deletions(uuid[], text) to authenticated;
grant execute on function app_private.record_conversation_deletion(uuid) to authenticated;

-- -------------------------------------------------------------
-- 4. 記憶だけ消す（画面から呼ぶ形は変えない）
-- -------------------------------------------------------------
create or replace function public.delete_memory(target uuid)
  returns integer
  language plpgsql
as $$
begin
  -- 範囲は必ず「記憶だけ」。呼ぶ側からは変えられない
  return app_private.delete_memory_chain(target, 'memory_only');
end;
$$;

comment on function public.delete_memory(uuid) is
  '記憶だけを消す。つながっている版もまとめて本文なしの削除にし、記録を残し、古いやりとりと提案の本文を無害化する。元の会話は残る。';

-- -------------------------------------------------------------
-- 5. 会話ごと消す
--
-- ① その会話から作った記憶を、1件ずつ系列ごと消す（上の共通の手順）
-- ② 会話の削除を記録する（本文なし）
-- ③ 会話を消す（発言・この会話の行は連鎖して消える）
-- 原価の記録（ai_usage）は残る（会話とのつながりが外れるだけ）。
--
-- 戻り値は、本文なしの削除にした記憶の件数。
-- -------------------------------------------------------------
create or replace function public.delete_conversation_with_memories(target uuid)
  returns integer
  language plpgsql
as $$
declare
  me uuid := auth.uid();
  m record;
  total integer := 0;
begin
  if me is null then
    raise exception 'ログインが必要です' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.conversations
    where id = target and user_id = me
  ) then
    return 0;
  end if;

  -- ① その会話から作った記憶を、系列ごと消す（確認待ち・残さない等の候補も含めて記録を残す）
  for m in
    select c.id
    from public.memory_candidates c
    where c.conversation_id = target
      and c.user_id = me
      and c.status <> 'deleted'
    order by c.created_at
  loop
    -- 範囲は必ず「会話ごと」
    total := total + app_private.delete_memory_chain(m.id, 'conversation');
  end loop;

  /* すでに消してあった記憶にも、会話ごとの削除の記録を残す（以前の作りと同じ）。
     記憶だけ消したときの記録がすでにあれば、それは書き換えない（実際にそう消したため） */
  perform app_private.record_memory_deletions(
    array(select c.id from public.memory_candidates c where c.conversation_id = target and c.user_id = me),
    'conversation'
  );

  -- ② 会話の削除を記録する（本文なし）
  perform app_private.record_conversation_deletion(target);

  -- ③ 会話を消す
  delete from public.conversations where id = target and user_id = me;

  return total;
end;
$$;

comment on function public.delete_conversation_with_memories(uuid) is
  '会話ごと消す。その会話から作った記憶を系列ごと本文なしの削除にし（別の会話の返事にもAIへ送らない印）、会話の削除を記録してから会話を消す。';

-- -------------------------------------------------------------
-- 6. さかのぼり（A4）
--
-- この migration より前に消した分を、今の約束にそろえる。
-- 何度実行しても、2回目からは何も変えない（条件に「まだ済んでいないもの」を入れてある）。
--
-- 全利用者の行を扱うので、画面（authenticated）からは呼べない。
-- 運営のテスト（service_role）と、この migration（postgres）だけが呼べる。
-- 返すのは件数だけ（本文は返さない）。
-- -------------------------------------------------------------
create function public.repair_deletion_leftovers()
  returns jsonb
  language plpgsql
as $$
declare
  ids uuid[];
  n_orphans integer := 0;
  n_msgs integer := 0;
  n_reqs integer := 0;
  n integer;
begin
  /* ① 系列の片方だけ残った版（N-1）。
     「訂正前」「以前の考え」なのに、置き換えた新しい版がもう無いもの
     （新しい版の会話を消したため）。つながりをたどって、残りの版も集める。 */
  with recursive seeds as (
    select id, user_id
    from public.memory_candidates
    where status in ('superseded', 'archived') and superseded_by is null
  ),
  chain as (
    select m.id, m.user_id, m.revision_of, m.superseded_by
    from public.memory_candidates m
    where m.id in (select id from seeds)
    union
    select m.id, m.user_id, m.revision_of, m.superseded_by
    from public.memory_candidates m
    join chain c
      on m.user_id = c.user_id
     and (m.id = c.revision_of or m.id = c.superseded_by
          or m.revision_of = c.id or m.superseded_by = c.id)
  )
  select array_agg(distinct id) into ids from chain;

  if ids is not null then
    insert into public.memory_deletions (user_id, memory_id, source_message_id, conversation_id, scope)
    select m.user_id, m.id, m.source_message_id, m.conversation_id, 'conversation'
    from public.memory_candidates m
    where m.id = any (ids)
    on conflict (user_id, memory_id) do nothing;

    -- 元の発言
    update public.messages msg
    set excluded_from_ai_at = now(), exclusion_reason = 'deleted'
    where msg.excluded_from_ai_at is null
      and msg.id in (select m.source_message_id from public.memory_candidates m where m.id = any (ids));
    get diagnostics n = row_count;
    n_msgs := n_msgs + n;

    -- 元の発言の直後のAIの返事
    update public.messages msg
    set excluded_from_ai_at = now(), exclusion_reason = 'deleted'
    where msg.excluded_from_ai_at is null
      and msg.id in (
        select (
          select r.id from public.messages r
          where r.conversation_id = s.conversation_id
            and r.role = 'assistant'
            and r.created_at > s.created_at
          order by r.created_at
          limit 1
        )
        from public.memory_candidates m
        join public.messages s on s.id = m.source_message_id
        where m.id = any (ids)
      );
    get diagnostics n = row_count;
    n_msgs := n_msgs + n;

    update public.memory_candidates
    set status = 'deleted',
        suggested_text = null,
        confirmed_text = null,
        extraction_reason = null,
        deleted_at = now()
    where id = any (ids)
      and status <> 'deleted';
    get diagnostics n_orphans = row_count;
  end if;

  /* ② 消えた記憶を使った返事（G1 のさかのぼり）。
     会話ごと消した記憶は、出典が「墓標」（番号が外れ、消えた日時だけ）になっている。
     記憶だけ消した分（状態が削除）もあわせて見る（すでに印があれば何もしない）。 */
  update public.messages msg
  set excluded_from_ai_at = now(), exclusion_reason = 'deleted'
  where msg.excluded_from_ai_at is null
    and msg.id in (
      select r.message_id
      from public.memory_references r
      left join public.memory_candidates c on c.id = r.memory_id
      where (r.memory_id is null and r.memory_deleted_at is not null)
         or c.status = 'deleted'
    );
  get diagnostics n = row_count;
  n_msgs := n_msgs + n;

  -- ③ 消えた記憶への提案の文章の案と理由（G3 のさかのぼり）
  update public.memory_revision_requests q
  set proposed_text = null,
      reason = null,
      status = case when q.status = 'pending' then 'dismissed' else q.status end,
      resolved_at = coalesce(q.resolved_at, now())
  from public.memory_candidates c
  where c.id = q.target_memory_id
    and c.status = 'deleted'
    and (q.proposed_text is not null or q.reason is not null or q.status = 'pending');
  get diagnostics n_reqs = row_count;

  return jsonb_build_object(
    'orphan_versions_deleted', n_orphans,
    'messages_excluded', n_msgs,
    'requests_scrubbed', n_reqs
  );
end;
$$;

comment on function public.repair_deletion_leftovers() is
  '以前に消した分を、今の削除の約束にそろえる（何度実行しても安全）。件数だけを返す。画面からは呼べない。';

revoke all on function public.repair_deletion_leftovers() from public;
revoke all on function public.repair_deletion_leftovers() from anon, authenticated;
grant execute on function public.repair_deletion_leftovers() to service_role;

-- この migration で1回だけ実行する
select public.repair_deletion_leftovers();
