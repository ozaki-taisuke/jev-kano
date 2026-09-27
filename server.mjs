#!/usr/bin/env node
/**
 * #Jevカノ — 中継サーバー（API キーをブラウザに出さないためのもの）
 *
 *   node server.mjs           → http://127.0.0.1:8792/
 *
 * 四層: 反射（Jev・/api/reflex）→ 一言（固定の音声・/api/sfx/:mood）→ 言葉（LLM・/api/words）→ 声（Gemini TTS・/api/voice/stream）。
 * 反射で出た本音を、言葉と声にも渡して、時間差はあっても同じ人物の中でそろえる。
 * 各ターンの計測は /api/log で _out/turns.jsonl に追記（入力した台詞も残る。自分で遊ぶ前提）。
 */
import './lib/env-load.mjs'; // .env を他の import より先に読む（TTS_VOICE などの既定値のため）
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.mjs';
import { reflex, judgeReply } from './lib/jev.mjs';
import { words, DEFAULT_MODEL } from './lib/llm.mjs';
import { voice, voiceStream, DEFAULT_TTS_MODEL, DEFAULT_VOICE } from './lib/tts.mjs';
import { INTERJECTIONS, MOODS, TIER_INTENSITY, tierOf, FALLBACK_LINES } from './lib/criteria.mjs';
import { forSpeech } from './lib/tts.mjs';
import { sfxName, sfxText, fixedName, fixedTexts as fixedTextsOf, fixedMood as fixedMoodOf } from './lib/names.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(here, '.env'));

const PORT = Number(process.env.PORT || 8792);
// HOST=0.0.0.0 で同じ Wi-Fi のスマホから遊べる（http://PC の IP:8792/）。PUBLIC=1 は公開サーバー（遊ぶ側の口にも回数の守り）
const PUBLIC = process.env.PUBLIC === '1';
const HOST = process.env.HOST || ((process.env.VOICE_RELAY === '1' || PUBLIC) ? '0.0.0.0' : '127.0.0.1');
const OUT = process.env.REFLEX_GALGE_OUT || path.join(here, '_out');
fs.mkdirSync(OUT, { recursive: true });
const scenario = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'));
const INDEX = path.join(here, 'public', 'index.html');

