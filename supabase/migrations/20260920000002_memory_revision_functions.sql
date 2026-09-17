-- =============================================================
-- 0008: 訂正・考えの変化・削除を「ひとまとまり」で行う処理（Phase 3C）
--
-- 【なぜDB側の処理にするか】
-- 訂正は「新しい記憶を足す」と「古い記憶を無効にする」の2段階。
-- アプリから2回に分けて頼むと、途中で失敗したときに
--   ・新しい記憶だけできて、古い記憶が有効なまま残る（内容が2つになる）
--   ・古い記憶だけ無効になって、新しい記憶がない（内容が消える）
-- という中途半端な状態が起きうる。
-- DB側でひとまとめにすれば、必ず「全部できる」か「何も起きない」になる。
--
-- 【同時に走っている処理への備え】
-- 対象の行を押さえてから読む（for update）。
-- さらに「いまも現在有効な内容か」を条件にしているので、
-- 先に別の処理が直していたら、この処理は何もせずに終わる。
-- 遅れて届いた古い内容が、あとから書き戻ることはない。
--
-- 【権限を広げない】
-- security definer にはしない。ログイン中の本人の権限のまま動くので、
-- RLS（他人の行は触れない）がそのまま効く。
-- 持ち主は必ず auth.uid() から決め、画面から渡された値は使わない。
-- =============================================================

-- -------------------------------------------------------------
-- 1. ひとつながりの記憶（版のつながり）をたどる
--
-- 「この記憶を消して」と言われたら、訂正前の版や、
-- 考えが変わる前の版もまとめて消す。
-- 片方だけ残すと、消したはずの内容が「昔の考え」として出てきてしまう。
-- -------------------------------------------------------------
create function public.memory_chain(target uuid)
  returns table (id uuid)
  language sql
  stable
as $$
  with recursive chain as (
    select m.id, m.revision_of, m.superseded_by
    from public.memory_candidates m
    where m.id = target and m.user_id = auth.uid()
    union
    select m.id, m.revision_of, m.superseded_by
    from public.memory_candidates m
    join chain c
      on m.id = c.revision_of
      or m.id = c.superseded_by
      or m.revision_of = c.id
      or m.superseded_by = c.id
    where m.user_id = auth.uid()
  )
  select chain.id from chain;
$$;

comment on function public.memory_chain(uuid) is
  'その記憶とつながっている版（訂正前・考えが変わる前など）をすべて返す。';

revoke all on function public.memory_chain(uuid) from public;
grant execute on function public.memory_chain(uuid) to authenticated;

-- -------------------------------------------------------------
-- 2. 訂正 ／ 考えの変化
--
-- kind = 'correction' … 内容が間違っていた。旧版は superseded（無効）
-- kind = 'update'     … 考えが変わった。旧版は archived（過去の考えとして残る）
--
-- 戻り値は新しい記憶のid。何も起きなかったときは null
-- （すでに直された・消された・他人のもの・現在有効ではない）。
-- -------------------------------------------------------------
create function public.revise_memory(
  target uuid,
  kind text,
  new_text text,
  in_conversation uuid,
  in_message uuid,
  note text default null
)
  returns uuid
  language plpgsql
as $$
declare
  me uuid := auth.uid();
  old_row public.memory_candidates%rowtype;
  new_id uuid;
begin
  if me is null then
    raise exception 'ログインが必要です' using errcode = '42501';
  end if;
  if kind not in ('correction', 'update') then
    raise exception '訂正の種類が正しくありません' using errcode = '22023';
  end if;
  if new_text is null or btrim(new_text) = '' then
    raise exception '新しい内容が空です' using errcode = '22023';
  end if;

  /* 行を押さえてから読む。
     「いま現在有効な内容であること」を条件に入れているので、
     先に別の処理が直していたら found にならず、何も起きない。 */
  select * into old_row
  from public.memory_candidates
  where id = target
    and user_id = me
    and status = 'confirmed'
  for update;

  if not found then
    return null;
  end if;

  insert into public.memory_candidates (
    user_id, conversation_id, source_message_id, candidate_index,
    suggested_text, confirmed_text, origin, requested_by_user,
    status, confirmed_at, revised_at,
    version, revision_of, revision_kind, extraction_reason
  ) values (
    me, in_conversation, in_message, 1,
    btrim(new_text), btrim(new_text), old_row.origin, true,
    'confirmed', now(), now(),
    old_row.version + 1, old_row.id,
    kind, note
  )
  returning id into new_id;

  update public.memory_candidates
  set status = case when kind = 'correction' then 'superseded' else 'archived' end,
      superseded_by = new_id,
      revised_at = now()
  where id = old_row.id
    and status = 'confirmed';

  return new_id;
