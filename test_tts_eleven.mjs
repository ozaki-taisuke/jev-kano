#!/usr/bin/env node
/**
 * ElevenLabs の口（lib/tts_eleven.mjs）の確かめ。API は呼ばない（fetch を差し替える）。
 *   node test_tts_eleven.mjs
 * 確かめること: 送る形・半端なバイトのそろえ方・音量・language_code を断られたときのやり直し・失敗の読み方・声の選び方・Gemini 側へ影響しないこと。
 */
import assert from 'node:assert/strict';

process.env.ELEVENLABS_API_KEY = 'test-key';
delete process.env.ELEVENLABS_VOICE_ID; delete process.env.ELEVEN_TAG; delete process.env.ELEVEN_ELLIPSIS; delete process.env.ELEVEN_GAIN;
const E = await import('./lib/tts_eleven.mjs');

const VOICE = 'AbCdEfGhIjKlMnOpQrSt'; // 20 文字＝ElevenLabs の voice_id の形
const streamOf = (parts) => new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new Uint8Array(p)); c.close(); } });
const okRes = (parts, headers = {}) => new Response(streamOf(parts), { status: 200, headers });
const errRes = (status, detail) => new Response(JSON.stringify({ detail }), { status, headers: { 'Content-Type': 'application/json' } });
const pcm = (...samples) => { const b = Buffer.alloc(samples.length * 2); samples.forEach((s, i) => b.writeInt16LE(s, i * 2)); return b; };
let n = 0; const ok = (name) => { n++; console.log('  ok ' + name); };

