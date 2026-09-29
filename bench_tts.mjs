#!/usr/bin/env node
/**
 * 声の聞き比べ: 同じ台詞・同じ本音を、声の口（Gemini・ElevenLabs・OpenAI）に読ませて並べる。
 *
 *   node bench_tts.mjs                    … 計画だけ（何本・何文字・いくら）。API は呼ばない
 *   node bench_tts.mjs --go               … 作る。作り済みのものは作り直さない（文・声・指示が同じなら）
 *   node bench_tts.mjs --go --systems eleven-v4,eleven-v4-turbo --lines opening,hya
 *   node bench_tts.mjs --go --probe       … probe の行だけ、演技指示の言語（en・ja・none）と「……」の扱い（keep・ascii・comma）も比べる（Eleven v4）
 *   node bench_tts.mjs --go --tag short --systems eleven-v4-turbo --only-variants   … 指示の書き方だけ替えたものを足す（short・none・ja）
 *   node bench_tts.mjs --page --with-probe   … 渡し方の比べ（指示の言語・「……」の扱い）も頁に出す。ふだんは出さない（聴く本数を増やさない）
 *   node bench_tts.mjs --page --round 2   … 聞き比べの回を替える（前の回に選んだものを頁に引き継がない）
 *   node bench_tts.mjs --page --hide openai-mini   … 頁に出さない口を決める（音と記録は残る。--hide だけで全部出す）
 *   node bench_tts.mjs --page             … 置いてある音を測り直して、頁と表だけ作り直す（API は呼ばない）
 *   node bench_tts.mjs --hear             … できた音を機械に聞き取らせて、台詞と比べる（OPENAI_API_KEY が要る。指示を読み上げていないか・余計な言葉が無いかの目安）
 *   node bench_tts.mjs --serve            … 頁を http://127.0.0.1:8795/ で開く（HOST=0.0.0.0 で同じ Wi-Fi のスマホからも。--port で変更）
 *   node bench_tts.mjs --archive          … 制作記録として残す写しを making/voices/eleven_v4/bench/ に作る（音は MP3 に。ffmpeg が要る）
 *
 * 鍵は .env か環境変数: GEMINI_API_KEY（GOOGLE_API_KEY）・ELEVENLABS_API_KEY・OPENAI_API_KEY。鍵の無い口は飛ばす。
 * ワークツリーから本体の .env を使うなら: node --env-file=../../../.env bench_tts.mjs
 * 結果: _out/tts_bench/ に WAV（元の音量と、そろえた音量）・results.json・results.md・index.html（名前を伏せて聴ける頁）
 *
 * 測るもの: 最初の音まで・全部届くまで・長さ・無音（頭・いちばん長い間・合計）・音量・文字数・費用。
 * 測らないもの: 良し悪し。それは頁で聴いて選ぶ。
 */
import './lib/env-load.mjs'; // .env を他の import より先に読む
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { voiceStream, styleForGemini, forSpeech, DEFAULT_VOICE } from './lib/tts.mjs';
import { elevenVoiceStream, elevenText, elevenKey, wavFromPcm } from './lib/tts_eleven.mjs';
import { renderPage } from './lib/bench_tts_page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const has = (k) => process.argv.includes(k);
const opt = (k, d) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const OUT = path.resolve(opt('--out', path.join(process.env.REFLEX_GALGE_OUT || path.join(here, '_out'), 'tts_bench')));
const GAP = Number(opt('--gap', 1200)); // 口ごとの呼び出しの間（ms）。1 分あたりの回数上限に当てない
const JPY = Number(opt('--jpy', 150)); // 1 ドル何円で見積もるか（仮の値）
const RATE = 24000;

const scenario = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'));
const geminiVoice = process.env.TTS_VOICE || ((scenario.voices || {})[(scenario.names || [])[0]] || {}).id || DEFAULT_VOICE;
const geminiKey = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

