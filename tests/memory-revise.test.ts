/**
 * 記憶の訂正・考えの変化・削除まわりの単体テスト（Phase 3C）。
 * 外部への接続はしない（言い方の判定と、返ってきた形の読み取りだけ）。
 */
import { describe, expect, it } from "vitest";
import { asksAboutPast, detectRevisionIntent } from "@/config/revision-prompt";
import { parseTargets, toTargets } from "@/lib/ai/memory-revise";
import { memoryContextBlock } from "@/config/search-prompt";
import type { Memory } from "@/lib/ai/memory-search";

const memory = (id: string, text: string, isPast = false): Memory => ({
  id,
  text,
  conversationId: "c1",
  confirmedAt: null,
  isPast,
  version: 1,
});

describe("記憶の操作を求めている言い方かを見る", () => {
  it("消してほしい言い方を拾う", () => {
    expect(detectRevisionIntent("田中商店の記憶を消して")).toBe("delete");
    expect(detectRevisionIntent("あれは残したくない")).toBe("delete");
    expect(detectRevisionIntent("さっきの話はなかったことにしてください")).toBe("delete");
  });

  it("直してほしい言い方を拾う", () => {
    expect(detectRevisionIntent("違う、25日だった")).toBe("correct");
    expect(detectRevisionIntent("それは間違いです")).toBe("correct");
    expect(detectRevisionIntent("20日ではなく25日です")).toBe("correct");
  });

  it("考えが変わった言い方を拾う", () => {
    expect(detectRevisionIntent("最近は考えが変わってきました")).toBe("update");
    expect(detectRevisionIntent("方針を変えようと思います")).toBe("update");
  });

  it("ふだんの会話では拾わない（AIを呼ばない）", () => {
    expect(detectRevisionIntent("こんにちは")).toBeNull();
    expect(detectRevisionIntent("新しい商品を考えているんだけど、どう進めようか")).toBeNull();
    expect(detectRevisionIntent("最近よく眠れなくて困っています")).toBeNull();
    expect(detectRevisionIntent("今日の天気はどうかな")).toBeNull();
  });

  it("空白があっても拾う（音声入力で入りやすい）", () => {
    expect(detectRevisionIntent("違う 、 25日 だった")).toBe("correct");
  });
});

describe("昔のことを聞かれているかを見る", () => {
  it("昔を聞く言い方を拾う", () => {
    expect(asksAboutPast("昔はどう考えていた？")).toBe(true);
    expect(asksAboutPast("以前はどうしていましたか")).toBe(true);
    expect(asksAboutPast("変わる前の考えを教えて")).toBe(true);
  });

  it("いまの相談では拾わない（昔の考えを検索に混ぜない）", () => {
    expect(asksAboutPast("新しい商品をどう進めようか")).toBe(false);
    expect(asksAboutPast("こんにちは")).toBe(false);
  });
});

describe("挙がった対象の読み取り", () => {
  it("対象と種類と新しい文章を読み取れる", () => {
    const raw = parseTargets(
      '{"targets":[{"number":1,"intent":"correct","new_text":"締め日は25日","reason":"言い直したため"}]}',
    );
    expect(raw).toHaveLength(1);
    expect(raw?.[0].intent).toBe("correct");
    expect(raw?.[0].newText).toBe("締め日は25日");
  });

  it("0件を読み取れる（見つからないのは正常）", () => {
    expect(parseTargets('{"targets":[]}')).toEqual([]);
  });

  it("知らない種類は捨てる", () => {
    const raw = parseTargets(
      '{"targets":[{"number":1,"intent":"rewrite","new_text":"x","reason":"y"}]}',
    );
    expect(raw).toEqual([]);
  });

  it("形が違えば null（＝何も提案しない）", () => {
    expect(parseTargets("これはJSONではありません")).toBeNull();
    expect(parseTargets('{"items":[]}')).toBeNull();
  });
});

describe("提案にするときの決まり", () => {
  const candidates = [memory("m1", "締め日は毎月20日"), memory("m2", "昔の考え", true)];

  it("番号を記憶に戻せる", () => {
    const out = toTargets(
      [{ number: 1, intent: "correct", newText: "締め日は毎月25日", reason: "r" }],
      candidates,
    );
    expect(out).toHaveLength(1);
    expect(out[0].memory.id).toBe("m1");
    expect(out[0].proposedText).toBe("締め日は毎月25日");
  });

  it("削除のときは新しい文章を持たない", () => {
    const out = toTargets([{ number: 1, intent: "delete", newText: "", reason: "r" }], candidates);
    expect(out[0].intent).toBe("delete");
    expect(out[0].proposedText).toBeNull();
  });

  it("訂正なのに新しい文章がない提案は捨てる", () => {
    const out = toTargets([{ number: 1, intent: "correct", newText: "  ", reason: "r" }], candidates);
    expect(out).toEqual([]);
  });

  it("ない番号は捨てる", () => {
    const out = toTargets([{ number: 9, intent: "delete", newText: "", reason: "r" }], candidates);
    expect(out).toEqual([]);
  });

  it("同じ記憶を2回は出さない", () => {
    const out = toTargets(
      [
        { number: 1, intent: "delete", newText: "", reason: "r" },
        { number: 1, intent: "delete", newText: "", reason: "r" },
      ],
      candidates,
    );
    expect(out).toHaveLength(1);
  });

  it("提案は最大2件まで", () => {
    const many = [memory("a", "1"), memory("b", "2"), memory("c", "3")];
    const out = toTargets(
      [
        { number: 1, intent: "delete", newText: "", reason: "r" },
        { number: 2, intent: "delete", newText: "", reason: "r" },
        { number: 3, intent: "delete", newText: "", reason: "r" },
      ],
      many,
    );
    expect(out).toHaveLength(2);
  });

  it("新しい文章が長すぎるときは切り詰める", () => {
    const out = toTargets(
      [{ number: 1, intent: "correct", newText: "あ".repeat(900), reason: "r" }],
      candidates,
    );
    expect(out[0].proposedText?.length).toBe(500);
  });
});

describe("昔の考えを渡すときの書き方", () => {
  it("昔の考えには、いまの考えではないと明記する", () => {
    const block = memoryContextBlock([{ text: "昔はこう考えていた", isPast: true }]);
    expect(block).toContain("考えが変わる前の古い考えです");
    expect(block).toContain("いまの考えではありません");
  });

  it("いまの内容の行には、その注記を付けない", () => {
    const block = memoryContextBlock([{ text: "いまの考え" }]);
    // 注記は記録の行だけに付く（下の使い方の説明には常に書いてある）
    expect(block.split("---")[2]).toContain("1. いまの考え");
    expect(block).not.toContain("1. いまの考え（");
  });

  it("昔の考えは、昔を聞かれたときだけ使うよう指示している", () => {
    const block = memoryContextBlock([{ text: "昔の考え", isPast: true }]);
    expect(block).toContain("昔のことを聞かれたときだけ");
  });
});
