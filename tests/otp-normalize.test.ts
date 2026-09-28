/**
 * ログイン用の6桁コードを整える処理のテスト（引き渡し前UX仕上げ B2）。
 *
 * 【確かめたいこと】
 *   ・PCで日本語入力がオンのまま打った全角の数字でも、ログインできること
 *   ・メールからの貼り付けで紛れ込む空白があっても、ログインできること
 *   ・正しい半角6桁の、これまでの動作が変わらないこと
 *   ・不正な入力は、これまでどおり拒否すること（受け付ける範囲を広げすぎない）
 *
 * 画面にもDBにもつながらない（純粋な処理だけを呼ぶ）。
 */
import { describe, expect, it } from "vitest";
import { normalizeOtp } from "@/lib/otp";

// =============================================================
// 通すもの
// =============================================================
describe("整えて通すもの", () => {
  it("正しい半角6桁は、そのまま（これまでの動作が変わらない）", () => {
    expect(normalizeOtp("123456")).toBe("123456");
  });

  it("全角の数字を、半角にする", () => {
    expect(normalizeOtp("０１２３４５")).toBe("012345");
    expect(normalizeOtp("１２３４５６")).toBe("123456");
    expect(normalizeOtp("６７８９０１")).toBe("678901");
  });

  it("全角と半角がまじっていても、半角にそろえる", () => {
    expect(normalizeOtp("12３４56")).toBe("123456");
  });

  it("半角の空白を取り除く", () => {
    expect(normalizeOtp("123 456")).toBe("123456");
    expect(normalizeOtp("1 2 3 4 5 6")).toBe("123456");
  });

  it("全角の数字と全角の空白の組み合わせでも通す", () => {
    expect(normalizeOtp("１２３　４５６")).toBe("123456");
  });

  it("前後の空白を取り除く", () => {
    expect(normalizeOtp(" 123456 ")).toBe("123456");
    expect(normalizeOtp("　123456　")).toBe("123456");
  });

  it("タブ・改行・ノーブレークスペースを取り除く", () => {
    expect(normalizeOtp("123\t456")).toBe("123456");
    expect(normalizeOtp("123456\n")).toBe("123456");
    expect(normalizeOtp("123\r\n456")).toBe("123456");
    expect(normalizeOtp("123 456")).toBe("123456");
  });

  it("ゼロ幅の文字（メールからの貼り付けで紛れ込むもの）を取り除く", () => {
    expect(normalizeOtp("123​456")).toBe("123456");
    expect(normalizeOtp("﻿123456")).toBe("123456");
    expect(normalizeOtp("12‌34‍56")).toBe("123456");
  });

  it("0で始まるコードの、先頭の0を消さない", () => {
    expect(normalizeOtp("000000")).toBe("000000");
    expect(normalizeOtp("０００１２３")).toBe("000123");
  });
});

// =============================================================
// 拒否するもの（受け付ける範囲を広げすぎない）
// =============================================================
describe("拒否するもの", () => {
  it("空・空白だけ", () => {
    expect(normalizeOtp("")).toBeNull();
    expect(normalizeOtp("   ")).toBeNull();
    expect(normalizeOtp("　　")).toBeNull();
  });

  it("桁が足りない（5桁）", () => {
    expect(normalizeOtp("12345")).toBeNull();
    expect(normalizeOtp("１２３４５")).toBeNull();
  });

  it("桁が多い（7桁）。6桁に切り詰めない", () => {
    expect(normalizeOtp("1234567")).toBeNull();
    expect(normalizeOtp("１２３４５６７")).toBeNull();
  });

  it("英字がまじっている", () => {
    expect(normalizeOtp("12a456")).toBeNull();
    expect(normalizeOtp("ABCDEF")).toBeNull();
    expect(normalizeOtp("１２ａ４５６")).toBeNull();
  });

  it("ハイフンが入っている（今回は受け付けない）", () => {
    expect(normalizeOtp("123-456")).toBeNull();
    expect(normalizeOtp("123－456")).toBeNull();
  });

  it("丸数字・上付き数字（NFKC を使っていないことの確認）", () => {
    expect(normalizeOtp("①②③④⑤⑥")).toBeNull();
    expect(normalizeOtp("12345²")).toBeNull();
  });

  it("全角・半角以外の数字（アラビア＝インド数字など）", () => {
    expect(normalizeOtp("١٢٣٤٥٦")).toBeNull();
  });

  it("記号がまじっている", () => {
    expect(normalizeOtp("123.456")).toBeNull();
    expect(normalizeOtp("123456!")).toBeNull();
  });
});