// 料金（2026-09-29 に各社の料金表で確かめた値。ドル）。Gemini は音の長さ（1 秒 25 トークン）、ElevenLabs は文字数、OpenAI は音の長さで決まる
//   Gemini 3.8 Flash TTS: 出力 $9.00 / 100 万トークン（2026 年末まで。2027 年から $18）。Lite は $6.00（同 $12）。入力は $0.50 / 100 万トークン
//   Eleven v4: $0.08 / 1,000 字（10/12 までは $0.022）。v4 Turbo: $0.04（同 $0.011）
//   GPT-4o mini TTS: 出力 $12 / 100 万トークン（1 分あたり約 $0.015）
const SYSTEMS = {
  'gemini-flash': { label: 'Gemini 3.8 Flash TTS', provider: 'gemini', model: 'gemini-3.8-flash-tts', voice: geminiVoice, key: geminiKey, keyName: 'GEMINI_API_KEY', usd: (c) => c.seconds * 25 * 9 / 1e6 + c.chars * 0.5 / 1e6 },
  'gemini-lite': { label: 'Gemini 3.8 Flash-Lite TTS', provider: 'gemini', model: 'gemini-3.8-flash-lite-tts', voice: geminiVoice, key: geminiKey, keyName: 'GEMINI_API_KEY', usd: (c) => c.seconds * 25 * 6 / 1e6 + c.chars * 0.5 / 1e6 },
  'eleven-v4': { label: 'Eleven v4', provider: 'eleven', model: 'eleven_v4', voice: process.env.ELEVENLABS_VOICE_ID || '（既製の声から自動）', key: elevenKey, keyName: 'ELEVENLABS_API_KEY', usd: (c) => c.chars * 0.08 / 1000, usdLaunch: (c) => c.chars * 0.022 / 1000 },
  'eleven-v4-turbo': { label: 'Eleven v4 Turbo', provider: 'eleven', model: 'eleven_v4_turbo', voice: process.env.ELEVENLABS_VOICE_ID || '（既製の声から自動）', key: elevenKey, keyName: 'ELEVENLABS_API_KEY', usd: (c) => c.chars * 0.04 / 1000, usdLaunch: (c) => c.chars * 0.011 / 1000 },
  'openai-mini': { label: 'GPT-4o mini TTS', provider: 'openai', model: 'gpt-4o-mini-tts', voice: process.env.OPENAI_TTS_VOICE || 'sage', key: () => process.env.OPENAI_API_KEY || '', keyName: 'OPENAI_API_KEY', usd: (c) => c.seconds * 0.015 / 60 },
  // 手元の PC で動かす口（日本語専用・MIT）。IRODORI_DIR に Irodori-TTS を置いたフォルダ（uv の環境つき）を指す。費用は電気代だけなので 0 と数える
  'irodori': { label: 'Irodori-TTS v4.1-Small（手元）', provider: 'irodori', model: process.env.IRODORI_CHECKPOINT || 'Aratako/Irodori-TTS-v4.1-Small', voice: '（説明文から・参照なし）', key: () => process.env.IRODORI_DIR || '', keyName: 'IRODORI_DIR', usd: () => 0 },
};
// Irodori に渡す声の説明（声 D と同じ向き）と、本音ごとの話し方。参照音声は使わない
const IRODORI_VOICE = process.env.IRODORI_CAPTION || '20代前半の日本人の女性。声は低めで落ち着いていて、抑揚が少なく、淡々と話す。内気で控えめ。';
const IRODORI_MOOD = { joy: '控えめに嬉しそうに話している。', shy: '恥ずかしそうに、少し早口で話している。', puzzled: '戸惑って、語尾が弱くなる。', upset: '怖がりながらも、はっきり拒んでいる。', calm: '静かに、丁寧に話している。' };
const DEFAULT_SYSTEMS = ['gemini-flash', 'eleven-v4', 'eleven-v4-turbo'];
const PROBE_SYSTEM = 'eleven-v4';
// 元（tag=short・ellipsis=keep）と比べる渡し方。「……」の 2 つは長い指示（en）のときに作ったので、そのまま en で
const PROBE_VARIANTS = [{ tag: 'en' }, { tag: 'ja' }, { tag: 'none' }, { tag: 'en', ellipsis: 'ascii' }, { tag: 'en', ellipsis: 'comma' }];
const variantName = (v) => (v ? Object.entries(v).map(([k, x]) => k + '=' + x).join(',') : '');

