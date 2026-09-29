#!/usr/bin/env node
/**
 * .env の読み取りのテスト: 行末の注釈が値に混ざらないこと（lib/env.mjs）。
 * 一時ファイルに書いた作り物の値だけを使う。手元の .env は読まない。
 *   node test_env.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnv, parseEnvValue } from './lib/env.mjs';

const P = 'JEVKANO_ENVTEST_';
const lines = [
  '# 行頭の注釈',
  `${P}PLAIN=abc123`,
  `${P}DQUOTE="abc 123"`,
  `${P}SQUOTE='abc 123'`,
  `${P}COMMENT=abc123            # 注釈つき`,
  `${P}EMPTY_COMMENT=            # GOOGLE_API_KEY という名前でも読む`,
  `${P}EMPTY=`,
  `${P}QUOTED_HASH="abc #123"   # 引用符の中の # は値`,
  `${P}ATTACHED_HASH=abc#123`,
  `${P}URL=https://example.com/a#b   # 注釈`,
  `${P}TAB=abc123\t# タブのあとの注釈`,
  `${P}SPACED = abc123 `,
  `${P}EXISTING=from_file   # 上書きしない`,
  `# ${P}COMMENTED_OUT=0.0.0.0            # 行ごと注釈`,
];
const want = {
  PLAIN: 'abc123',
  DQUOTE: 'abc 123',
  SQUOTE: 'abc 123',
  COMMENT: 'abc123',
  EMPTY_COMMENT: '',
  EMPTY: '',
  QUOTED_HASH: 'abc #123',
  ATTACHED_HASH: 'abc#123',
  URL: 'https://example.com/a#b',
  TAB: 'abc123',
  SPACED: 'abc123',
  EXISTING: 'from_env',
};

for (const k of Object.keys(process.env)) if (k.startsWith(P)) delete process.env[k];
process.env[P + 'EXISTING'] = 'from_env';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevkano-env-'));
const file = path.join(dir, '.env');
try {
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8'); // Windows の改行でも同じ結果になること
  loadEnv(file);
  for (const [k, v] of Object.entries(want)) assert.equal(process.env[P + k], v, k);
  assert.ok(!((P + 'COMMENTED_OUT') in process.env), '行ごと注釈にした行は読まない');
  // 注釈を落としたあとの値は ASCII だけ（鍵に日本語が混ざると fetch がヘッダーで落ちる）
  assert.match(process.env[P + 'COMMENT'], /^[\x21-\x7e]+$/);

  // 閉じていない引用符は前と同じ扱い（頭の引用符だけ外す）
  assert.equal(parseEnvValue(' "abc'), 'abc');
  // # で始まる値は注釈。書きたいときは引用符で囲む
  assert.equal(parseEnvValue('#abc'), '');
  assert.equal(parseEnvValue('"#abc"'), '#abc');

  // ファイルが無ければ何もしない（例外を投げない）
  loadEnv(path.join(dir, 'nai.env'));
  console.log('OK: .env の値・引用符・行末の注釈・上書きなしが期待どおり');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
