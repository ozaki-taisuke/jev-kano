/**
 * 声（もう 1 つの口・試作）: ElevenLabs の Eleven v4 / v4 Turbo（2026-09-28 公開）。
 * Gemini の口（lib/tts.mjs）と同じ形の voice / voiceStream を持ち、モデル名が eleven_ で始まるときだけ tts.mjs から呼ばれる。
 *
 * Gemini との違い（2026-09-29 に公式の文書で確かめた範囲。★ は未実測）:
 *   - 演技指示は別の欄（speech_metadata.style）ではなく、文の頭の [ ] に書く。[ ] の中は読まれず、演技として受け取られる
 *   - 料金は文字数で決まる。[ ] の中も文字数に入る ★ → 指示は短く書く（短い一言では、指示のほうが台詞より長くなる）
 *   - 間は SSML（<break>）では作れない。句読点・「……」・[pause] で作る
 *   - 音は output_format=pcm_24000 で、Gemini と同じ生の PCM（16bit・24kHz・モノラル）。画面側はそのまま使える
 *   - 無料の口座でも API で読めるが、使える声は既製の声だけ（ライブラリの声は 402 paid_plan_required）。月 10,000 クレジット
 *   - 声（voice_id）は口座に結びつく。Gemini で設計した voice_… は使えないので、ELEVENLABS_VOICE_ID か、既製の声から自動で選ぶ
 */
export const ELEVEN_DEFAULT_MODEL = 'eleven_v4_turbo'; // 台詞は待たせないほうを既定に。作り置き（一言・冒頭・結末）を質で選ぶなら eleven_v4
export const isElevenModel = (m) => /^eleven_/i.test(String(m || ''));
const API = 'https://api.elevenlabs.io';
const SAMPLE_RATE = 24000;
export const elevenKey = () => process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY || '';

// ---- 演技指示（[ ] の中）。Gemini の STYLE_BY_MOOD / STYLE_ACTION と同じ意図を、短い英語で ----
// 英語にしたのは公式の例がすべて英語だから（[Quietly, with controlled fear] など）。日本語の指示が通るかは bench_tts.mjs の tag=ja で確かめる
const DIRECTION_LINE = {
  joy: 'quietly pleased, restrained, clear voice',
  shy: 'shy and flustered, slightly fast, no long pauses',
  puzzled: 'flustered, unsure, endings trail off, keeps pace',
  upset: 'frightened but refusing, low, slightly trembling, clear',
  calm: 'quiet, flat, polite, steady pace',
};
const DIRECTION_ACTION = {
  joy: 'ticklish, a small restrained laugh',
  shy: 'startled by a touch, catches her breath, voice cracks',
  puzzled: 'frozen, bewildered',
  upset: 'truly rejecting, trembling, not loud but clear',
  calm: 'slightly surprised, quiet',
};
// 短い指示（1〜2 語）。長い指示は、短い台詞で言葉のくり返しや言い直しを招いた（2026-09-29 実測: 「やめてください」が 2〜4 回、「ふふ」が 5 回）
const DIRECTION_SHORT = { joy: 'softly happy', shy: 'shy', puzzled: 'confused', upset: 'upset, quiet', calm: 'calm' };
/** 好感度 → 意思表示のはっきりさ（tts.mjs の clarity と同じ段階） */
function clarityEn(affection) {
  if (affection == null) return '';
  if (affection < 45) return ', very hesitant, endings fade';
  if (affection < 65) return ', hesitant, endings weaken';
  if (affection < 80) return ', a little feeling comes through';
  return ', speaks with feeling, finishes firmly';
}
export function elevenDirection(mood, { kind = 'line', intensity = null, affection = null } = {}) {
  let s = (kind === 'action' ? DIRECTION_ACTION : DIRECTION_LINE)[mood] || DIRECTION_LINE.calm;
  if (intensity != null) { if (intensity >= 0.8) s += ', subtle but unmistakable'; else if (intensity < 0.5) s += ', only faintly'; }
  return s + clarityEn(affection);
}
/** 既定の指示（キャッシュの名前に入るもの）。ELEVEN_TAG に合わせる */
export function elevenStyle(mood, opts = {}) { const t = process.env.ELEVEN_TAG || 'short'; return t === 'none' ? '' : t === 'en' ? elevenDirection(mood, opts) : (DIRECTION_SHORT[mood] || DIRECTION_SHORT.calm); }