const allLines = JSON.parse(fs.readFileSync(path.join(here, 'bench_tts_lines.json'), 'utf8')).lines;
const wantLines = opt('--lines', '') ? opt('--lines', '').split(',') : null;
const lines = allLines.filter((l) => !wantLines || wantLines.includes(l.id));
const systems = (opt('--systems', '') ? opt('--systems', '').split(',') : DEFAULT_SYSTEMS).filter((s) => { if (!SYSTEMS[s]) { console.error('知らない口: ' + s + '（' + Object.keys(SYSTEMS).join('・') + '）'); process.exit(1); } return true; });

// ---- 何を作るか ----
const h8 = (parts) => createHash('sha1').update(parts.map(String).join('|')).digest('hex').slice(0, 8);
function sentOf(sys, line, variant) {
  const styleJa = styleForGemini(line.mood, line);
  if (sys.provider === 'eleven') { const t = elevenText({ ...line, ...(variant || {}), tag: (variant && variant.tag) || 'short', ellipsis: (variant && variant.ellipsis) || 'keep', styleJa }); return { sent: t.sent, style: t.direction, billed: t.sent.length }; }
  if (sys.provider === 'gemini') { const t = forSpeech(line.text); return { sent: t, style: styleJa, billed: t.length }; }
  if (sys.provider === 'irodori') return { sent: line.text, style: IRODORI_VOICE + (IRODORI_MOOD[line.mood] || ''), billed: line.text.length };
  return { sent: line.text, style: styleJa, billed: line.text.length };
}
function jobsOf() {
  const jobs = [];
  for (const line of lines) {
    for (const id of systems) jobs.push({ line, system: id, variant: null });
    if (opt('--tag', '')) for (const id of systems) if (SYSTEMS[id].provider === 'eleven') jobs.push({ line, system: id, variant: { tag: opt('--tag', '') } }); // 指示の書き方だけ替えて足す
    if (has('--probe') && line.probe && systems.includes(PROBE_SYSTEM)) for (const v of PROBE_VARIANTS) jobs.push({ line, system: PROBE_SYSTEM, variant: v });
  }
  if (has('--only-variants')) jobs.splice(0, jobs.length, ...jobs.filter((j) => j.variant));
  for (const j of jobs) {
    const sys = SYSTEMS[j.system]; const s = sentOf(sys, j.line, j.variant);
    Object.assign(j, s, { key: j.line.id + '__' + j.system + (j.variant ? '@' + variantName(j.variant).replace(/[=,]/g, '-') : '') + '__' + h8([sys.model, sys.voice, s.sent, s.style, j.line.mood, j.line.kind, j.line.intensity, j.line.affection]) });
  }
  return jobs;
}

// ---- 音を測る ----
const db = (x) => (x > 0 ? 20 * Math.log10(x / 32768) : -120);
export function analyze(pcm, rate = RATE) {
  const n = pcm.length >> 1, frame = Math.round(rate * 0.02), rms = []; let peak = 0;
  for (let i = 0; i + frame <= n; i += frame) { let s = 0; for (let j = 0; j < frame; j++) { const v = pcm.readInt16LE((i + j) * 2); s += v * v; if (v > peak) peak = v; else if (-v > peak) peak = -v; } rms.push(Math.sqrt(s / frame)); }
  const sorted = [...rms].sort((a, b) => a - b), p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const thr = Math.max(32768 * 10 ** (-55 / 20), p95 * 10 ** (-30 / 20)); // 無音の線: 大きいところから 30 dB 下（ただし -55 dB より下は無音）
  const voiced = rms.map((x) => x >= thr), first = voiced.indexOf(true), last = voiced.lastIndexOf(true);
  // 無音に数えるのは 0.1 秒以上続いたところだけ（子音の前の一瞬の閉じは数えない）。ffmpeg の silencedetect（-45dB・0.1 秒）とほぼ同じ値になる
  let longest = 0, silent = 0, run = 0;
  for (let i = 0; i <= voiced.length; i++) { if (i < voiced.length && !voiced[i]) { run++; continue; } if (run >= 5) { silent += run; if (i - run > first && i <= last && run > longest) longest = run; } run = 0; }
  const v = rms.filter((_, i) => voiced[i]), speech = v.length ? Math.sqrt(v.reduce((a, x) => a + x * x, 0) / v.length) : 0;
  const r2 = (x) => Math.round(x * 100) / 100;
  return { seconds: r2(n / rate), lead: r2(first < 0 ? n / rate : first * 0.02), trail: r2(last < 0 ? 0 : (rms.length - 1 - last) * 0.02), longestGap: r2(longest * 0.02), silence: r2(silent * 0.02), rmsDb: Math.round(db(speech) * 10) / 10, peakDb: Math.round(db(peak) * 10) / 10 };
}
/** 音量をそろえた写し（声のあるところの大きさを -23 dB に。割れない範囲で） */
function normalized(pcm, a, target = -23) {
  const g = Math.min(10 ** ((target - a.rmsDb) / 20), 10 ** ((-1 - a.peakDb) / 20));
  const out = Buffer.alloc(pcm.length & ~1);
  for (let i = 0; i + 1 < pcm.length; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * g))), i);
  return out;
}

