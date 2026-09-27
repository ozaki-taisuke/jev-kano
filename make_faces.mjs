#!/usr/bin/env node
/**
 * 顔の画像を作る（Gemini の画像生成・編集）。基準の 1 枚（平静）を作り、同じ人物のまま表情だけ変えた 4 枚を編集で作る。
 *
 *   node make_faces.mjs            … calm → joy / shy / puzzled / upset の 5 枚（jpg）を public/faces/ に保存
 *   node make_faces.mjs --base     … 基準の 1 枚（calm）だけ作る（気に入るまでやり直す）
 *   node make_faces.mjs --from calm.jpg   … 手持ちの基準画から 4 表情だけ作る
 *   node make_faces.mjs --base --character "人物の説明（英語）" --to making/faces/v2_calm.jpg   … 別の説明で基準画の候補を別の場所に
 *   node make_faces.mjs --variant shy_strong --green    … 名前つきの 1 枚（下の VARIANTS。基準は public/faces/calm.jpg）を作り、--green で緑背景版も
 *   node make_faces.mjs --variant upset_mid --to making/faces/cand_upset_mid.jpg   … 候補として別の場所に（気に入ったら public/faces/ にコピー）
 *   node make_faces.mjs --variant shy_strong_scores --prompt "…（英語）"   … 指示を差し替えて
 *
 * 絵の名前 = 本音 + 段階（_mid・_strong）+ はじまり（_scores など。その回だけ差し替わる）。server.mjs の FACE_NAME と同じ。
 *
 * 画像生成に無料枠は無い（2026-09 の料金表）。1 枚 $0.045〜。IMAGE_MODEL で変更（既定 gemini-3.1-flash-image）。
 * 人物の説明は年齢を 20 代で書く（未成年を思わせる説明は安全ポリシーで弾かれる）。
 */
import './lib/env-load.mjs'; // .env を他の import より先に読む（TTS_VOICE などの既定値のため）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(here, '.env'));
const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!KEY) { console.error('GEMINI_API_KEY（または GOOGLE_API_KEY）がありません'); process.exit(1); }
const MODEL = process.env.IMAGE_MODEL || 'gemini-3.1-flash-image';
const DIR = path.join(here, 'public', 'faces');
fs.mkdirSync(DIR, { recursive: true });

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const CHARACTER = arg('--character') || 'Anime-style illustration of a Japanese university student in her early 20s, named Mahiro. Long lavender-purple hair with soft bangs and a small pink ribbon on the right side, large expressive blue eyes with bright highlights, fair skin, white blouse with a pink ribbon tie. Clean cel shading, soft lighting, high-quality modern anime key-visual look. Bust shot, front-facing, centered, looking at the viewer, plain solid dark violet background (#251d36), no text, no watermark.';
const EXPRESSIONS = {
  calm: 'Expression: calm, reserved and gentle, a slightly downcast shy gaze, small closed mouth; a quiet bookish girl.',
  joy: 'Change only the facial expression, subtly: a faint, shy smile with the mouth closed, eyes softened a little, a light natural blush; she is pleased but keeps it small.',
  shy: 'Change only the facial expression, subtly: a light blush on the cheeks, eyes glancing away to the side, lips pressed together slightly; embarrassed but quiet, no open mouth, no steam or sweat marks.',
  puzzled: 'Change only the facial expression, subtly: eyebrows tilted up a little in worry, eyes looking down, mouth closed and small; troubled and unsure, no sweat drop.',
  upset: 'Change only the facial expression, subtly: quiet displeasure. Eyebrows slightly drawn, eyes lowered and turned away in a cold, hurt way, mouth closed and tight; she is upset but withdrawn, not glaring, no anger mark.',
};
const KEEP = ' Keep exactly the same character, hair, clothes, art style, framing, camera angle, lighting and background as the reference image.';
/** 名前つきの 1 枚（issue #19・#20）。ポーズが変わるものは KEEP の「framing」に「pose」を含めない */
const VARIANTS = {
  // #20 照れ隠しを本以外で: 既定は袖（小道具なし）。_scores は「散らばった楽譜」の回だけ
  shy_strong: 'Change the pose and expression: she pulls the long sleeve of her gray cardigan over her hand and presses it against her mouth to hide it, eyes closed tight, a deep blush; embarrassed and hiding. No book anywhere. No steam, no sweat marks, no visible open mouth.',
  shy_strong_scores: 'Change the pose and expression: she holds a sheet of music (plain staff paper, no readable text or logos) up in front of her mouth and nose with both hands, eyes closed, a deep blush; embarrassed and hiding behind it. No book anywhere.',
  // #19 怒りの段階: 中は「むっ」、強は睨まずに「傷つきながら、はっきり拒む」
  upset_mid: 'Change only the facial expression, subtly: mild displeasure, a small "hmph". Eyebrows drawn together just a little, lips pressed shut, eyes still turned away and lowered; she is bothered but timid, not glaring, no frown lines, no anger mark, no open mouth.',
  upset_strong: 'Change only the facial expression: hurt and firmly refusing. She looks straight at the viewer with wounded, glistening eyes, eyebrows drawn together but no deep frown lines, mouth closed and tense; frightened yet resolute, not glaring, not hostile, no anger mark, no tears falling.',
};

