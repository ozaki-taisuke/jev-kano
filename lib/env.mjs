import fs from 'node:fs';

/**
 * 「=」の右側から値を取り出す。行末の注釈（空白のあとの # から行末まで）は値に入れない。
 *
 * なぜ: .env.example は値の行に注釈を置いている（`GEMINI_API_KEY=      # GOOGLE_API_KEY という名前でも読む`）。
 * コピーして注釈の手前に鍵を書くと、注釈ごと値になっていた。鍵に日本語が混ざると fetch がヘッダーで例外を投げ、
 * モデル名や HOST は別の文字列になる。
 *
 * - 引用符で始まって閉じている値は、引用符の中がそのまま値（中の # も値）。閉じたあとは空か注釈だけを許す。
 * - 引用符なしの値は、空白＋# から行末までが注釈。空白なしで付いた #（`abc#123`）は値の一部。
 * - # で始まる値は注釈だけの行として空にする。# で始まる値を書きたいときは引用符で囲む。
 */
export function parseEnvValue(raw) {
  const s = raw.trim();
  const q = s[0];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, 1);
    if (end > 0 && /^\s*(#.*)?$/.test(s.slice(end + 1))) return s.slice(1, end);
  }
  if (q === '#') return '';
  return s.replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
}

/** .env（KEY=VALUE 行）を読む。すでに環境変数にあるものは上書きしない。無ければ何もしない。 */
export function loadEnv(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = parseEnvValue(m[2]);
  }
}