// ---- 口ごとの呼び方 ----
async function openaiStream({ sent, style, model, voice, onChunk }) {
  const t0 = performance.now();
  const res = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, voice, input: sent, instructions: style, response_format: 'pcm' }) });
  if (!res.ok) throw new Error('TTS ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const reader = res.body.getReader(); let first = null, bytes = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; if (value && value.length) { if (first == null) first = Math.round(performance.now() - t0); bytes += value.length; onChunk(Buffer.from(value)); } }
  return { model, voice, msFirst: first, ms: Math.round(performance.now() - t0), bytes };
}
/**
 * 手元の Irodori-TTS。1 本ごとに infer.py を起動する（モデルの読み込みから）。
 * 「最初の音まで」には、読み込みを除いた合成の時間（infer.py が出す total_to_decode）を入れる。流しながらは返せないので、全部できてから最初の音。
 * 起動から終わりまでの時間は wallMs に残す。IRODORI_CACHE を指すと、uv・Hugging Face・一時ファイルの置き場をその下にする（C: に書かない）
 */
function irodoriRun({ sent, style, model, onChunk, key }) {
  return new Promise((resolve, reject) => {
    const wav = path.join(OUT, key + '.src.wav'), env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, cache = process.env.IRODORI_CACHE;
    if (cache) Object.assign(env, { UV_CACHE_DIR: path.join(cache, 'uv'), UV_PYTHON_INSTALL_DIR: path.join(cache, 'uv-python'), HF_HOME: path.join(cache, 'huggingface'), TMP: path.join(cache, 'tmp'), TEMP: path.join(cache, 'tmp') });
    const precision = process.env.IRODORI_PRECISION || 'fp32', t0 = performance.now(); let log = '';
    const p = spawn('uv', ['run', '--no-sync', 'python', 'infer.py', '--hf-checkpoint', model, '--text', sent, '--caption', style, '--no-ref', '--model-precision', precision, '--codec-precision', precision, '--seed', process.env.IRODORI_SEED || '0', '--output-wav', wav], { cwd: process.env.IRODORI_DIR, env, windowsHide: true });
    p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
    p.on('error', (e) => reject(new Error('Irodori を起動できない: ' + e.message)));
    p.on('close', (code) => {
      const wallMs = Math.round(performance.now() - t0);
      if (code !== 0 || !fs.existsSync(wav)) return reject(new Error('Irodori が失敗（' + code + '）: ' + log.trim().split(/\r?\n/).slice(-2).join(' / ').slice(0, 200)));
      try {
        const pcm = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', wav, '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], { maxBuffer: 64 * 1024 * 1024 }); fs.unlinkSync(wav); // 48 kHz → 他の口と同じ 24 kHz に
        const m = log.match(/total_to_decode:\s*([\d.]+)\s*s/), ms = m ? Math.round(Number(m[1]) * 1000) : wallMs;
        onChunk(pcm); resolve({ model, voice: '説明文から', msFirst: ms, ms, wallMs, bytes: pcm.length });
      } catch (e) { reject(e); }
    });
  });
}
async function run(job) {
  const sys = SYSTEMS[job.system], chunks = [], onChunk = (c) => chunks.push(c), l = job.line;
  const base = { text: l.text, mood: l.mood, kind: l.kind, intensity: l.intensity, affection: l.affection, model: sys.model, onChunk };
  let r;
  if (sys.provider === 'irodori') r = await irodoriRun({ sent: job.sent, style: job.style, model: sys.model, onChunk, key: job.key });
  else if (sys.provider === 'gemini') r = await voiceStream({ ...base, voiceName: sys.voice });
  else if (sys.provider === 'eleven') r = await elevenVoiceStream({ ...base, voiceName: process.env.ELEVENLABS_VOICE_ID || '', tag: (job.variant && job.variant.tag) || 'short', ellipsis: (job.variant && job.variant.ellipsis) || 'keep', styleJa: styleForGemini(l.mood, l) });
  else r = await openaiStream({ sent: job.sent, style: job.style, model: sys.model, voice: sys.voice, onChunk });
  let pcm = Buffer.concat(chunks); if (pcm.length & 1) pcm = pcm.subarray(0, pcm.length - 1);
  const a = analyze(pcm, r.sampleRate || RATE);
  const file = job.key + '.wav', normFile = job.key + '.norm.wav';
  fs.writeFileSync(path.join(OUT, file), wavFromPcm(pcm, r.sampleRate || RATE));
  fs.writeFileSync(path.join(OUT, normFile), wavFromPcm(normalized(pcm, a), r.sampleRate || RATE));
  const clip = { key: job.key, line: l.id, system: job.system, variant: variantName(job.variant), model: sys.model, modelUsed: r.model, voice: r.voice, sent: job.sent, style: job.style, chars: job.billed, msFirst: r.msFirst, ms: r.ms, wallMs: r.wallMs, ...a, file, normFile, headers: r.headers || undefined, at: new Date().toISOString() };
  clip.usd = sys.usd(clip); if (sys.usdLaunch) clip.usdLaunch = sys.usdLaunch(clip);
  return clip;
}