// 1. 送る形: 口・鍵・モデル・文（指示つき）・PCM 24kHz
{
  const calls = [];
  const r = await E.elevenVoiceStream({ text: '……あ、はい', mood: 'shy', kind: 'line', intensity: 0.7, affection: 50, model: 'eleven_v4', voiceName: VOICE, onChunk: () => {}, fetchImpl: async (url, init) => { calls.push({ url, init }); return okRes([pcm(1, 2, 3)], { 'character-cost': '42' }); } });
  const c = calls[0]; const body = JSON.parse(c.init.body);
  assert.equal(c.url, 'https://api.elevenlabs.io/v1/text-to-speech/' + VOICE + '/stream?output_format=pcm_24000');
  assert.equal(c.init.headers['xi-api-key'], 'test-key');
  assert.equal(body.model_id, 'eleven_v4'); assert.equal(body.language_code, 'ja');
  assert.equal(body.text, '[shy] ……あ、はい'); // 既定は短い指示
  assert.equal(r.chars, body.text.length); assert.equal(r.bytes, 6); assert.equal(r.sampleRate, 24000); assert.equal(r.headers['character-cost'], '42');
  ok('送る形');
}
// 2. 半端なバイト: 断片が奇数で切れても、渡す断片は必ず偶数で、つなぐと元と同じ
{
  const src = pcm(100, -200, 300, -400, 500); const got = [];
  await E.elevenVoiceStream({ text: 'はい', mood: 'calm', model: 'eleven_v4', voiceName: VOICE, onChunk: (c) => got.push(c), fetchImpl: async () => okRes([src.subarray(0, 3), src.subarray(3, 4), src.subarray(4, 9), src.subarray(9)]) });
  assert.ok(got.every((c) => c.length % 2 === 0)); assert.deepEqual(Buffer.concat(got), src);
  ok('半端なバイト');
}
// 3. 音量: gain を掛け、あふれたら端で止める
{
  const got = [];
  await E.elevenVoiceStream({ text: 'はい', mood: 'calm', model: 'eleven_v4', voiceName: VOICE, gain: 0.5, onChunk: (c) => got.push(c), fetchImpl: async () => okRes([pcm(1000, -1000, 32767)]) });
  assert.deepEqual(Buffer.concat(got), pcm(500, -500, 16384));
  const loud = [];
  await E.elevenVoiceStream({ text: 'はい', mood: 'calm', model: 'eleven_v4', voiceName: VOICE, gain: 2, onChunk: (c) => loud.push(c), fetchImpl: async () => okRes([pcm(20000, -20000)]) });
  assert.deepEqual(Buffer.concat(loud), pcm(32767, -32768));
  ok('音量');
}
// 4. language_code を断られたら、外してやり直し、以後そのモデルには付けない
{
  const bodies = [];
  const f = async (url, init) => { const b = JSON.parse(init.body); bodies.push(b); return b.language_code ? errRes(400, { status: 'unsupported_language_code', message: 'language_code is not supported for this model' }) : okRes([pcm(1)]); };
  await E.elevenVoiceStream({ text: 'はい', mood: 'calm', model: 'eleven_test_model', voiceName: VOICE, onChunk: () => {}, fetchImpl: f });
  await E.elevenVoiceStream({ text: 'はい', mood: 'calm', model: 'eleven_test_model', voiceName: VOICE, onChunk: () => {}, fetchImpl: f });
  assert.deepEqual(bodies.map((b) => 'language_code' in b), [true, false, false]);
  ok('language_code のやり直し');
}
// 5. 失敗の読み方: 無料の口座でライブラリの声（402）・枠切れ（server.mjs が「per day … retry in」で字幕モードに入れる形）
{
  await assert.rejects(E.elevenVoiceStream({ text: 'はい', mood: 'calm', model: 'eleven_v4', voiceName: VOICE, onChunk: () => {}, fetchImpl: async () => errRes(402, { status: 'paid_plan_required', message: 'Free users cannot use library voices via the API.' }) }), /402 paid_plan_required.*既製の声/);
  let msg = ''; try { await E.elevenVoiceStream({ text: 'はい', mood: 'calm', model: 'eleven_v4', voiceName: VOICE, onChunk: () => {}, fetchImpl: async () => errRes(401, { status: 'quota_exceeded', message: 'This request exceeds your quota.' }) }); } catch (e) { msg = e.message; }
  const m = msg.match(/per day.*?retry in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i); // server.mjs の noteTtsError と同じ式
  assert.ok(m && m[1] === '6', msg);
  ok('失敗の読み方');
}
// 6. 声の選び方: Gemini の ID や既製の名前が来たら、既製の声から 女性 → 日本語で確かめられている声 の順に選ぶ
{
  const voices = [
    { voice_id: 'm'.repeat(20), name: 'Man', category: 'premade', labels: { gender: 'male' } },
    { voice_id: 'f'.repeat(20), name: 'Woman', category: 'premade', labels: { gender: 'female' } },
    { voice_id: 'j'.repeat(20), name: 'WomanJa', category: 'premade', labels: { gender: 'female' }, verified_languages: [{ language: 'ja', model_id: 'eleven_v4' }] },
    { voice_id: 'l'.repeat(20), name: 'Library', category: 'professional', labels: { gender: 'female' }, verified_languages: [{ language: 'ja' }] },
  ];
  assert.equal(E.pickVoice(voices).name, 'WomanJa');
  assert.equal(E.pickVoice(voices.slice(0, 2)).name, 'Woman');
  const urls = [];
  const f = async (url) => { urls.push(String(url)); return /\/v2\/voices/.test(url) ? new Response(JSON.stringify({ voices }), { status: 200 }) : okRes([pcm(1)]); };
  const warn = console.warn; console.warn = () => {};
  const r1 = await E.elevenVoiceStream({ text: 'はい', mood: 'calm', model: 'eleven_v4', voiceName: 'voice_n768ib2j6rqa', onChunk: () => {}, fetchImpl: f });
  const r2 = await E.elevenVoiceStream({ text: 'はい', mood: 'calm', model: 'eleven_v4', voiceName: 'Leda', onChunk: () => {}, fetchImpl: f });
  console.warn = warn;
  assert.equal(r1.voice, 'j'.repeat(20)); assert.equal(r2.voice, 'j'.repeat(20));
  assert.equal(urls.filter((u) => /\/v2\/voices/.test(u)).length, 1); // 声の一覧は 1 度しか取りに行かない
  process.env.ELEVENLABS_VOICE_ID = 'z'.repeat(20);
  const r3 = await E.elevenVoiceStream({ text: 'はい', mood: 'calm', model: 'eleven_v4', voiceName: VOICE, onChunk: () => {}, fetchImpl: f });
  assert.equal(r3.voice, 'z'.repeat(20)); delete process.env.ELEVENLABS_VOICE_ID;
  ok('声の選び方');
}
// 7. 文の整え方: 「……」の 3 通りと、指示の 3 通り
{
  assert.equal(E.forSpeechEleven('……あ、はい。<breath>……えっと', 'keep'), '……あ、はい。 ……えっと');
  assert.equal(E.forSpeechEleven('……あ、はい', 'ascii'), '...あ、はい');
  assert.equal(E.forSpeechEleven('……あ、はい……。', 'comma'), 'あ、はい。');
  assert.equal(E.elevenText({ text: 'はい', mood: 'calm', tag: 'none' }).sent, 'はい');
  assert.equal(E.elevenText({ text: 'はい', mood: 'shy', kind: 'line', intensity: 0.7, affection: 50, tag: 'en' }).sent, '[shy and flustered, slightly fast, no long pauses, hesitant, endings weaken] はい');
  assert.equal(E.elevenText({ text: 'はい', mood: 'calm', tag: 'ja', styleJa: '静かに' }).sent, '[静かに] はい');
  ok('文の整え方');
}
// 8. Gemini 側: 既定のままなら口もモデルも指示も変わらない（同梱の音声の名前が変わらない）。モデル名で口が分かれる
{
  delete process.env.TTS_PROVIDER; delete process.env.TTS_MODEL;
  const T = await import('./lib/tts.mjs');
  assert.equal(T.DEFAULT_TTS_MODEL, 'gemini-3.8-flash-tts');
  assert.equal(T.styleFor('shy', { kind: 'line', intensity: 0.7 }), T.styleForGemini('shy', { kind: 'line', intensity: 0.7 }));
  const urls = [];
  await T.voiceStream({ text: 'はい', mood: 'calm', model: 'eleven_v4_turbo', voiceName: VOICE, onChunk: () => {}, fetchImpl: async (url) => { urls.push(String(url)); return okRes([pcm(1)]); } });
  assert.match(urls[0], /api\.elevenlabs\.io/);
  ok('Gemini 側はそのまま');
}
console.log('OK: ' + n + ' 件');
