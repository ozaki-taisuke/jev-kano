/**
 * 声: Gemini 3.8 Flash TTS（Interactions API）。感情（mood）を speech_metadata.style に載せて読ませる。
 * 返り値は WAV の base64。GEMINI_API_KEY が無ければ呼ばない（呼び出し側で判定）。
 */
export const DEFAULT_TTS_MODEL = process.env.TTS_MODEL || 'gemini-3.8-flash-tts'; // Lite（gemini-3.8-flash-lite-tts）は安いが表現が薄い
export const DEFAULT_VOICE = process.env.TTS_VOICE || 'Leda'; // 既製の名前（Leda＝Youthful・Kore＝Firm…）か、design_voice.mjs で作った voice_… の ID
// 設計した声（voice_…）は作ったプロジェクトの鍵でしか使えない。別の鍵で「見つからない」と言われたら、既製の声に切り替えて以後はそれで読む
export const FALLBACK_VOICE = process.env.TTS_FALLBACK_VOICE || 'Leda';
const unavailableVoices = new Set();
export const resolveVoice = (v) => (unavailableVoices.has(v) ? FALLBACK_VOICE : v);
export const voiceUnavailable = (v) => unavailableVoices.has(v);
const isVoiceNotFound = (msg) => /voice was not found|does not have permission to access it|"not_found"/i.test(String(msg));
function markUnavailable(v) { if (v && v !== FALLBACK_VOICE && !unavailableVoices.has(v)) { unavailableVoices.add(v); console.warn('声 ' + v + ' はこの鍵では使えない（別のプロジェクトで設計した声）。既製の ' + FALLBACK_VOICE + ' で読む'); } }

// 声色 = 本音（反射で顔に出た感情）× 場合（不意に触れられた／言葉を受けた）× 強さ（Jev の確率）。同じ人のまま、テンションだけ変える
// 基本は小さく、抑揚が少ない。感情は声の奥ににじむ程度。好感度が上がると意思表示が段階的にはっきりする
// 声量は普通に聞き取れる大きさを保つ（「小さな声」と書くと本当に小さくなる）。控えめさは話し方（間・語尾・抑揚）で出す
/** 声に渡す文の整形。「……」は TTS が長い無音にする（冒頭 16.7 秒中 12.7 秒が無音）ので読点に。息のタグも外す */
export function forSpeech(text) {
  return String(text)
    .replace(/<(heavy )?breath>|<exhales>|<pant>/gi, ' ')
    .replace(/[…]{1,}/g, '、')
    .replace(/[、]{2,}/g, '、')
    .replace(/^[、。\s]+/, '')
    .replace(/、([。！？!?])/g, '$1')
    .replace(/([。！？!?])、/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
export const TTS_TEXT_VERSION = 'tts2';

// 「間を置いて」「言葉に詰まりながら」は TTS が長い無音にするので書かない。間は文の読点で作る
export const STYLE_BY_MOOD = {
  joy: '控えめに嬉しそうに。抑揚は少ないが、声ははっきり聞こえる大きさで。テンポは普通',
  shy: '恥ずかしそうに、少し早口で。声量は普通に聞き取れる大きさ。長い沈黙は入れない',
  puzzled: 'おろおろして、語尾が弱くなるように。声量は普通。テンポは落とさない',
  upset: '怖がりながらも拒む。声は低く、少し震えているが、はっきり聞こえる。テンポは普通',
  calm: '静かで抑揚が少なく、丁寧に。声量は普通。テンポは普通',
};
export const STYLE_ACTION = {
  joy: 'くすぐったそうに、控えめに笑って。声ははっきり',
  shy: '不意に触れられて息をのみ、少し裏返った声で。声量は普通。間は入れない',
  puzzled: '固まって、戸惑った声で。声量は普通',
  upset: '本気で嫌がって、震えながら。声は張らないが、はっきり聞こえる',
  calm: '少し驚いて、静かに。声量は普通',
};
/** 好感度 → 意思表示のはっきりさ。低いうちは曖昧で語尾が消える。仲良くなると言い切る */
export function clarity(affection) {
  if (affection == null) return '';
  if (affection < 45) return '。意思表示はとても曖昧で、語尾が弱く消える。ただし声量もテンポも落とさない';
  if (affection < 65) return '。意思表示は曖昧で、語尾が弱くなる。声量もテンポも落とさない';
  if (affection < 80) return '。少しだけ自分の気持ちが声に出て、語尾まで届く';
  return '。気持ちを込めて、最後まで言い切る。声も少し大きく';
}
export function styleFor(mood, { kind = 'line', intensity = null, affection = null } = {}) {
  let s = (kind === 'action' ? STYLE_ACTION : STYLE_BY_MOOD)[mood] || STYLE_BY_MOOD.calm;
  if (intensity != null) { if (intensity >= 0.8) s += '。感情はにじむ程度だが確かに'; else if (intensity < 0.5) s += '。ただし、ごくかすかに'; }
  return s + clarity(affection);
}

export async function voice({ text, mood, kind, intensity, affection, model = DEFAULT_TTS_MODEL, voiceName = DEFAULT_VOICE, fetchImpl = fetch }) {
  text = forSpeech(text); voiceName = resolveVoice(voiceName);
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY（または GOOGLE_API_KEY）がありません');
  const body = {
    model,
    input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: styleFor(mood, { kind, intensity, affection }) }] }] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice: voiceName }] },
  };
  const t0 = performance.now();
  const res = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const txt = await res.text();
  const ms = Math.round(performance.now() - t0);
  if (!res.ok || /"error"/.test(txt.slice(0, 40))) {
    if ((res.status === 429 || /rate limit/i.test(txt)) && model !== 'gemini-3.8-flash-lite-tts') return voice({ text, mood, kind, intensity, affection, model: 'gemini-3.8-flash-lite-tts', voiceName, fetchImpl });
    if (isVoiceNotFound(txt) && voiceName !== FALLBACK_VOICE) { markUnavailable(voiceName); return voice({ text, mood, kind, intensity, affection, model, voiceName: FALLBACK_VOICE, fetchImpl }); }
    throw new Error('TTS ' + res.status + ' ' + txt.slice(0, 200));
  }
  const r = JSON.parse(txt);
  // 音声は steps[].content[].data（base64）。最後の audio ブロックを取る
  let data = null, mime = 'audio/wav';
  for (const s of r.steps || []) for (const c of s.content || []) if (c.type === 'audio' && c.data) { data = c.data; mime = c.mime_type || mime; }
  if (!data && r.data) data = r.data;
  if (!data) throw new Error('TTS の応答に音声がありません: ' + txt.slice(0, 200));
  return { model, voice: voiceName, style: styleFor(mood, { kind, intensity, affection }), mime, base64: data, ms, chars: text.length };
}