async function gen(inputs) {
  const body = { model: MODEL, input: inputs, response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '1:1', image_size: '1K' } };
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', { method: 'POST', headers: { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const txt = await r.text();
  if (!r.ok) throw new Error(r.status + ' ' + txt.slice(0, 300));
  const j = JSON.parse(txt);
  let data = j.interaction && j.interaction.output_image && j.interaction.output_image.data;
  if (!data) for (const s of j.steps || []) for (const c of s.content || []) if (c.type === 'image' && c.data) data = c.data;
  if (!data) throw new Error('画像が返らなかった: ' + txt.slice(0, 300));
  return Buffer.from(data, 'base64');
}

(async () => {
  let base;
  const from = arg('--from');
  const variant = arg('--variant');
  if (variant) { // 名前つきの 1 枚
    if (!/^(joy|shy|puzzled|upset|calm)(_mid|_strong)?(_[a-z][a-z0-9]*)?$/.test(variant)) throw new Error('名前は 本音(_mid|_strong)?(_はじまり)? の形: ' + variant);
    const prompt = arg('--prompt') || VARIANTS[variant]; if (!prompt) throw new Error('この名前の指示が VARIANTS に無い。--prompt で渡す: ' + variant);
    const ref = from || path.join(DIR, 'calm.jpg'); base = fs.readFileSync(ref);
    const keep = /pose/i.test(prompt) ? KEEP.replace('framing, ', '') : KEEP; // ポーズを変える指示のときは枠だけ固定しない
    process.stdout.write(variant + '（基準 ' + path.relative(here, ref) + '）… ');
    const img = await gen([{ type: 'text', text: prompt + keep }, { type: 'image', mime_type: 'image/jpeg', data: base.toString('base64') }]);
    const to = arg('--to') || path.join(DIR, variant + '.jpg'); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, img); console.log(path.relative(here, to));
    if (process.argv.includes('--green')) { // 緑背景版（立ち絵用）も
      const { spawnSync } = await import('node:child_process');
      const g = to.startsWith(DIR) ? path.join(DIR, 'green', path.basename(to)) : to.replace(/\.jpe?g$/i, '_green.jpg');
      const r = spawnSync(process.execPath, [path.join(here, 'make_cutout.mjs'), to, g], { stdio: 'inherit' }); if (r.status !== 0) throw new Error('緑背景版が作れなかった');
    }
    console.log(to.startsWith(DIR) ? 'サーバーを立て直すと使われる（' + variant + '）' : '気に入ったら public/faces/' + variant + '.jpg にコピーして、node make_cutout.mjs で緑背景版を');
    return;
  }
  if (from) base = fs.readFileSync(from);
  else {
    process.stdout.write('基準（calm）… ');
    base = await gen([{ type: 'text', text: CHARACTER + ' ' + EXPRESSIONS.calm }]);
    const to = arg('--to') || path.join(DIR, 'calm.jpg'); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, base); console.log(to);
    if (process.argv.includes('--base')) return;
  }
  for (const k of ['joy', 'shy', 'puzzled', 'upset']) {
    process.stdout.write(k + '… ');
    try {
      const img = await gen([{ type: 'text', text: EXPRESSIONS[k] + KEEP }, { type: 'image', mime_type: 'image/jpeg', data: base.toString('base64') }]);
      fs.writeFileSync(path.join(DIR, k + '.jpg'), img); console.log('public/faces/' + k + '.jpg');
    } catch (e) { console.log('×  ' + e.message); }
  }
  console.log('サーバーを立て直すと画像の顔になる（無ければ SVG）');
})().catch((e) => { console.error(e.message); process.exit(1); });