/**
 * 声に渡す文。Gemini 用の forSpeech は「……」を読点に替える（Gemini は「……」を長い無音にするため）が、
 * v4 は「……」を間として扱うと公式が書いているので、既定ではそのまま渡す ★。比べるために 3 通りを選べる。
 *   keep＝そのまま ／ ascii＝「……」を ... に ／ comma＝Gemini と同じく読点に
 */
export function forSpeechEleven(text, ellipsis = process.env.ELEVEN_ELLIPSIS || 'keep') {
  let t = String(text).replace(/<(heavy )?breath>|<exhales>|<pant>|<gasp>/gi, ' ');
  if (ellipsis === 'comma') t = t.replace(/[…]{1,}/g, '、').replace(/[、]{2,}/g, '、').replace(/^[、。\s]+/, '').replace(/、([。！？!?])/g, '$1').replace(/([。！？!?])、/g, '$1');
  else if (ellipsis === 'ascii') t = t.replace(/[…]{1,}/g, '...');
  return t.replace(/\s{2,}/g, ' ').trim();
}
/** 実際に送る文（指示つき）。既定は short。tag: short＝英語で 1〜2 語 ／ en＝英語の長い指示（言葉のくり返しが出た） ／ ja＝Gemini と同じ日本語の指示（読み上げられた。使わない）／ none＝指示なし */
export function elevenText({ text, mood, kind, intensity, affection, tag = process.env.ELEVEN_TAG || 'short', ellipsis, styleJa = '' }) {
  const body = forSpeechEleven(text, ellipsis);
  const dir = tag === 'none' ? '' : tag === 'ja' ? styleJa : tag === 'short' ? (DIRECTION_SHORT[mood] || DIRECTION_SHORT.calm) : elevenDirection(mood, { kind, intensity, affection });
  return { sent: (dir ? '[' + dir + '] ' : '') + body, direction: dir, body };
}

// ---- 声 ----
const looksLikeElevenId = (v) => /^[A-Za-z0-9]{20}$/.test(String(v || ''));
let autoVoice = null; // 既製の声から選んだもの（1 度だけ問い合わせる）
export async function listVoices({ fetchImpl = fetch, pageSize = 100 } = {}) {
  const r = await fetchImpl(API + '/v2/voices?page_size=' + pageSize, { headers: { 'xi-api-key': elevenKey() } });
  const txt = await r.text();
  if (!r.ok) throw elevenError(r.status, txt);
  return (JSON.parse(txt).voices || []);
}
/** 既製の声から 1 つ選ぶ: 女性 → 日本語で確かめられている声 → 先頭。無料の口座で API から使えるのは既製（premade）だけ */
export function pickVoice(voices) {
  const pre = voices.filter((v) => v.category === 'premade');
  const pool = pre.length ? pre : voices;
  const female = pool.filter((v) => /female/i.test((v.labels || {}).gender || ''));
  const ja = (female.length ? female : pool).filter((v) => (v.verified_languages || []).some((l) => /^ja/i.test(l.language || l.locale || '')));
  return ja[0] || female[0] || pool[0] || null;
}
export async function resolveElevenVoice(voiceName, { fetchImpl = fetch } = {}) {
  if (process.env.ELEVENLABS_VOICE_ID) return process.env.ELEVENLABS_VOICE_ID;
  if (looksLikeElevenId(voiceName)) return voiceName;
  if (!autoVoice) {
    const v = pickVoice(await listVoices({ fetchImpl }));
    if (!v) throw new Error('ElevenLabs の口座に使える声がありません（ELEVENLABS_VOICE_ID を指定）');
    autoVoice = v.voice_id;
    console.warn('声: ELEVENLABS_VOICE_ID が無いので、既製の声 ' + v.name + '（' + v.voice_id + '）で読む。一覧は node eleven_voices.mjs --list');
  }
  return autoVoice;
}

// ---- 失敗の読み方 ----
function elevenError(status, txt) {
  let code = '', msg = String(txt).slice(0, 200);
  try { const d = JSON.parse(txt).detail; if (d && typeof d === 'object') { code = d.status || d.code || ''; msg = d.message || msg; } else if (typeof d === 'string') msg = d; } catch {}
  let hint = '';
  if (/quota_exceeded/i.test(code) || /quota/i.test(msg)) hint = '（月の枠を使い切った。per day の上限と同じ扱いで止める: retry in 6h）'; // server.mjs の noteTtsError が「per day … retry in」を読んで字幕モードに入る。server.mjs を触らないための言い回し
  else if (status === 402 || /paid_plan_required|payment_required/i.test(code)) hint = '（この声は無料の口座では API から使えない。既製の声を ELEVENLABS_VOICE_ID に）';
  else if (/voice_not_found/i.test(code)) hint = '（その voice_id がこの口座に無い）';
  else if (status === 401) hint = '（ELEVENLABS_API_KEY を確認）';
  const e = new Error('TTS ' + status + (code ? ' ' + code : '') + ' ' + msg + hint);
  e.status = status; e.code = code;
  return e;
}