/**
 * 声（ストリーミング）: 音声の断片（PCM 16bit・24kHz・モノラル）が届くたびに onChunk(Buffer) を呼ぶ。
 * 単発だと 4〜5 秒待つが、最初の断片は約 1 秒で来る（2026-09-27 実測）。
 */
export async function voiceStream({ text, mood, kind, intensity, affection, model = DEFAULT_TTS_MODEL, voiceName = DEFAULT_VOICE, onChunk, fetchImpl = fetch }) {
  text = forSpeech(text); voiceName = resolveVoice(voiceName);
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY（または GOOGLE_API_KEY）がありません');
  const body = {
    model,
    input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: styleFor(mood, { kind, intensity, affection }) }] }] }],
    response_format: { type: 'audio', mime_type: 'audio/l16' },
    generation_config: { speech_config: [{ voice: voiceName }] },
    stream: true,
  };
  const t0 = performance.now();
  const res = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    const m = txt.match(/limit: ([^.]+?)\)/);
    // 1 日の回数上限などで弾かれたら、Lite（別枠）で読み直す
    if (res.status === 429 && model !== 'gemini-3.8-flash-lite-tts') return voiceStream({ text, mood, kind, intensity, affection, model: 'gemini-3.8-flash-lite-tts', voiceName, onChunk, fetchImpl });
    if (isVoiceNotFound(txt) && voiceName !== FALLBACK_VOICE) { markUnavailable(voiceName); return voiceStream({ text, mood, kind, intensity, affection, model, voiceName: FALLBACK_VOICE, onChunk, fetchImpl }); }
    throw new Error('TTS ' + res.status + (m ? '（' + m[1] + '）' : ' ' + txt.slice(0, 160)));
  }
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '', first = null, bytes = 0, sampleRate = 24000, channels = 1, streamError = null;
  const handle = (ev) => {
    const data = ev.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data) return;
    let j; try { j = JSON.parse(data); } catch { return; }
    const d = j.delta;
    if (j.event_type === 'step.delta' && d && d.type === 'audio' && d.data) {
      if (d.sample_rate) sampleRate = d.sample_rate; if (d.channels) channels = d.channels;
      const chunk = Buffer.from(d.data, 'base64'); bytes += chunk.length;
      if (first == null) first = Math.round(performance.now() - t0);
      onChunk(chunk, { sampleRate, channels });
    } else if (j.error) streamError = 'TTS ' + (j.error.message || JSON.stringify(j.error)).slice(0, 200);
  };
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 2); }
  }
  if (buf.trim()) handle(buf);
  if (streamError && bytes === 0) {
    // 上限（本文で届く）なら Lite（別枠）で読み直す
    if (/rate limit|429/i.test(streamError) && model !== 'gemini-3.8-flash-lite-tts') return voiceStream({ text, mood, kind, intensity, affection, model: 'gemini-3.8-flash-lite-tts', voiceName, onChunk, fetchImpl });
    if (isVoiceNotFound(streamError) && voiceName !== FALLBACK_VOICE) { markUnavailable(voiceName); return voiceStream({ text, mood, kind, intensity, affection, model, voiceName: FALLBACK_VOICE, onChunk, fetchImpl }); }
    throw new Error(streamError);
  }
  return { model, voice: voiceName, style: styleFor(mood, { kind, intensity, affection }), sampleRate, channels, bytes, msFirst: first, ms: Math.round(performance.now() - t0), chars: text.length };
}
