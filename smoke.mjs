#!/usr/bin/env node
/**
 * 起動の煙テスト: 鍵が無くてもサーバーが立ち、画面と設定が返ることを確かめる（API は呼ばない）。
 *   node smoke.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8799;
const env = { ...process.env, PORT: String(PORT), PREWARM_SFX: '0', TYPESAFE_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '' };
const child = spawn(process.execPath, [path.join(here, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const fail = (m) => { console.error('NG: ' + m); console.error(out); child.kill(); process.exit(1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) { await wait(200); try { const r = await fetch('http://127.0.0.1:' + PORT + '/api/config'); ok = r.ok; } catch {} }
  if (!ok) fail('サーバーが 6 秒以内に応答しない');
  const cfg = await (await fetch('http://127.0.0.1:' + PORT + '/api/config')).json();
  if (cfg.has.jev || cfg.has.llm || cfg.has.tts) fail('鍵が無いのに has が true');
  if (!cfg.scenario || !Array.isArray(cfg.scenario.episodes) || cfg.scenario.episodes.length < 1) fail('scenario.episodes が無い');
  if (!cfg.interjections || !cfg.fallbackLines) fail('interjections / fallbackLines が無い');
  const html = await (await fetch('http://127.0.0.1:' + PORT + '/')).text();
  if (!/<title>#Jevカノ<\/title>/.test(html)) fail('画面の題が違う');
  const m = html.match(/<script>([\s\S]*)<\/script>/); new Function(m[1]); // 画面のスクリプトが構文として通る
  const r1 = await fetch('http://127.0.0.1:' + PORT + '/api/reflex', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: 'こんにちは', affection: 50 }) });
  if (r1.status !== 503) fail('鍵なしの /api/reflex が 503 でない: ' + r1.status);
  const r2 = await fetch('http://127.0.0.1:' + PORT + '/api/fixed?text=' + encodeURIComponent('任意の文') + '&mood=shy');
  if (r2.status !== 404) fail('決まった台詞以外の /api/fixed が 404 でない: ' + r2.status);
  console.log('OK: 鍵なしで起動・画面・設定・拒否が期待どおり');
} finally { child.kill(); }