// ---- まとめ ----
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function summarize(clips) {
  return Object.keys(SYSTEMS).filter((id) => clips.some((c) => c.system === id)).map((id) => {
    const all = clips.filter((c) => c.system === id && !c.variant), ok = all.filter((c) => !c.error);
    return { id, label: SYSTEMS[id].label, n: ok.length, errors: all.length - ok.length, firstP50: pct(ok.map((c) => c.msFirst), 0.5), firstMax: ok.length ? Math.max(...ok.map((c) => c.msFirst)) : null, totalP50: pct(ok.map((c) => c.ms), 0.5), seconds: ok.reduce((a, c) => a + c.seconds, 0), silenceRatio: ok.length ? ok.reduce((a, c) => a + c.silence, 0) / ok.reduce((a, c) => a + c.seconds, 0) : null, rmsDb: mean(ok.map((c) => c.rmsDb)), chars: ok.reduce((a, c) => a + c.chars, 0), usd: ok.reduce((a, c) => a + c.usd, 0), usdPerLine: mean(ok.map((c) => c.usd)), usdLaunch: SYSTEMS[id].usdLaunch ? ok.reduce((a, c) => a + (c.usdLaunch || 0), 0) : null };
  });
}
const f = (x, n = 1) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(n));
function markdown(clips, summary) {
  let md = '| 口 | 本数 | 最初の音まで（中央） | 同（最大） | 全部届くまで（中央） | 無音の割合 | 音量 | 文字数 | 1 本あたり | 合計 |\n|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|\n';
  for (const s of summary) md += '| ' + s.label + ' | ' + s.n + (s.errors ? '（失敗 ' + s.errors + '）' : '') + ' | ' + (s.n ? s.firstP50 + ' ms' : '—') + ' | ' + (s.n ? s.firstMax + ' ms' : '—') + ' | ' + (s.n ? s.totalP50 + ' ms' : '—') + ' | ' + (s.n ? f(s.silenceRatio * 100, 0) + ' %' : '—') + ' | ' + (s.n ? f(s.rmsDb) + ' dB' : '—') + ' | ' + s.chars + ' | ' + (s.n ? f(s.usdPerLine * JPY, 3) + ' 円' : '—') + ' | ' + (s.n ? f(s.usd * JPY, 2) + ' 円' + (s.usdLaunch != null ? '（10/12 までは ' + f(s.usdLaunch * JPY, 2) + ' 円）' : '') : '—') + ' |\n';
  md += '\n| 台詞 | 口 | 渡し方 | 最初の音まで | 長さ | 頭の無音 | いちばん長い間 | 無音の合計 | 音量 | 文字数 |\n|:--|:--|:--|--:|--:|--:|--:|--:|--:|--:|\n';
  for (const l of allLines) for (const c of clips.filter((x) => x.line === l.id)) md += '| ' + l.id + ' | ' + SYSTEMS[c.system].label + ' | ' + (c.variant || '') + ' | ' + (c.error ? '失敗: ' + c.error.slice(0, 60) : c.msFirst + ' ms | ' + f(c.seconds, 2) + ' s | ' + f(c.lead, 2) + ' s | ' + f(c.longestGap, 2) + ' s | ' + f(c.silence, 2) + ' s | ' + f(c.rmsDb) + ' dB | ' + c.chars) + ' |\n';
  return md;
}
const PRICE_NOTE = '費用は 2026-09-29 の料金表からの見積もり（1 ドル ' + JPY + ' 円と仮定）。Gemini と OpenAI は音の長さ、ElevenLabs は文字数（[ ] の演技指示を含む）で決まる。Eleven v4 は 10/12 まで発売時の値引きがある（表は値引き前）。「最初の音まで」には日本からの通信の時間が入っている。';
function writeAll(store, dir = OUT) {
  if (opt('--round', '')) store.round = Number(opt('--round', 1)); // 何回目の聞き比べか。回を替えると、頁は前に選んだものを引き継がない（前の回を見て選ばないように）
  if (opt('--hide', null) != null) store.hidden = opt('--hide', '').split(',').filter((s) => SYSTEMS[s]); // 頁に出さない口（音と記録は残す）。--hide だけなら全部出す
  const order = (c) => allLines.findIndex((l) => l.id === c.line) * 100 + Object.keys(SYSTEMS).indexOf(c.system) * 10 + (c.variant ? 1 : 0);
  const clips = Object.values(store.clips).filter((c) => c.error || fs.existsSync(path.join(dir, c.file))).sort((a, b) => order(a) - order(b));
  const probeLines = new Set(clips.filter((c) => c.variant).map((c) => c.line));
  for (const c of clips) c.probeBase = !c.variant && c.system === PROBE_SYSTEM && probeLines.has(c.line);
  const summary = summarize(clips), md = markdown(clips, summary);
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(store, null, 1));
  fs.writeFileSync(path.join(dir, 'results.md'), md);
  const sys = Object.fromEntries(Object.entries(SYSTEMS).map(([k, v]) => [k, { label: v.label, model: v.model }]));
  fs.writeFileSync(path.join(dir, 'index.html'), renderPage({ showProbe: has('--with-probe'), hidden: store.hidden || [], runId: store.runId, round: store.round || 1, title: store.updated.slice(0, 10) + ' ・ ' + (store.round || 1) + ' 回目 ・ ' + summary.filter((s) => !(store.hidden || []).includes(s.id)).map((s) => s.label).join(' ／ '), jpy: JPY, priceNote: PRICE_NOTE, systems: sys, lines: allLines, clips, summary }));
  return { clips, summary, md };
}
/** 制作記録として残す写し: 音量をそろえた音だけを MP3（48 kbps）にして、頁・表と一緒に Git 管理のフォルダへ。WAV のままだと 1 本 0.2〜0.7 MB あり、元の音量と 2 通り持つと 100 本で 9 MB を超えたので */
function archive(store, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const copy = { ...store, clips: {} }; let n = 0;
  for (const [k, c] of Object.entries(store.clips)) {
    if (c.error) { copy.clips[k] = c; continue; }
    if (!fs.existsSync(path.join(OUT, c.file))) continue;
    const to = (name) => { const mp3 = name.replace(/\.norm\.wav$/, '.mp3'); execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(OUT, name), '-ac', '1', '-b:a', '48k', path.join(dir, mp3)]); return mp3; };
    const headers = c.headers ? Object.fromEntries(Object.entries(c.headers).filter(([h]) => /character|cost|credit/i.test(h))) : undefined; // 呼び出しの ID は残さない
    const mp3 = to(c.normFile); copy.clips[k] = { ...c, headers, file: mp3, normFile: mp3 }; n++; // 元の音量は rmsDb に数字で残っている
  }
  for (const f of fs.readdirSync(dir)) if (/\.mp3$/.test(f) && !Object.values(copy.clips).some((c) => c.file === f || c.normFile === f)) fs.unlinkSync(path.join(dir, f)); // 使わなくなった音は消す
  writeAll(copy, dir);
  console.log('写した: ' + n + ' 本 → ' + dir + '（聴くなら node bench_tts.mjs --serve --out ' + path.relative(here, dir).replace(/\\/g, '/') + '）');
}

