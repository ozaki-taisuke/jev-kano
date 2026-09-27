#!/usr/bin/env node
/**
 * 顔の絵の背景を、切り抜き用の一様な緑（クロマキー）に置き換える（Gemini の画像編集）。人物はそのまま。
 * 画面側で緑を透明にして、背景の絵の上に立たせる（立ち絵）。
 *
 *   node make_cutout.mjs public/faces/calm.jpg making/faces/v6_green_calm.jpg
 *   node make_cutout.mjs --all            … public/faces/*.jpg → public/faces/green/*.jpg
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
const PROMPT = 'Replace the background with a flat, uniform, pure bright green (#00FF00) chroma-key background that fills every background pixel edge to edge. Keep the character exactly identical: same pose, hair, clothes, expression, framing, camera, lighting and art style as the reference image. Clean, crisp edges around the hair; no green spill or glow on the character.';
async function gen(inputs) {
  const body = { model: MODEL, input: inputs, response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '1:1', image_size: '1K' } };
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', { method: 'POST', headers: { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const txt = await r.text(); if (!r.ok) throw new Error(r.status + ' ' + txt.slice(0, 300));
  const j = JSON.parse(txt); let data = j.interaction && j.interaction.output_image && j.interaction.output_image.data;
  if (!data) for (const s of j.steps || []) for (const c of s.content || []) if (c.type === 'image' && c.data) data = c.data;
  if (!data) throw new Error('画像が返らなかった: ' + txt.slice(0, 300));
  return Buffer.from(data, 'base64');
}
async function one(from, to) {
  process.stdout.write(path.basename(from) + ' → ');
  const img = await gen([{ type: 'text', text: PROMPT }, { type: 'image', mime_type: 'image/jpeg', data: fs.readFileSync(from).toString('base64') }]);
  fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, img); console.log(to);
}
(async () => {
  if (process.argv.includes('--all')) {
    const dir = path.join(here, 'public', 'faces');
    for (const f of fs.readdirSync(dir)) if (/\.jpe?g$/i.test(f)) { try { await one(path.join(dir, f), path.join(dir, 'green', f)); } catch (e) { console.log('×  ' + e.message); } }
  } else await one(process.argv[2], process.argv[3]);
})().catch((e) => { console.error(e.message); process.exit(1); });