// 声の 1 日の上限に当たったら、戻る時刻まで Gemini を呼びに行かない（無駄撃ちと待ち時間を避ける）。画面は字幕モードへ
let ttsLimitUntil = 0;
function noteTtsError(e) {
  const m = String(e && e.message || '').match(/per day.*?retry in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
  if (m) ttsLimitUntil = Date.now() + (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000;
}
const ttsDown = () => Date.now() < ttsLimitUntil;
const ttsRetryIn = () => { const s = Math.max(0, Math.round((ttsLimitUntil - Date.now()) / 1000)); return s >= 3600 ? Math.round(s / 3600) + 'h' : Math.ceil(s / 60) + 'm'; };
// 声の中継。RELAY_URL: この（遊ぶ人の）サーバーは声を作者の中継サーバーに頼む（自分の Gemini の鍵は要らない。声は作者の設計した声のまま）
// VOICE_RELAY=1: この起動は中継サーバー（声の口だけを公開。Jev・Claude・画面は出さない）。Cloud Run などに置く
const RELAY_URL = (process.env.VOICE_RELAY_URL || '').replace(/\/+$/, '');
const RELAY = process.env.VOICE_RELAY === '1';
const has = { jev: !!process.env.TYPESAFE_API_KEY, llm: !!process.env.ANTHROPIC_API_KEY, tts: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) || !!RELAY_URL };
// 中継サーバーの守り: 1 人（IP）あたり 10 分に N 回、全体で 1 日 M 回、文は 200 字まで、任意の合言葉
const RELAY_PER_IP = Number(process.env.RELAY_PER_IP_10MIN || 30), RELAY_DAILY_CAP = Number(process.env.RELAY_DAILY_CAP || 400), RELAY_TOKEN = process.env.RELAY_TOKEN || '';
// 反射だけの緩い守り（先読みが 0.35 秒ごとに来るので多め）: 1 人 10 分 600 回
const reflexHits = new Map();
function reflexAllow(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(); const hits = (reflexHits.get(ip) || []).filter((t) => now - t < 600000);
  if (hits.length >= 600) return '反射の回数が多すぎる。少し待って';
  hits.push(now); reflexHits.set(ip, hits); return null;
}
const ipHits = new Map(); let dayKey = '', dayCount = 0;
function relayAllow(req) {
  if (RELAY_TOKEN && req.headers['x-relay-token'] !== RELAY_TOKEN) return '合言葉が違う';
  const today = new Date().toISOString().slice(0, 10); if (today !== dayKey) { dayKey = today; dayCount = 0; ipHits.clear(); }
  if (dayCount >= RELAY_DAILY_CAP) return '今日の中継の上限（全体）に達した';
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(); const hits = (ipHits.get(ip) || []).filter((t) => now - t < 600000);
  if (hits.length >= RELAY_PER_IP) return '10 分あたりの回数が多すぎる。少し待って';
  hits.push(now); ipHits.set(ip, hits); dayCount++;
  return null;
}
/** 遊ぶ人のサーバーから中継サーバーへ（GET は音声を丸ごと、POST は流れをそのまま返す） */
async function relayFetch(pathAndQuery, init = {}) {
  const headers = { ...(init.headers || {}) }; if (RELAY_TOKEN) headers['x-relay-token'] = RELAY_TOKEN;
  return fetch(RELAY_URL + pathAndQuery, { ...init, headers });
}

// 顔の画像（任意）: public/faces/{joy,shy,puzzled,upset,calm}.(png|webp|jpg) があれば SVG の代わりに使う
const FACES_DIR = path.join(here, 'public', 'faces');
const MIME = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
function faceImages() {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(FACES_DIR); } catch { return out; }
  for (const f of files) { const m = f.match(/^(joy|shy|puzzled|upset|calm)(_strong)?\.(png|webp|jpe?g)$/i); if (m) { const k = m[1].toLowerCase() + (m[2] || ''); if (!out[k]) out[k] = '/faces/' + f; } }
  // 切り抜き用（背景が一様な緑）。public/faces/green/ にあれば画面側で緑を透明にして背景の上に立たせる
  let greens = []; try { greens = fs.readdirSync(path.join(FACES_DIR, 'green')); } catch {}
  for (const f of greens) { const m = f.match(/^(joy|shy|puzzled|upset|calm)(_strong)?\.(png|webp|jpe?g)$/i); if (m) { out.green = out.green || {}; out.green[m[1].toLowerCase() + (m[2] || '')] = '/faces/green/' + f; } }
  return out;
}