// ---- 機械の聞き取り（目安）。良し悪しではなく、「台詞に無い言葉を言っていないか」を見る ----
const plainJa = (s) => String(s).normalize('NFKC').replace(/[s、。，．,.!?！？…・「」『』（）()[]ー〜~っッ]/g, '');
async function hear(store) {
  const key = process.env.OPENAI_API_KEY; if (!key) { console.error('OPENAI_API_KEY がありません'); return; }
  const model = process.env.HEAR_MODEL || 'gpt-4o-mini-transcribe';
  const todo = Object.values(store.clips).filter((c) => !c.error && c.heard == null && fs.existsSync(path.join(OUT, c.file)));
  console.log('聞き取り: ' + todo.length + ' 本（' + model + '・合計 ' + f(todo.reduce((a, c) => a + c.seconds, 0) / 60, 1) + ' 分）');
  for (const c of todo) {
    const form = new FormData(); form.append('model', model); form.append('language', 'ja'); form.append('file', new Blob([fs.readFileSync(path.join(OUT, c.file))], { type: 'audio/wav' }), 'a.wav');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form });
    if (!r.ok) { console.log('  ' + c.key + ' ×  ' + r.status + ' ' + (await r.text()).slice(0, 120)); continue; }
    c.heard = (await r.json()).text || '';
    const line = allLines.find((l) => l.id === c.line), want = plainJa(line.text), got = plainJa(c.heard);
    c.heardExtra = Math.max(0, got.length - want.length); // 台詞より何字多く聞こえたか（かなに直していないので目安）
    console.log('  ' + (c.line + ' ' + SYSTEMS[c.system].label + (c.variant ? '（' + c.variant + '）' : '')).padEnd(46) + ' 「' + c.heard + '」');
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(store, null, 1));
  }
}

