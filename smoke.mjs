#!/usr/bin/env node
/**
 * 起動の煙テスト: 鍵が無くてもサーバーが立ち、画面と設定が返ることを確かめる（API は呼ばない）。
 * 公開サーバー（PUBLIC=1）の守りも確かめる: 計測を残さない・声の口を数える・相手の IP を X-Forwarded-For の後ろから数える。
 *   node smoke.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOKEYS = { PREWARM_SFX: '0', TYPESAFE_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', VOICE_RELAY_URL: '', VOICE_RELAY: '', PUBLIC: '', TRUST_PROXY_HOPS: '1' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
let out = '';
const fail = (m) => { console.error('NG: ' + m); console.error(out); for (const c of children) c.kill(); process.exit(1); };

async function boot(port, extra = {}) {
  const child = spawn(process.execPath, [path.join(here, 'server.mjs')], { env: { ...process.env, ...NOKEYS, PORT: String(port), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const base = 'http://127.0.0.1:' + port;
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) { await wait(200); try { const r = await fetch(base + '/api/config'); ok = r.ok; } catch {} }
  if (!ok) fail('サーバーが 6 秒以内に応答しない（' + port + '）');
  return base;
}
const post = (base, p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

try {
  // 1. 手元（鍵なし）
  const local = await boot(8799);
  const cfg = await (await fetch(local + '/api/config')).json();
  if (cfg.has.jev || cfg.has.llm || cfg.has.tts) fail('鍵が無いのに has が true');
  if (cfg.logs !== true) fail('手元なのに logs が true でない');
  if (!cfg.scenario || !Array.isArray(cfg.scenario.episodes) || cfg.scenario.episodes.length < 1) fail('scenario.episodes が無い');
  if (!cfg.interjections || !cfg.fallbackLines) fail('interjections / fallbackLines が無い');
  const html = await (await fetch(local + '/')).text();
  if (!/<title>#Jevカノ<\/title>/.test(html)) fail('画面の題が違う');
  const m = html.match(/<script>([\s\S]*)<\/script>/); new Function(m[1]); // 画面のスクリプトが構文として通る
  const r1 = await post(local, '/api/reflex', { line: 'こんにちは', affection: 50 });
  if (r1.status !== 503) fail('鍵なしの /api/reflex が 503 でない: ' + r1.status);
  const r2 = await fetch(local + '/api/fixed?text=' + encodeURIComponent('任意の文') + '&mood=shy');
  if (r2.status !== 404) fail('決まった台詞以外の /api/fixed が 404 でない: ' + r2.status);
  // はじまりごとに差し替えた結末（ステージ袖）も「決まった台詞」として受ける（404 でなく、鍵も同梱も無ければ 503、同梱済みなら 200）
  const wings = cfg.scenario.episodes.find((e) => e.id === 'wings');
  if (!wings || !wings.endings || !wings.endings.good || !wings.goal || !wings.playerRole) fail('ステージ袖に当日用の目標・立場・結末が無い');
  for (const e of Object.values(wings.endings)) if (/明日|片付け/.test(e.text)) fail('ステージ袖（当日）の結末に前夜の言葉がある: ' + e.text);
  if (/明日|片付けを手伝っている/.test(wings.playerRole + wings.goal)) fail('ステージ袖（当日）の目標・立場に前夜の言葉がある');
  const r4 = await fetch(local + '/api/fixed?text=' + encodeURIComponent(wings.endings.good.text) + '&mood=joy');
  if (r4.status === 404) fail('ステージ袖の結末が決まった台詞として受け付けられない');
  const r3 = await post(local, '/api/voice', { text: '任意の文' });
  if (r3.status !== 404) fail('消した口 /api/voice が 404 でない: ' + r3.status);
  console.log('OK: 鍵なしで起動・画面・設定・拒否が期待どおり');

  // 2. 公開サーバー（鍵なし。上限は鍵の確認より先に数えるので、鍵が無くても確かめられる）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevkano-smoke-'));
  const pub = await boot(8798, { PUBLIC: '1', HOST: '127.0.0.1', REFLEX_GALGE_OUT: dir, VOICE_PER_IP_10MIN: '2', RELAY_PER_IP_10MIN: '2' });
  const pcfg = await (await fetch(pub + '/api/config')).json();
  if (pcfg.logs !== false) fail('公開サーバーなのに logs が false でない');
  const l1 = await post(pub, '/api/log', { line: '残してはいけない台詞' });
  if (!l1.ok || (await l1.json()).kept !== false) fail('公開サーバーの /api/log が「残さない」を返さない');
  if (fs.existsSync(path.join(dir, 'turns.jsonl'))) fail('公開サーバーが計測を書いた');
  // 声の口: 先頭（相手が書ける所）を毎回変えても、後ろ（中継が足す所）が同じなら同じ相手。3 回目で上限
  const voice = (xff) => post(pub, '/api/voice/stream', { text: '任意の文' }, { 'X-Forwarded-For': xff });
  const v = []; for (let i = 0; i < 3; i++) v.push((await voice('10.0.0.' + i + ', 203.0.113.7')).status);
  if (v[0] !== 503 || v[1] !== 503 || v[2] !== 429) fail('声の口が 3 回目で 429 にならない（先頭の偽装で回避できている）: ' + v.join(','));
  const v4 = await voice('10.0.0.1, 203.0.113.8');
  if (v4.status !== 503) fail('後ろが違う相手まで上限に当たった: ' + v4.status);
  // 手（言葉の生成）も同じ数え方
  const w = []; for (let i = 0; i < 3; i++) w.push((await post(pub, '/api/words', { line: 'こんにちは' }, { 'X-Forwarded-For': '10.0.1.' + i + ', 203.0.113.9' })).status);
  if (w[0] !== 503 || w[1] !== 503 || w[2] !== 429) fail('手が 3 回目で 429 にならない: ' + w.join(','));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('OK: 公開サーバーは計測を残さず、声と手を後ろの IP で数える');
} finally { for (const c of children) c.kill(); }
