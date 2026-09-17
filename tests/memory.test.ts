/**
 * 記憶候補の単体テスト（Phase 3A）。
 * 外部への接続はしない（判定と読み取りだけを確かめる）。
 */
import { describe, expect, it } from "vitest";
import { isSaveRequest } from "@/config/memory-prompt";
import { parseCandidates } from "@/lib/ai/memory";

describe("「覚えておいて」の検知", () => {
  it.each([
    "これは覚えておいてください",
    "覚えといてね",
    "この話は記憶しておいて",
    "残しておいてほしい",
    "これは残しておいて",
    "忘れないでほしいです",
    "忘れないようにしたい",
    "カッシーに残しておいて",
    "メモしておいてください",
    "記録しておいて",
  ])("保存の希望として拾う：%s", (text) => {
    expect(isSaveRequest(text)).toBe(true);
  });

  it("音声入力で空白が入っても拾う", () => {
    expect(isSaveRequest("これは 覚えて おいて ください")).toBe(true);
  });

  it.each([
    "今日はゴルフに行きました",
    "どう考えたらいいでしょうか",
    "ありがとうございました",
    "何を覚えているか教えてください",
  ])("ふつうの発言は拾わない：%s", (text) => {
    expect(isSaveRequest(text)).toBe(false);
  });
});

describe("AIの返事の読み取り", () => {
  it("候補なしを読み取れる", () => {
    expect(parseCandidates('{"candidates":[]}')).toEqual([]);
  });

  it("候補ありを読み取れる", () => {
    const r = parseCandidates(
      '{"candidates":[{"text":"小さく試して反応を見ることを大切にしている","origin":"self_experience","reason":"判断基準"}]}',
    );
    expect(r).toHaveLength(1);
    expect(r?.[0].origin).toBe("self_experience");
  });

  it("本人が採用していないAIの提案は候補にしない", () => {
    const r = parseCandidates(
      '{"candidates":[{"text":"AIが勝手に提案した案","origin":"ai_suggestion","reason":"提案"},' +
        '{"text":"本人が採用した案","origin":"ai_adopted","reason":"採用"}]}',
    );
    expect(r).toHaveLength(1);
    expect(r?.[0].origin).toBe("ai_adopted");
  });

  it("知らない由来は捨てる", () => {
    const r = parseCandidates('{"candidates":[{"text":"x","origin":"guess","reason":"r"}]}');
    expect(r).toEqual([]);
  });

  it("本文が空のものは捨てる", () => {
    const r = parseCandidates('{"candidates":[{"text":"   ","origin":"self_experience","reason":"r"}]}');
    expect(r).toEqual([]);
  });

  it("形が違えば null（＝候補を出さない）", () => {
    expect(parseCandidates("これはJSONではありません")).toBeNull();
    expect(parseCandidates('{"items":[]}')).toBeNull();
    expect(parseCandidates("[]")).toBeNull();
  });
});