// ---- 頁を配る（結果のフォルダの直下にある頁・音・表だけを返す） ----
function serve() {
  const TYPES = { '.html': 'text/html; charset=utf-8', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
  const port = Number(opt('--port', process.env.BENCH_PORT || 8795)), host = process.env.HOST || '127.0.0.1';
  http.createServer((req, res) => {
    let name = 'index.html';
    try { name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html'; } catch {}
    const file = path.join(OUT, name), type = TYPES[path.extname(name).toLowerCase()];
    if (!type || path.dirname(file) !== OUT || !fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    const size = fs.statSync(file).size, m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) { // 音の途中から聴けるように
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': 'bytes ' + start + '-' + end + '/' + size, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }).listen(port, host, () => console.log('声の聞き比べ http://127.0.0.1:' + port + '/' + (host === '0.0.0.0' ? '  ／ 同じ Wi-Fi のスマホからは http://（PC の IP）:' + port + '/' : '  （スマホから聴くなら HOST=0.0.0.0）') + '\n  フォルダ: ' + OUT));
}

// ---- 実行 ----
if (import.meta.url === pathToFileURL(process.argv[1]).href) { // 直接起動したときだけ動く（analyze を他から使えるように）
  fs.mkdirSync(OUT, { recursive: true });
  const storeFile = path.join(OUT, 'results.json');
  let store = { runId: h8([Date.now()]), updated: new Date().toISOString(), clips: {} };
  try { store = JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch {}
  if (has('--serve')) { serve(); await new Promise(() => {}); } // 止めるまで配り続ける
  if (has('--hear')) { await hear(store); writeAll(store); process.exit(0); }
  if (has('--archive')) { archive(store, path.resolve(opt('--archive', path.join(here, 'making', 'voices', 'eleven_v4', 'bench')))); process.exit(0); }
  if (has('--page')) { // 置いてある WAV を測り直して、頁と表を作り直す（測り方や料金を直したとき用）
    for (const c of Object.values(store.clips)) {
      if (c.error || !fs.existsSync(path.join(OUT, c.file))) continue;
      const pcm = fs.readFileSync(path.join(OUT, c.file)).subarray(44); Object.assign(c, analyze(pcm, RATE));
      fs.writeFileSync(path.join(OUT, c.normFile), wavFromPcm(normalized(pcm, c), RATE));
      c.usd = SYSTEMS[c.system].usd(c); if (SYSTEMS[c.system].usdLaunch) c.usdLaunch = SYSTEMS[c.system].usdLaunch(c);
    }
    const { md } = writeAll(store); console.log(md); console.log('頁: ' + path.join(OUT, 'index.html')); process.exit(0);
  }

  const jobs = jobsOf();
  const done = (j) => !has('--fresh') && store.clips[j.key] && !store.clips[j.key].error && fs.existsSync(path.join(OUT, store.clips[j.key].file));
  const todo = jobs.filter((j) => !done(j));
  console.log('声の聞き比べ: 台詞 ' + lines.length + ' 本 × 口 ' + systems.length + (has('--probe') ? ' ＋ 渡し方の比べ' : '') + ' ＝ ' + jobs.length + ' 本（作り済み ' + (jobs.length - todo.length) + '・これから ' + todo.length + '）\n');
  console.log('| 口 | 鍵 | これから作る | 送る文字数 | 見込みの費用 |\n|:--|:--|--:|--:|--:|');
  for (const id of systems) {
    const sys = SYSTEMS[id], mine = todo.filter((j) => j.system === id), chars = mine.reduce((a, j) => a + j.billed, 0);
    const guess = mine.reduce((a, j) => a + sys.usd({ chars: j.billed, seconds: Math.max(1, j.line.text.length / 5) }), 0); // 長さの見込みは 1 秒 5 字（間の多い台詞なので遅め）
    console.log('| ' + sys.label + ' | ' + (sys.key() ? 'あり' : '**なし**（' + sys.keyName + '）→ 飛ばす') + ' | ' + mine.length + ' | ' + chars + ' | 約 ' + f(guess * JPY, 2) + ' 円 |');
  }
  if (!has('--go')) { console.log('\nここまでが計画（API は呼んでいない）。作るなら --go を付ける。'); process.exit(0); }

  const dead = new Set(systems.filter((id) => !SYSTEMS[id].key())); const last = {}; let made = 0, failed = 0;
  for (const j of todo) {
    if (dead.has(j.system)) continue;
    const p = SYSTEMS[j.system].provider, wait = GAP - (Date.now() - (last[p] || 0)); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      const c = await run(j); store.clips[j.key] = c; made++;
      console.log('  ' + j.line.id.padEnd(10) + ' ' + (SYSTEMS[j.system].label + (j.variant ? '（' + variantName(j.variant) + '）' : '')).padEnd(34) + ' 最初の音 ' + String(c.msFirst).padStart(5) + ' ms・長さ ' + f(c.seconds, 2).padStart(5) + ' s・無音 ' + f(c.silence, 2).padStart(5) + ' s' + (c.modelUsed !== c.model ? '  ※ 実際は ' + c.modelUsed : ''));
    } catch (e) {
      failed++; store.clips[j.key] = { key: j.key, line: j.line.id, system: j.system, variant: variantName(j.variant), model: SYSTEMS[j.system].model, sent: j.sent, chars: j.billed, error: e.message, at: new Date().toISOString() };
      console.log('  ' + j.line.id.padEnd(10) + ' ' + SYSTEMS[j.system].label + ' ×  ' + e.message.slice(0, 160));
      if (/\b(401|402|403)\b|quota|per day/i.test(e.message)) { dead.add(j.system); console.log('    → この口は以後飛ばす'); } // 鍵・枠・声の問題は、続けても同じ
    }
    last[p] = Date.now(); store.updated = new Date().toISOString();
    fs.writeFileSync(storeFile, JSON.stringify(store, null, 1)); // 途中で止めても、作ったぶんは残る
  }
  const { md } = writeAll(store);
  console.log('\n' + md);
  console.log('作った ' + made + ' 本・失敗 ' + failed + ' 本。頁: ' + path.join(OUT, 'index.html'));
}