// 背景の絵（任意）: public/bg/*.jpg。id → URL
function bgImages() {
  const out = {}; let files = [];
  try { files = fs.readdirSync(path.join(here, 'public', 'bg')); } catch { return out; }
  for (const f of files) { const m = f.match(/^([a-z0-9_-]+)\.(png|webp|jpe?g)$/i); if (m) out[m[1]] = '/bg/' + f; }
  return out;
}
// 反射の一言の音声（本音ごとに 1 度だけ TTS して _out/sfx/ に PCM で置く。2 度目からはディスクから即返す）
const SFX_DIR = path.join(OUT, 'sfx');
const sfxPending = {};
const SFX_BUNDLED = path.join(here, 'public', 'sfx'); // 同梱の一言（Git 管理）。API が無くても鳴る
// 名前 → 声（scenario.voices）。無ければ既定の声
// 名前 → 声。.env の TTS_VOICE があればそれを全員に（自分で設計した声・既製の名前）。無ければ scenario.voices（作者のプロジェクトの声。別の鍵では既製の声に自動で切り替わる）
const voiceFor = (heroineName) => process.env.TTS_VOICE || ((scenario.voices || {})[heroineName] || {}).id || DEFAULT_VOICE;
const MAIN_VOICE = voiceFor((scenario.names || [])[0] || scenario.persona['名前']);
const sfxFile = (kind, mood, tier, voice) => path.join(SFX_DIR, sfxName(kind, mood, tier, voice));
const sfxExisting = (kind, mood, tier, voice) => [path.join(SFX_BUNDLED, sfxName(kind, mood, tier, voice)), sfxFile(kind, mood, tier, voice)].find((f) => fs.existsSync(f));
async function sfxPcm(kind, mood, tier, voice = DEFAULT_VOICE) {
  if (!forSpeech(sfxText(kind, mood, tier))) return { buf: Buffer.alloc(0), rate: 24000, silent: true }; // 「……」だけの一言は無音
  const key = kind + '_' + mood + '_' + tier + '_' + voice;
  const file = sfxFile(kind, mood, tier, voice);
  const have = sfxExisting(kind, mood, tier, voice);
  if (have) return { buf: fs.readFileSync(have), rate: 24000 };
  if (RELAY_URL && !RELAY) { // 中継から取って手元に置く
    const r = await relayFetch('/api/sfx/' + kind + '/' + mood + '/' + tier);
    if (!r.ok) throw new Error('中継 ' + r.status + ' ' + (await r.text()).slice(0, 120));
    const buf = Buffer.from(await r.arrayBuffer()); fs.mkdirSync(SFX_DIR, { recursive: true }); fs.writeFileSync(file, buf);
    return { buf, rate: Number(r.headers.get('X-Sample-Rate')) || 24000 };
  }
  if (ttsDown()) throw new Error('声は今日の上限に達しています（あと ' + ttsRetryIn() + '）');
  if (!sfxPending[key]) {
    sfxPending[key] = (async () => {
      const chunks = []; let rate = 24000;
      await voiceStream({ text: sfxText(kind, mood, tier), mood, kind, intensity: TIER_INTENSITY[tier], voiceName: voice, onChunk: (c, m) => { chunks.push(c); rate = m.sampleRate; } });
      const buf = Buffer.concat(chunks);
      fs.mkdirSync(SFX_DIR, { recursive: true }); fs.writeFileSync(file, buf);
      return { buf, rate };
    })().catch((e) => { noteTtsError(e); throw e; }).finally(() => { delete sfxPending[key]; });
  }
  return sfxPending[key];
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const clean = (s, n) => String(s || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n);
function sanitizeHistory(h) {
  return (Array.isArray(h) ? h : []).slice(-12).map((x) => ({ role: x.role === 'user' ? 'user' : 'assistant', text: clean(x.text, 200) }));
}
const episodeOf = (id) => (scenario.episodes || []).find((e) => e.id === id) || (scenario.episodes || [])[0] || null;
function turnInput(b) {
  const action = (scenario.actions || []).find((a) => a.id === b.action) || null;
  const ep = episodeOf(b.episode);
  const heroineName = (scenario.names || []).includes(b.heroineName) ? b.heroineName : scenario.persona['名前'];
  const playerName = clean(b.playerName, 20) || 'あなた';
  const topics = (Array.isArray(b.topics) ? b.topics : []).filter((t) => ['book', 'cook', 'stage', 'circle'].includes(t)).slice(0, 4);
  const persona = { ...scenario.persona, '名前': heroineName };
  // 直前から同じ行為が何回続いたか（履歴の user 側を新しい方から数える）
  let repeat = 0;
  if (action) {
    const users = sanitizeHistory(b.history).filter((h) => h.role === 'user');
    for (let i = users.length - 1; i >= 0; i--) { if (users[i].text === '（' + action.label + '）') repeat++; else break; }
  }
  return {
    repeat,
    heroineName, playerName, topics, playerRole: scenario.playerRole || '',
    episode: ep ? ep.id : null,
    initiative: b.initiative === true,
    probe: b.probe === true,
    said: clean(b.said, 40),
    persona,
    scene: (ep && ep.scene) || scenario.scene,
    history: sanitizeHistory(b.history),
    playerLine: action ? '（行為: ' + action.label + '。' + (action.detail || '') + '）' : clean(b.line, 200),
    action,
    affection: Math.max(0, Math.min(100, Number(b.affection) || scenario.startAffection)),
    moodHint: MOODS[b.mood] ? b.mood : null,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (RELAY) { // 中継サーバー: 声の口だけ
      if (url.pathname === '/healthz') return send(res, 200, { ok: true, relay: true });
      const open = ['/api/voice/stream', '/api/fixed', '/api/sfx-status'];
      if (!open.includes(url.pathname) && !url.pathname.startsWith('/api/sfx/')) return send(res, 404, { error: 'この口は中継していない' });
      if (url.pathname === '/api/voice/stream') { const why = relayAllow(req); if (why) return send(res, 429, { error: why }); }
      else if (RELAY_TOKEN && req.headers['x-relay-token'] !== RELAY_TOKEN) return send(res, 401, { error: '合言葉が違う' });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(INDEX));
    }
    if (req.method === 'GET' && url.pathname === '/rig') { // 実験: 簡易リグを本番の描画と並べて比較する頁（本体は変えない）
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(here, 'public', 'rig.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, { app: { env: process.env.APP_ENV || 'local', rev: process.env.APP_REV || '' }, has, ttsDown: ttsDown(), ttsRetryIn: ttsDown() ? ttsRetryIn() : null, llmModel: DEFAULT_MODEL, ttsModel: DEFAULT_TTS_MODEL, ttsVoice: DEFAULT_VOICE, scenario, faces: faceImages(), backgrounds: bgImages(), interjections: INTERJECTIONS, tiers: [0.6, 0.85], sfxReady: sfxStatus(MAIN_VOICE).ready.length, fallbackLines: FALLBACK_LINES, voices: scenario.voices || {} });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/faces/')) {
      const name = path.basename(url.pathname); const ext = path.extname(name).toLowerCase(); const sub = url.pathname.startsWith('/faces/green/') ? 'green' : '';
      if (!MIME[ext] || !/^(joy|shy|puzzled|upset|calm)(_strong)?\./i.test(name)) return send(res, 404, { error: 'not found' });
      try { const buf = fs.readFileSync(path.join(FACES_DIR, sub, name)); res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'public, max-age=600' }); return res.end(buf); }
      catch { return send(res, 404, { error: 'not found' }); }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/bg/')) {
      const name = path.basename(url.pathname); const ext = path.extname(name).toLowerCase();
      if (!MIME[ext] || !/^[a-z0-9_-]+\.(png|webp|jpe?g)$/i.test(name)) return send(res, 404, { error: 'not found' });
      try { const buf = fs.readFileSync(path.join(here, 'public', 'bg', name)); res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'public, max-age=3600' }); return res.end(buf); }
      catch { return send(res, 404, { error: 'not found' }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/fixed') {
      const text = url.searchParams.get('text') || ''; const mood = MOODS[url.searchParams.get('mood')] ? url.searchParams.get('mood') : 'calm';
      if (!fixedTexts().includes(text)) return send(res, 404, { error: 'その台詞は決まった台詞ではない' });
      const voice = voiceFor(url.searchParams.get('heroine'));
      if (!has.tts && !fs.existsSync(path.join(SFX_BUNDLED, fixedName(text, mood, voice)))) return send(res, 503, { error: 'GEMINI_API_KEY がありません' });
      try { const { buf, rate } = await fixedPcm(text, mood, voice); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Sample-Rate': String(rate) }); return res.end(buf); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/sfx-status') return send(res, 200, sfxStatus(voiceFor(url.searchParams.get('heroine'))));
    if (req.method === 'GET' && url.pathname.startsWith('/api/sfx/')) {
      const [kind, mood, t] = url.pathname.slice('/api/sfx/'.length).split('/');
      const tier = Math.max(0, Math.min(2, Number(t) || 0));
      const voice = voiceFor(url.searchParams.get('heroine'));
      if (!sfxText(kind, mood, tier)) return send(res, 404, { error: 'この場合に一言はない' });
      if (!has.tts && !sfxExisting(kind, mood, tier, voice)) return send(res, 503, { error: 'GEMINI_API_KEY がありません' });
      try {
        const { buf, rate } = await sfxPcm(kind, mood, tier, voice);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Sample-Rate': String(rate), 'X-Text': encodeURIComponent(sfxText(kind, mood, tier)) });
        return res.end(buf);
      } catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
    // 公開サーバーの守りは「手」で数える: 言葉の生成（/api/words）だけを 1 人・全体の上限に数える。反射（先読み含む）と声は数えない（反射は 1 回 0.005 円、声は言葉と対）
    if (PUBLIC && url.pathname === '/api/words') { const why = relayAllow(req); if (why) return send(res, 429, { error: why }); }
    if (PUBLIC && url.pathname === '/api/reflex') { const why = reflexAllow(req); if (why) return send(res, 429, { error: why }); }
    const b = await readBody(req);

    if (url.pathname === '/api/reflex') {
      if (!has.jev) return send(res, 503, { error: 'TYPESAFE_API_KEY がありません' });
      const inp = turnInput(b);
      if (!inp.playerLine) return send(res, 400, { error: '台詞が空です' });
      const lastHer = [...inp.history].reverse().find((h) => h.role === 'assistant');
      const [r, att] = await Promise.all([reflex(inp), (inp.probe && !inp.action && lastHer) ? judgeReply({ question: lastHer.text, reply: inp.playerLine }).catch(() => null) : Promise.resolve(null)]);
      delete r.raw;
      if (att) r.attitude = att;
      // ゲームの決まり: 同じ行為を続けて 3 回目以降は、本音が何であれ怒る（意図的な繰り返し）
      if (inp.action && inp.repeat >= 2 && r.mood !== 'upset') { r.moodByJev = r.mood; r.mood = 'upset'; r.forced = 'repeat'; r.deltaRound = Math.min(r.deltaRound, -1); r.hurt = Math.max(r.hurt ?? 0, 0.9); r.moodProbs.upset = Math.max(r.moodProbs.upset || 0, 0.9); }
      r.repeat = inp.repeat;
      if (inp.probe && !inp.action && att) {
        const p = att.probs || {}; const bad = (p.deflect || 0) + (p.tease || 0) + (p.flatter || 0);
        if (bad >= 0.6) { r.moodByJev = r.mood; r.mood = 'upset'; r.forced = 'dismiss'; r.deltaRound = -2; r.hurt = Math.max(r.hurt ?? 0, 0.85); r.moodProbs.upset = Math.max(r.moodProbs.upset || 0, 0.9); }
        else if ((p.sincere || 0) >= 0.6) { r.sincere = true; r.deltaRound = Math.min(2, Math.max(r.deltaRound, 1) + 1); }
      }
      r.tier = tierOf(r.moodProbs[r.mood] || 0);
      return send(res, 200, r);
    }
    if (url.pathname === '/api/words') {
      if (!has.llm) return send(res, 503, { error: 'ANTHROPIC_API_KEY がありません' });
      const inp = turnInput(b);
      if (!inp.playerLine && !inp.initiative) return send(res, 400, { error: '台詞が空です' });
      if (inp.initiative) inp.playerLine = '（彼女から話を振る番）';
      return send(res, 200, await words(inp));
    }
    if (url.pathname === '/api/voice/stream') {
      if (!has.tts) return send(res, 503, { error: 'GEMINI_API_KEY がありません' });
      const text = clean(b.text, 200);
      if (!text) return send(res, 400, { error: '読む台詞が空です' });
      if (RELAY_URL && !RELAY) { // 遊ぶ人のサーバー: 中継へそのまま流す
        try {
          const r = await relayFetch('/api/voice/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, mood: b.mood, kind: b.kind, intensity: b.intensity, affection: b.affection, heroineName: b.heroineName }) });
          if (!r.ok) { let j = {}; try { j = await r.json(); } catch {} return send(res, r.status === 429 ? 429 : 502, { error: '中継: ' + (j.error || r.status) }); }
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Sample-Rate': r.headers.get('X-Sample-Rate') || '24000', 'X-Channels': r.headers.get('X-Channels') || '1', 'X-TTS-Model': (r.headers.get('X-TTS-Model') || DEFAULT_TTS_MODEL) + ' (relay)' });
          const reader = r.body.getReader();
          while (true) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
          return res.end();
        } catch (e) { return send(res, 502, { error: '中継に届かない: ' + e.message }); }
      }
      if (ttsDown()) return send(res, 429, { error: '声は今日の上限に達しています（あと ' + ttsRetryIn() + '）', down: true });
      // 生の PCM（16bit・モノラル）を届いた順に流す。ヘッダにサンプリング周波数。最初の断片の前に失敗したら JSON で返す
      let started = false;
      try {
        const info = await voiceStream({ text, mood: clean(b.mood, 20), kind: b.kind === 'action' ? 'action' : 'line', intensity: typeof b.intensity === 'number' ? b.intensity : null, affection: typeof b.affection === 'number' ? b.affection : null, voiceName: voiceFor(b.heroineName), onChunk: (chunk, meta) => {
          if (!started) { started = true; res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Sample-Rate': String(meta.sampleRate), 'X-Channels': String(meta.channels), 'X-TTS-Model': DEFAULT_TTS_MODEL }); }
          res.write(chunk);
        } });
        if (!started) return send(res, 502, { error: 'TTS の応答に音声がありません' });
        console.log('voice stream: first ' + info.msFirst + 'ms, done ' + info.ms + 'ms, ' + info.bytes + ' bytes');
        return res.end();
      } catch (e) {
        noteTtsError(e);
        if (started) { console.error('voice stream 中断:', e.message); return res.end(); }
        return send(res, ttsDown() ? 429 : 502, { error: e.message, down: ttsDown() });
      }
    }
    if (url.pathname === '/api/voice') {
      if (!has.tts) return send(res, 503, { error: 'GEMINI_API_KEY がありません' });
      const text = clean(b.text, 200);
      if (!text) return send(res, 400, { error: '読む台詞が空です' });
      return send(res, 200, await voice({ text, mood: clean(b.mood, 20), kind: b.kind === 'action' ? 'action' : 'line', intensity: typeof b.intensity === 'number' ? b.intensity : null, affection: typeof b.affection === 'number' ? b.affection : null }));
    }
    if (url.pathname === '/api/log') {
      const rec = { at: new Date().toISOString(), ...b };
      fs.appendFileSync(path.join(OUT, 'turns.jsonl'), JSON.stringify(rec) + '\n');
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(req.url, e.message);
    return send(res, 500, { error: e.message });
  }
});

// 起動時に反射の一言（5 種）を先に作っておく。無料枠（1 分 3 回）に合わせて 1 つずつ間を空ける
async function prewarmSfx() {
  if (!has.tts || process.env.PREWARM_SFX === '0' || (RELAY_URL && !RELAY)) return;
  const missing = [];
  for (const kind of Object.keys(INTERJECTIONS)) for (const mood of Object.keys(INTERJECTIONS[kind])) for (let tier = 0; tier < 3; tier++) if (forSpeech(sfxText(kind, mood, tier)) && !sfxExisting(kind, mood, tier, MAIN_VOICE)) missing.push([kind, mood, tier]);
  const gap = Number(process.env.PREWARM_INTERVAL_MS || 8000); // 有料 Tier 1 でも 1 分の回数上限に当たるので 8 秒。無料枠（1 分 3 回）なら 22000 にする
  for (const text of fixedTexts()) { const mood = fixedMood(text); if (!fs.existsSync(path.join(SFX_BUNDLED, fixedName(text, mood, MAIN_VOICE))) && !fs.existsSync(path.join(SFX_DIR, fixedName(text, mood, MAIN_VOICE)))) missing.push(['fixed', text, mood]); }
  if (missing.length) console.log('  一言の音声を ' + missing.length + ' 個作ります（' + gap / 1000 + ' 秒おき。PREWARM_SFX=0 で止められる・PREWARM_INTERVAL_MS で間隔）');
  for (let i = 0; i < missing.length; i++) {
    if (ttsDown()) { console.log('  声は今日の上限に達しているので、残り ' + (missing.length - i) + ' 本は次回（あと ' + ttsRetryIn() + '）'); break; }
    if (i > 0) await new Promise((r) => setTimeout(r, gap));
    const [kind, mood, tier] = missing[i];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (kind === 'fixed') { await fixedPcm(mood, tier, MAIN_VOICE); console.log('  決まった台詞の音声を用意: 「' + mood.slice(0, 18) + '…」'); break; }
        await sfxPcm(kind, mood, tier, MAIN_VOICE); console.log('  一言の音声を用意: ' + kind + '/' + mood + '/' + tier + '「' + sfxText(kind, mood, tier) + '」'); break; }
      catch (e) {
        const m = e.message.match(/retry in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
        const waitSec = m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 20;
        if (/429|rate limit/i.test(e.message) && attempt < 2 && waitSec <= 60) { await new Promise((r) => setTimeout(r, (waitSec + 1) * 1000)); continue; }
        console.log('  一言の音声は後で: ' + kind + '/' + mood + '/' + tier + '（' + e.message.slice(0, 120) + '）'); break;
      }
    }
  }
}
// 決まった台詞（冒頭・結末）。scenario にある文だけ受け付ける（GET で任意の文を読ませないため）
const fixedTexts = () => fixedTextsOf(scenario);
const fixedMood = (text) => fixedMoodOf(scenario, text);
const fixedPending = {};
async function fixedPcm(text, mood, voice) {
  const name = fixedName(text, mood, voice);
  const have = [path.join(SFX_BUNDLED, name), path.join(SFX_DIR, name)].find((f) => fs.existsSync(f));
  if (have) return { buf: fs.readFileSync(have), rate: 24000 };
  if (RELAY_URL && !RELAY) {
    const r = await relayFetch('/api/fixed?text=' + encodeURIComponent(text) + '&mood=' + mood);
    if (!r.ok) throw new Error('中継 ' + r.status + ' ' + (await r.text()).slice(0, 120));
    const buf = Buffer.from(await r.arrayBuffer()); fs.mkdirSync(SFX_DIR, { recursive: true }); fs.writeFileSync(path.join(SFX_DIR, name), buf);
    return { buf, rate: Number(r.headers.get('X-Sample-Rate')) || 24000 };
  }
  if (ttsDown()) throw new Error('声は今日の上限に達しています（あと ' + ttsRetryIn() + '）');
  if (!fixedPending[name]) {
    fixedPending[name] = (async () => {
      const chunks = []; let rate = 24000;
      await voiceStream({ text, mood, kind: 'line', intensity: 0.7, voiceName: voice, onChunk: (c, m) => { chunks.push(c); rate = m.sampleRate; } });
      const buf = Buffer.concat(chunks); fs.mkdirSync(SFX_DIR, { recursive: true }); fs.writeFileSync(path.join(SFX_DIR, name), buf);
      return { buf, rate };
    })().catch((e) => { noteTtsError(e); throw e; }).finally(() => { delete fixedPending[name]; });
  }
  return fixedPending[name];
}
function lanUrls() { const out = []; try { for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs) if (i.family === 'IPv4' && !i.internal) out.push('http://' + i.address + ':' + PORT + '/'); } catch {} return out; }
function sfxStatus(voice = DEFAULT_VOICE) {
  const all = []; for (const kind of Object.keys(INTERJECTIONS)) for (const mood of Object.keys(INTERJECTIONS[kind])) for (let tier = 0; tier < 3; tier++) if (forSpeech(sfxText(kind, mood, tier))) all.push(kind + '/' + mood + '/' + tier);
  const ready = all.filter((k) => { const [kind, mood, tier] = k.split('/'); return !!sfxExisting(kind, mood, Number(tier), voice); });
  return { total: all.length, ready, voice };
}

server.listen(PORT, HOST, () => {
  if (RELAY) { console.log('#Jevカノ 声の中継サーバー :' + PORT + '（声 ' + DEFAULT_TTS_MODEL + ' / ' + MAIN_VOICE + ' / 1 人 10 分 ' + RELAY_PER_IP + ' 回・1 日 ' + RELAY_DAILY_CAP + ' 回' + (RELAY_TOKEN ? '・合言葉あり' : '') + '）'); return; }
  console.log('#Jevカノ http://127.0.0.1:' + PORT + '/' + (HOST === '0.0.0.0' ? '  ／ 同じ Wi-Fi のスマホから: ' + lanUrls().join(' ') : '  （スマホから遊ぶなら HOST=0.0.0.0）'));
  console.log('  反射 Jev: ' + (has.jev ? 'あり' : 'なし（TYPESAFE_API_KEY）') + ' / 言葉 ' + DEFAULT_MODEL + ': ' + (has.llm ? 'あり' : 'なし（ANTHROPIC_API_KEY）') + ' / 声 ' + DEFAULT_TTS_MODEL + ': ' + (RELAY_URL ? '中継 ' + RELAY_URL : has.tts ? 'あり' : 'なし（GEMINI_API_KEY か GOOGLE_API_KEY）'));
  console.log('  ログ: ' + path.join(OUT, 'turns.jsonl') + (process.env.APP_ENV ? '  環境: ' + process.env.APP_ENV + ' @ ' + (process.env.APP_REV || '?') : ''));
  const envFile = path.join(here, '.env'); console.log('  設定: ' + envFile + (fs.existsSync(envFile) ? '' : '（無い。環境変数だけで動いている。作るなら .env.example をコピー）'));
  prewarmSfx();
});