end;
$$;

comment on function public.revise_memory(uuid, text, text, uuid, uuid, text) is
  '訂正・考えの変化。新しい記憶を足し、古い記憶を同時に無効化（または過去の考えに）する。';

revoke all on function public.revise_memory(uuid, text, text, uuid, uuid, text) from public;
grant execute on function public.revise_memory(uuid, text, text, uuid, uuid, text) to authenticated;

-- -------------------------------------------------------------
-- 3. 記憶だけの削除
--
-- ・つながっている版をまとめて消す
-- ・本文は消す（削除した本文を履歴に残さない）
-- ・削除の記録（本文を持たない）を残す
-- ・元の会話・発言はそのまま残す
--
-- 戻り値は消した件数。0 なら何も起きなかった。
-- -------------------------------------------------------------
create function public.delete_memory(target uuid)
  returns integer
  language plpgsql
as $$
declare
  me uuid := auth.uid();
  affected integer;
begin
  if me is null then
    raise exception 'ログインが必要です' using errcode = '42501';
  end if;

  -- つながっている版をまとめて押さえる
  create temporary table if not exists tmp_delete_chain (id uuid) on commit drop;
  delete from tmp_delete_chain;

  insert into tmp_delete_chain (id)
  select c.id from public.memory_chain(target) c;

  if not exists (select 1 from tmp_delete_chain) then
    return 0;
  end if;

  perform 1
  from public.memory_candidates m
  where m.id in (select id from tmp_delete_chain)
  for update;

  /* 削除の記録を先に残す。
     あとで本文を消すので、消す前に「もとの発言」を控えておく。
     すでに記録があるもの（二重押し）は足さない。 */
  insert into public.memory_deletions (user_id, memory_id, source_message_id, conversation_id, scope)
  select m.user_id, m.id, m.source_message_id, m.conversation_id, 'memory_only'
  from public.memory_candidates m
  where m.id in (select id from tmp_delete_chain)
    and m.user_id = me
  on conflict (user_id, memory_id) do nothing;

  update public.memory_candidates
  set status = 'deleted',
      suggested_text = null,
      confirmed_text = null,
      deleted_at = now()
  where id in (select id from tmp_delete_chain)
    and user_id = me
    and status <> 'deleted';

  get diagnostics affected = row_count;
  return affected;
end;
$$;

comment on function public.delete_memory(uuid) is
  '記憶だけを消す。つながっている版もまとめて消し、本文を消して記録だけ残す。元の会話は残る。';

revoke all on function public.delete_memory(uuid) from public;
grant execute on function public.delete_memory(uuid) to authenticated;

-- -------------------------------------------------------------
-- 4. 会話ごとの削除
--
-- 会話・発言・記憶候補・確定記憶・出典がまとめて消える
-- （外部キーの連鎖）。原価の記録（ai_usage）だけは残る
-- （会話との結び付きが外れるだけ。請求との突き合わせを守るため）。
--
-- 消える前に、その会話から作られた記憶の削除記録を残しておく。
-- 戻り値は、削除記録を残した記憶の件数。
-- -------------------------------------------------------------
create function public.delete_conversation_with_memories(target uuid)
  returns integer
  language plpgsql
as $$
declare
  me uuid := auth.uid();
  recorded integer;
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

  insert into public.memory_deletions (user_id, memory_id, source_message_id, conversation_id, scope)
  select m.user_id, m.id, m.source_message_id, m.conversation_id, 'conversation'
  from public.memory_candidates m
  where m.conversation_id = target
    and m.user_id = me
  on conflict (user_id, memory_id) do nothing;

  get diagnostics recorded = row_count;

  delete from public.conversations where id = target and user_id = me;

  return recorded;
end;
$$;

comment on function public.delete_conversation_with_memories(uuid) is
  '会話ごと消す。消える前に、その会話から作られた記憶の削除記録（本文なし）を残す。';

revoke all on function public.delete_conversation_with_memories(uuid) from public;
grant execute on function public.delete_conversation_with_memories(uuid) to authenticated;
