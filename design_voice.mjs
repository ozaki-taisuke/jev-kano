#!/usr/bin/env node
/**
 * 声を作る（Gemini Voice design）。文章で声質を書くと専用の声ができ、voice_… の ID で以後使える（プロジェクトに 200 個まで・1 年保持）。
 *
 *   node design_voice.mjs --preset            … 用意した候補（下の PRESETS）を全部作り、試聴用の WAV を _out/voices/ に保存して ID を表示
 *   node design_voice.mjs "説明文" --name 名前  … 1 つ作る
 *   node design_voice.mjs --list              … いまある声の一覧
 *   node design_voice.mjs --delete voice_xxx  … 消す
 *   node design_voice.mjs --audition voice_xxx [台詞]   … その声で台詞を読ませて _out/voices/ に WAV を保存（既製の名前 Kore 等も可）
 *
 * 「10 代」「少女」など未成年を思わせる説明は安全ポリシーで弾かれる（2026-09-27 実測）。年齢は 20 代で書く。
 * 気に入った ID を .env の TTS_VOICE に書く。声質の説明は「年齢・性別・声の高さ・質感・話し方（訛り）」を 1〜2 文で（公式の勧め）。
 * 感情や場面ごとの調子は声に入れず、speech_metadata.style（lib/tts.mjs の styleFor）で毎回付ける。
 * 無料枠は TTS が 1 分 3 回・1 日 10 回（2026-09 実測）。声を作るのも数に入ると思っておく。
 */
import './lib/env-load.mjs'; // .env を他の import より先に読む（TTS_VOICE などの既定値のため）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.mjs';
import { voice as tts, DEFAULT_TTS_MODEL } from './lib/tts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(here, '.env'));
const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!KEY) { console.error('GEMINI_API_KEY（または GOOGLE_API_KEY）がありません'); process.exit(1); }
const OUT = path.join(process.env.REFLEX_GALGE_OUT || path.join(here, '_out'), 'voices');
fs.mkdirSync(OUT, { recursive: true });
const MODEL = process.env.TTS_MODEL || DEFAULT_TTS_MODEL;
const API = 'https://generativelanguage.googleapis.com/v1beta/voices';
const H = { 'x-goog-api-key': KEY, 'Content-Type': 'application/json' };

/** 候補。かわいさは声質で決まるので、ここを何本か作って聴き比べる */
export const PRESETS = [
  { name: 'mahiro-a-bright', input: '20 代前半の日本人の女性。高めで明るく、よく通る声。滑舌がよく、感情がはっきり声に出る。アニメのヒロインのような華やかさがあり、標準語。' },
  { name: 'mahiro-b-sweet', input: '20 代前半の日本人の女性。少し高めで、鼻にかかった甘い柔らかい声。息が多めで、照れると声が小さくなる。標準語。' },
  { name: 'mahiro-c-cool', input: '20 代前半の日本人の女性。やや低めで落ち着いた、芯のある声。普段はそっけないが、感情が動くと声が跳ねる。標準語。' },
];
const SAMPLE = '……なに見てんの。明日のこと？ べつに緊張とかしてないし。……してないってば。';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const has = (k) => process.argv.includes(k);
const wavName = (s) => s.replace(/[^\w.-]+/g, '_').slice(0, 60);

async function create(name, input) {
  const body = { store: true, voice: { model: MODEL, type: 'prompted', display_name: name, gender: 'female', language_code: 'ja-JP', prompted: { input } } };
  const r = await fetch(API, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const txt = await r.text();
  if (!r.ok) throw new Error('voices.create ' + r.status + ' ' + txt.slice(0, 300));
  const j = JSON.parse(txt);
  const id = j.name || j.voice_id || j.id || (j.voice && (j.voice.name || j.voice.id));
  const sample = j.sample_audio || (j.voice && j.voice.sample_audio);
  if (sample) { const b = typeof sample === 'string' ? sample : (sample.data || sample.audio || ''); if (b) fs.writeFileSync(path.join(OUT, wavName(name) + '_sample.wav'), Buffer.from(b, 'base64')); }
  return { id, raw: j };
}
async function list() {
  const r = await fetch(API + '?type=prompted', { headers: H });
  const txt = await r.text(); if (!r.ok) throw new Error('voices.list ' + r.status + ' ' + txt.slice(0, 300));
  return JSON.parse(txt);
}
async function del(id) {
  const r = await fetch(API + '/' + encodeURIComponent(id.replace(/^voices\//, '')), { method: 'DELETE', headers: H });
  if (!r.ok) throw new Error('voices.delete ' + r.status + ' ' + (await r.text()).slice(0, 300));
}
async function audition(voiceId, text) {
  const v = await tts({ text, mood: 'shy', kind: 'line', intensity: 0.9, voiceName: voiceId });
  const f = path.join(OUT, wavName(voiceId) + '_audition.wav');
  fs.writeFileSync(f, Buffer.from(v.base64, 'base64'));
  return { f, ms: v.ms, style: v.style };
}

(async () => {
  if (has('--list')) { const j = await list(); console.log(JSON.stringify(j, null, 1)); return; }
  if (arg('--delete')) { await del(arg('--delete')); console.log('消しました: ' + arg('--delete')); return; }
  if (arg('--audition')) {
    const text = process.argv.slice(process.argv.indexOf('--audition') + 2).join(' ') || SAMPLE;
    const o = await audition(arg('--audition'), text); console.log('保存: ' + o.f + '（' + o.ms + 'ms・style: ' + o.style + '）'); return;
  }
  const jobs = has('--preset') ? PRESETS : (process.argv[2] && !process.argv[2].startsWith('--') ? [{ name: arg('--name') || 'voice-' + Date.now(), input: process.argv[2] }] : []);
  if (!jobs.length) { console.log('使い方は先頭のコメントを参照'); return; }
  for (const j of jobs) {
    try {
      const { id, raw } = await create(j.name, j.input);
      console.log(j.name + ' → ' + id + (fs.existsSync(path.join(OUT, wavName(j.name) + '_sample.wav')) ? '（試聴: _out/voices/' + wavName(j.name) + '_sample.wav）' : '（試聴音声なし。応答: ' + JSON.stringify(raw).slice(0, 200) + '）'));
    } catch (e) { console.log(j.name + ' ×  ' + e.message); }
  }
  console.log('\n気に入った ID を .env に: TTS_VOICE=voice_…');
})().catch((e) => { console.error(e.message); process.exit(1); });
