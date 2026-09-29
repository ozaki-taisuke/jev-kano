#!/usr/bin/env node
/**
 * ElevenLabs の声を選ぶ・作る（試作）。Gemini 側の design_voice.mjs にあたるもの。
 *
 *   node eleven_voices.mjs --usage                     … 口座の枠（使った文字数 / 月の上限・プラン）
 *   node eleven_voices.mjs --list [--all]              … この鍵で使える声（既定は既製の声だけ。--all で全部）
 *   node eleven_voices.mjs --audition <voice_id> [台詞] [--model eleven_v4]   … その声で読ませて _out/voices/ に WAV
 *   node eleven_voices.mjs --design "説明文" [--text "見本に読ませる文（100 字以上）"]   … 文章から声の候補を作り、見本を _out/voices/ に保存
 *   node eleven_voices.mjs --save <generated_voice_id> --name 名前 --desc "説明文"         … 候補を口座に保存 → voice_id を .env の ELEVENLABS_VOICE_ID に
 *
 * 2026-09-29 時点で確かめたこと（公式の文書）と、まだ確かめていないこと（★）:
 *   - 無料の口座で API から使えるのは既製（premade）の声だけ。ライブラリの声は 402。作った声（--design）が無料で使えるかは ★
 *   - 既製の声は 2026-12-31 で使えなくなる、と公式の文書にある（どの声が対象かは ★）。長く使うなら自分の声を作る
 *   - 声を作る口（/v1/text-to-voice/design）の説明文は 20〜1,000 字、見本の文は 100〜1,000 字。候補は 3 つ返る。クレジットを使う ★
 *   - 実在の人の声を写す（クローン）ことは、この道具ではしない。本人の同意が要る（ElevenLabs の規約）
 * 声質の説明は design_voice.mjs と同じ方針: 年齢・性別・声の高さ・質感・話し方を 1〜2 文で。感情や場面の調子は入れない（毎回の指示で付ける）。
 */
import './lib/env-load.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { elevenKey, elevenVoice, listVoices, pickVoice } from './lib/tts_eleven.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(process.env.REFLEX_GALGE_OUT || path.join(here, '_out'), 'voices');
const API = 'https://api.elevenlabs.io';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const has = (k) => process.argv.includes(k);
const safe = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 60);
// 見本に読ませる文（100 字以上が要る）。ゲームの冒頭と結末から
const SAMPLE = 'あっ……すみません、ケーブル、絡まって……。今、ほどきますから。……あの、明日の、ステージのこと……いえ。なんでも、ないです。……明日。……一番前に、いてほしい、です。……片付け、続けますね。';

if (!elevenKey()) { console.error('ELEVENLABS_API_KEY がありません（.env か環境変数）。鍵は https://elevenlabs.io/app/settings/api-keys で作る'); process.exit(1); }
const H = { 'xi-api-key': elevenKey(), 'Content-Type': 'application/json' };
async function call(method, p, body) {
  const r = await fetch(API + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  if (!r.ok) throw new Error(method + ' ' + p + ' → ' + r.status + ' ' + txt.slice(0, 300));
  return JSON.parse(txt);
}

(async () => {
  if (has('--usage')) {
    const s = await call('GET', '/v1/user/subscription');
    console.log('プラン: ' + s.tier + '（' + s.status + '）');
    console.log('文字数: ' + s.character_count + ' / ' + s.character_limit + '（残り ' + (s.character_limit - s.character_count) + '）' + (s.next_character_count_reset_unix ? '・次に戻る日 ' + new Date(s.next_character_count_reset_unix * 1000).toISOString().slice(0, 10) : ''));
    console.log('声の枠: ' + s.voice_slots_used + ' / ' + s.voice_limit + '・すぐ写す（IVC）: ' + (s.can_use_instant_voice_cloning ? '可' : '不可'));
    return;
  }
  if (has('--list')) {
    const voices = await listVoices({});
    const show = has('--all') ? voices : voices.filter((v) => v.category === 'premade');
    console.log('| voice_id | 名前 | 種類 | 性別 | 年代 | 話し方 | 日本語で確かめ済み |\n|:--|:--|:--|:--|:--|:--|:--|');
    for (const v of show) { const l = v.labels || {}; const ja = (v.verified_languages || []).filter((x) => /^ja/i.test(x.language || x.locale || '')).map((x) => x.model_id).join(' '); console.log('| ' + v.voice_id + ' | ' + v.name + ' | ' + v.category + ' | ' + (l.gender || '') + ' | ' + (l.age || '') + ' | ' + (l.descriptive || l.description || l.use_case || '') + ' | ' + (ja || '—') + ' |'); }
    const p = pickVoice(voices); if (p) console.log('\nELEVENLABS_VOICE_ID が無いときに選ばれる声: ' + p.name + '（' + p.voice_id + '）');
    return;
  }
  if (arg('--audition')) {
    const id = arg('--audition'), i = process.argv.indexOf('--audition');
    const text = process.argv.slice(i + 2).filter((x, k, a) => !x.startsWith('--') && a[k - 1] !== '--model').join(' ') || SAMPLE;
    const v = await elevenVoice({ text, mood: 'shy', kind: 'line', intensity: 0.7, affection: 50, model: arg('--model') || 'eleven_v4', voiceName: id });
    fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, 'eleven_' + safe(id) + '_audition.wav');
    fs.writeFileSync(f, Buffer.from(v.base64, 'base64')); console.log('保存: ' + f + '（' + v.ms + ' ms・' + v.chars + ' 字・指示: ' + v.style + '）');
    return;
  }
  if (arg('--design')) {
    const desc = arg('--design'); if (desc.length < 20) { console.error('説明文は 20 字以上'); process.exit(1); }
    const text = arg('--text') || SAMPLE; if (text.length < 100) { console.error('見本の文は 100 字以上'); process.exit(1); }
    const j = await call('POST', '/v1/text-to-voice/design', { voice_description: desc, text, model_id: arg('--model') || 'eleven_ttv_v3' });
    fs.mkdirSync(OUT, { recursive: true });
    for (const [k, p] of (j.previews || []).entries()) {
      const f = path.join(OUT, 'eleven_design_' + safe(p.generated_voice_id) + '.' + (/mp3|mpeg/.test(p.media_type || 'mp3') ? 'mp3' : 'wav'));
      fs.writeFileSync(f, Buffer.from(p.audio_base_64, 'base64'));
      console.log('候補 ' + (k + 1) + ': ' + p.generated_voice_id + '（' + (p.duration_secs || '?') + ' 秒）→ ' + f);
    }
    console.log('\n気に入った候補を保存: node eleven_voices.mjs --save <generated_voice_id> --name 名前 --desc "' + desc.slice(0, 30) + '…"');
    return;
  }
  if (arg('--save')) {
    const j = await call('POST', '/v1/text-to-voice', { voice_name: arg('--name') || 'mahiro', voice_description: arg('--desc') || '', generated_voice_id: arg('--save') });
    console.log('保存した: ' + j.voice_id + '\n.env に: ELEVENLABS_VOICE_ID=' + j.voice_id);
    return;
  }
  console.log('使い方は先頭のコメントを参照');
})().catch((e) => { console.error(e.message); process.exit(1); });
