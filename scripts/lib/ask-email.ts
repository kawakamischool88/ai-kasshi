/**
 * 完全削除・利用停止の命令で、対象のメールアドレスを受け取る（Phase E ／ E4）。
 *
 * 【実在の人のメールアドレスを、命令の後ろに書かせない】
 * 命令の後ろ（引数）に書くと、PowerShell の履歴・npm の記録・開発用のAIツールに残る・渡る。
 * そこで、
 *   ・引数で受け取るのは、テスト用の架空のアドレス（@example.com）だけ
 *   ・それ以外は、実行したあとに「入力してください」と聞く（入力した文字は画面に出さない）
 *   ・聞く相手がいない（キーボードから入力できない＝AIツールなどから動かされた）ときは止まる
 */
import readline from "node:readline";

const TEST_DOMAIN = "@example.com";

export function isTestEmail(email: string): boolean {
  return email.toLowerCase().endsWith(TEST_DOMAIN);
}

/** 入力を画面に出さずに1行読む */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    process.stdout.write(question);
    let muted = true;
    out._writeToOutput = (s: string) => {
      if (!muted) out.output.write(s);
    };
    rl.question("", (answer) => {
      muted = false;
      process.stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * @param argEmail 命令の後ろに書かれたアドレス（無ければ undefined）
 */
export async function emailFromArgOrPrompt(argEmail: string | undefined): Promise<string> {
  if (argEmail) {
    if (!isTestEmail(argEmail)) {
      throw new Error(
        "中止：実在の人のメールアドレスは、命令の後ろに書かないでください（履歴などに残るため）。" +
          "アドレスを付けずに実行し、聞かれたら入力してください。念のため、PowerShell の履歴から今の命令を消してください（AGENTS.md の手順）。",
      );
    }
    return argEmail;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      "中止：メールアドレスの入力が必要です。この命令は、運営者が自分の端末で実行してください（開発用のAIツールからは実行できません）。",
    );
  }
  return askHidden("対象のメールアドレスを入力してください（入力した文字は画面に出ません）：");
}
