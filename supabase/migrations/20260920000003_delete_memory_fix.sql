-- =============================================================
-- 0009: 記憶の削除を、一時テーブルを使わない書き方に直す（Phase 3C）
--
-- 【なぜ直すか】
-- この Supabase では、条件（where）のない delete が禁止されている
-- （うっかり全消しを防ぐための安全策）。
-- 0008 で使っていた一時テーブルの片付けがこれに当たり、
-- 記憶の削除そのものが失敗していた。
--
-- 消す対象の一覧は、一時テーブルではなく配列で持つ。
-- 動きは 0008 と同じ。
-- =============================================================

create or replace function public.delete_memory(target uuid)
  returns integer
  language plpgsql
as $$
declare
  me uuid := auth.uid();
  ids uuid[];
  affected integer;
begin
  if me is null then
    raise exception 'ログインが必要です' using errcode = '42501';
  end if;

  -- つながっている版（訂正前・考えが変わる前）をまとめて対象にする
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

  /* 削除の記録を先に残す。
     あとで本文を消すので、消す前に「もとの発言」を控えておく。
     すでに記録があるもの（二度押し）は足さない。 */
  insert into public.memory_deletions (user_id, memory_id, source_message_id, conversation_id, scope)
  select m.user_id, m.id, m.source_message_id, m.conversation_id, 'memory_only'
  from public.memory_candidates m
  where m.id = any (ids)
    and m.user_id = me
  on conflict (user_id, memory_id) do nothing;

  update public.memory_candidates
  set status = 'deleted',
      suggested_text = null,
      confirmed_text = null,
      deleted_at = now()
  where id = any (ids)
    and user_id = me
    and status <> 'deleted';

  get diagnostics affected = row_count;
  return affected;
end;
$$;

comment on function public.delete_memory(uuid) is
  '記憶だけを消す。つながっている版もまとめて消し、本文を消して記録だけ残す。元の会話は残る。';
