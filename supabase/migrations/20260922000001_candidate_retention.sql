-- =============================================================
-- 0012: 確定しなかった候補の本文を残さない（Phase 4A）
--
-- 【なにが問題だったか】
-- 30日は「確認の期限」であって、本文を保存しておく期間ではない。
-- ところが実際には、
--   ・本人が［残さない］を選んだ候補（rejected）
--   ・30日をすぎて確認できなくなった候補（expired）
-- のどちらも、本文がDBに残り続けていた（Phase 3D で確認）。
--
-- 本人の画面からは見えないので、**消えたつもりなのに消えていない**状態だった。
--
-- 【この migration ですること】
-- ① いま残っている rejected / expired の本文を消す
-- ② 今後「残さない」「期限切れ」になったときは本文を持てないようにする
--
-- 【残すもの】
-- 同じ候補を何度も作り直さないための最小限だけ。
--   id / user_id / conversation_id / source_message_id / candidate_index
--   status / created_at / expires_at / confirmed_at / requested_by_user / origin
-- 本文（suggested_text / confirmed_text）と、
-- 抽出の理由（extraction_reason ＝ 本文を推測できる説明）は消す。
--
-- 【本人が確定した記憶・会話の保存期間は、ここでは決めない】
-- それは別の判断が要るため、勝手に期限を付けない。
-- =============================================================

-- -------------------------------------------------------------
-- ① いま残っている本文を消す
-- -------------------------------------------------------------
update public.memory_candidates
set suggested_text = null,
    confirmed_text = null,
    extraction_reason = null
where status in ('rejected', 'expired')
  and (suggested_text is not null or confirmed_text is not null or extraction_reason is not null);

-- -------------------------------------------------------------
-- ② 今後、本文を持てないようにする
--
-- 0007 で作った「削除済みは本文を持たない」決まりを広げる。
-- アプリ側の書き忘れがあっても、DB が受け付けない。
-- -------------------------------------------------------------
alter table public.memory_candidates
  drop constraint memory_candidates_deleted_has_no_text;

alter table public.memory_candidates
  add constraint memory_candidates_closed_has_no_text
  check (
    status not in ('rejected', 'expired', 'deleted')
    or (suggested_text is null and confirmed_text is null and extraction_reason is null)
  );

comment on constraint memory_candidates_closed_has_no_text on public.memory_candidates is
  '残さなかった・期限切れ・削除済みの候補は本文を持たない。本人の画面から見えないものを残し続けないため。';
