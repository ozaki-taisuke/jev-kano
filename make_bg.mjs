#!/usr/bin/env node
/**
 * 背景の絵を作る（Gemini の画像生成）。人物なしの部室・ステージ袖。画面全体の背景と開始画面に敷く。
 *
 *   node make_bg.mjs                       … 部室（夕方）を public/bg/clubroom.jpg に
 *   node make_bg.mjs --id wings            … ステージ袖を public/bg/wings.jpg に
 *   node make_bg.mjs --to making/bg/v2.jpg … 候補を別の場所に（気に入るまでやり直す）
 *
 * 画像生成に無料枠は無い。1 枚 $0.05〜0.13（2K）。IMAGE_MODEL で変更（既定 gemini-3.1-flash-image）。
 */
import './lib/env-load.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(here, '.env'));
const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!KEY) { console.error('GEMINI_API_KEY（または GOOGLE_API_KEY）がありません'); process.exit(1); }
const MODEL = process.env.IMAGE_MODEL || 'gemini-3.1-flash-image';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const id = arg('--id') || 'clubroom';

const STYLE = 'Anime visual-novel background art, painterly cel-shaded, soft light, wide cinematic shot, no people, no characters, no text, no letters, no watermark.';
const PROMPTS = {
  clubroom: 'A small university light-music club room at dusk. Warm orange evening light pours through a large window on the left; long shadows on a wooden floor. Guitar amplifiers, a drum kit in the back corner, a bass guitar case leaning on the wall, coiled black cables on the floor, music stands, a bookshelf with paperbacks, a few posters on the wall, a kettle on a low shelf. Muted warm palette with a touch of blue in the shadows; quiet, nostalgic, after-school mood.',
  wings: 'Backstage wing of a small school festival stage, seen from the side of a heavy dark curtain. A thin strip of bright stage light leaks through the gap in the curtain; equipment cases, cables taped to the floor, a mic stand, a small work light. Dim, purple-blue shadows, tense and quiet.',
};
const prompt = arg('--prompt') || PROMPTS[id] || PROMPTS.clubroom;

async function gen(text) {
  const body = { model: MODEL, input: [{ type: 'text', text }], response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '16:9', image_size: process.env.IMAGE_SIZE || '2K' } };
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
  const to = arg('--to') || path.join(here, 'public', 'bg', id + '.jpg');
  process.stdout.write(id + '… ');
  const img = await gen(prompt + ' ' + STYLE);
  fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, img);
  console.log(to + ' (' + Math.round(img.length / 1024) + ' KB)');
})().catch((e) => { console.error(e.message); process.exit(1); });