// ---- PCM ----
/** 断片を 2 バイト単位にそろえ、必要なら音量を掛ける（画面側は Gemini の小さめの声に合わせて 2.6 倍しているので、大きすぎるときは ELEVEN_GAIN で下げる） */
function makePcmPipe(gain, onChunk) {
  let carry = null, bytes = 0;
  const emit = (buf) => {
    if (!buf.length) return;
    if (gain !== 1) { buf = Buffer.from(buf); for (let i = 0; i + 1 < buf.length; i += 2) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(buf.readInt16LE(i) * gain))), i); }
    bytes += buf.length; onChunk(buf, { sampleRate: SAMPLE_RATE, channels: 1 });
  };
  return {
    push(value) {
      let b = Buffer.from(value); if (carry) { b = Buffer.concat([carry, b]); carry = null; }
      if (b.length & 1) { carry = b.subarray(b.length - 1); b = b.subarray(0, b.length - 1); }
      emit(b);
    },
    end() { carry = null; return bytes; }, // 余った 1 バイトは半端なので捨てる
  };
}
export function wavFromPcm(pcm, rate = SAMPLE_RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const noLanguageCode = new Set(); // language_code を受け付けないモデル（400 が返ったら覚えて、以後は付けない）
/**
 * 声（ストリーミング）: PCM の断片が届くたびに onChunk(Buffer, { sampleRate, channels }) を呼ぶ。返り値の形は tts.mjs の voiceStream と同じ。
 * tag・ellipsis は比べるための切り替え（既定は環境変数 ELEVEN_TAG・ELEVEN_ELLIPSIS、無ければ en・keep）
 */
export async function elevenVoiceStream({ text, mood, kind, intensity, affection, model = ELEVEN_DEFAULT_MODEL, voiceName, onChunk, fetchImpl = fetch, tag, ellipsis, styleJa = '', gain = Number(process.env.ELEVEN_GAIN || 1) }) {
  if (!elevenKey()) throw new Error('ELEVENLABS_API_KEY がありません');
  const voiceId = await resolveElevenVoice(voiceName, { fetchImpl });
  const { sent, direction } = elevenText({ text, mood, kind, intensity, affection, tag, ellipsis, styleJa });
  const body = { text: sent, model_id: model };
  if (!noLanguageCode.has(model)) body.language_code = 'ja';
  const t0 = performance.now();
  const res = await fetchImpl(API + '/v1/text-to-speech/' + encodeURIComponent(voiceId) + '/stream?output_format=pcm_' + SAMPLE_RATE, {
    method: 'POST', headers: { 'xi-api-key': elevenKey(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    if (res.status === 400 && /language_code/i.test(txt) && body.language_code) { noLanguageCode.add(model); return elevenVoiceStream({ text, mood, kind, intensity, affection, model, voiceName, onChunk, fetchImpl, tag, ellipsis, styleJa, gain }); }
    throw elevenError(res.status, txt);
  }
  const headers = {}; for (const [k, v] of res.headers) if (/character|cost|credit|request-id|concurrent/i.test(k)) headers[k] = v; // 文字数・費用の知らせがあれば残す（名前は版で変わるので広めに拾う）
  const pipe = makePcmPipe(gain, onChunk); const reader = res.body.getReader(); let first = null;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    if (value && value.length) { if (first == null) first = Math.round(performance.now() - t0); pipe.push(value); }
  }
  const bytes = pipe.end();
  if (!bytes) throw new Error('TTS の応答に音声がありません');
  return { model, voice: voiceId, style: direction, sent, sampleRate: SAMPLE_RATE, channels: 1, bytes, msFirst: first, ms: Math.round(performance.now() - t0), chars: sent.length, headers };
}
/** 声（まとめて）: WAV の base64 を返す。tts.mjs の voice と同じ形 */
export async function elevenVoice(opts) {
  const chunks = [];
  const r = await elevenVoiceStream({ ...opts, onChunk: (c) => chunks.push(c) });
  return { model: r.model, voice: r.voice, style: r.style, mime: 'audio/wav', base64: wavFromPcm(Buffer.concat(chunks)).toString('base64'), ms: r.ms, chars: r.chars };
}
