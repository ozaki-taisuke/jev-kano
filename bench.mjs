#!/usr/bin/env node
/**
 * ベンチ: 同じ台詞・同じ基準で、Jev と LLM の判定を比べる。
 *
 *   node bench.mjs [--model claude-haiku-4-5] [--runs 3] [--limit N] [--concurrency 3]
 *
 * 測るもの: 応答時間（p50/p95）・同じ入力を繰り返したときの揺れ・Jev と LLM の一致率・費用。
 * 結果は _out/bench_<model>_<日時>.json と、標準出力の Markdown 表。
 */
import './lib/env-load.mjs'; // .env を他の import より先に読む（TTS_VOICE などの既定値のため）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.mjs';
import { reflex } from './lib/jev.mjs';
import { words } from './lib/llm.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(here, '.env'));
const opt = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const MODEL = opt('--model', 'claude-haiku-4-5');
const RUNS = Number(opt('--runs', 3));
const LIMIT = Number(opt('--limit', Infinity));
const CONC = Number(opt('--concurrency', 3));
const OUT = process.env.REFLEX_GALGE_OUT || path.join(here, '_out');
fs.mkdirSync(OUT, { recursive: true });

const scenario = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'));
const lines = JSON.parse(fs.readFileSync(path.join(here, 'bench_lines.json'), 'utf8')).lines.slice(0, LIMIT);
const base = { persona: scenario.persona, scene: scenario.scene, history: [{ role: 'assistant', text: scenario.opening }], affection: scenario.startAffection };

for (const k of ['TYPESAFE_API_KEY', 'ANTHROPIC_API_KEY']) if (!process.env[k]) { console.error(k + ' がありません（.env か環境変数）'); process.exit(1); }

async function runLine(l) {
  const jev = [], llm = [];
  for (let r = 0; r < RUNS; r++) {
    try { const j = await reflex({ ...base, playerLine: l.text }); delete j.raw; jev.push(j); } catch (e) { jev.push({ error: e.message }); }
    try { llm.push(await words({ ...base, playerLine: l.text, model: MODEL, withLine: false })); } catch (e) { llm.push({ error: e.message }); }
  }
  process.stdout.write('.');
  return { ...l, jev, llm };
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const mode = (xs) => { const c = {}; xs.forEach((x) => { c[x] = (c[x] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0]; };
const f = (x, n = 2) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(n));

(async () => {
  console.log('ベンチ: ' + lines.length + ' 本 × ' + RUNS + ' 回、LLM=' + MODEL);
  const rows = await pool(lines, CONC, runLine);
  console.log();
  const ok = (a) => a.filter((x) => !x.error);
  const stat = (judge) => {
    const all = rows.flatMap((r) => ok(r[judge]));
    const ms = all.map((x) => x.ms);
    const usd = all.reduce((s, x) => s + (x.usd || 0), 0);
    const stable = rows.filter((r) => { const m = ok(r[judge]).map((x) => x.mood); return m.length >= 2 && new Set(m).size === 1; }).length;
    const spread = rows.map((r) => { const d = ok(r[judge]).map((x) => judge === 'jev' ? x.deltaRound : x.delta); return d.length ? Math.max(...d) - Math.min(...d) : null; }).filter((x) => x != null);
    return { n: all.length, p50: pct(ms, 0.5), p95: pct(ms, 0.95), usd, moodStable: stable, deltaSpread: spread.reduce((a, b) => a + b, 0) / (spread.length || 1), errors: rows.flatMap((r) => r[judge]).filter((x) => x.error).length };
  };
  const J = stat('jev'), L = stat('llm');
  // 一致（各ラインの多数決どうし）
  const per = rows.map((r) => {
    const jm = mode(ok(r.jev).map((x) => x.mood)), lm = mode(ok(r.llm).map((x) => x.mood));
    const jd = Number(mode(ok(r.jev).map((x) => x.deltaRound))), ld = Number(mode(ok(r.llm).map((x) => x.delta)));
    const jh = ok(r.jev).map((x) => x.hurt).reduce((a, b) => a + b, 0) / (ok(r.jev).length || 1) >= 0.5, lh = mode(ok(r.llm).map((x) => String(x.hurt))) === 'true';
    const conf = ok(r.jev).map((x) => x.moodConfidence).filter((x) => typeof x === 'number');
    return { id: r.id, cat: r.cat, text: r.text, jevMood: jm, llmMood: lm, jevDelta: jd, llmDelta: ld, jevHurt: jh, llmHurt: lh, jevConf: conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : null, agreeMood: jm === lm, agreeDelta: Math.abs(jd - ld) <= 1, agreeHurt: jh === lh };
  });
  const agree = (k) => per.filter((p) => p[k]).length + '/' + per.length;
  const cats = [...new Set(per.map((p) => p.cat))];

  let md = '';
  md += '| | Jev | LLM（' + MODEL + '） |\n|:--|--:|--:|\n';
  md += '| 応答時間 p50 | ' + J.p50 + ' ms | ' + L.p50 + ' ms |\n';
  md += '| 応答時間 p95 | ' + J.p95 + ' ms | ' + L.p95 + ' ms |\n';
  md += '| 同じ入力 ' + RUNS + ' 回で感情が全て同じ | ' + J.moodStable + '/' + rows.length + ' | ' + L.moodStable + '/' + rows.length + ' |\n';
  md += '| 同じ入力 ' + RUNS + ' 回の好感度差の幅（平均） | ' + f(J.deltaSpread) + ' | ' + f(L.deltaSpread) + ' |\n';
  md += '| 費用（' + J.n + ' / ' + L.n + ' 回分） | $' + f(J.usd, 5) + ' | $' + f(L.usd, 5) + ' |\n';
  md += '| エラー | ' + J.errors + ' | ' + L.errors + ' |\n\n';
  md += '一致（各台詞の多数決どうし）: 感情 ' + agree('agreeMood') + '、好感度の動き（±1 以内） ' + agree('agreeDelta') + '、傷つける ' + agree('agreeHurt') + '\n\n';
  md += '| 種類 | 感情の一致 | 好感度の一致 | 傷つけるの一致 | Jev の確信（平均） |\n|:--|:-:|:-:|:-:|:-:|\n';
  for (const c of cats) { const ps = per.filter((p) => p.cat === c); const cf = ps.map((p) => p.jevConf).filter((x) => x != null); md += '| ' + c + ' | ' + ps.filter((p) => p.agreeMood).length + '/' + ps.length + ' | ' + ps.filter((p) => p.agreeDelta).length + '/' + ps.length + ' | ' + ps.filter((p) => p.agreeHurt).length + '/' + ps.length + ' | ' + f(cf.reduce((a, b) => a + b, 0) / (cf.length || 1)) + ' |\n'; }
  md += '\n| id | 台詞 | Jev | LLM | ずれ |\n|:--|:--|:--|:--|:--|\n';
  for (const p of per) md += '| ' + p.id + ' | ' + p.text.slice(0, 40) + ' | ' + p.jevMood + ' ' + (p.jevDelta >= 0 ? '+' : '') + p.jevDelta + (p.jevHurt ? ' 傷' : '') + ' | ' + p.llmMood + ' ' + (p.llmDelta >= 0 ? '+' : '') + p.llmDelta + (p.llmHurt ? ' 傷' : '') + ' | ' + (!p.agreeMood || !p.agreeDelta ? '⚑' : '') + ' |\n';
  console.log(md);

  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const file = path.join(OUT, 'bench_' + MODEL + '_' + stamp + '.json');
  fs.writeFileSync(file, JSON.stringify({ model: MODEL, runs: RUNS, summary: { jev: J, llm: L }, per, rows, md }, null, 1));
  console.log('保存: ' + file);
})().catch((e) => { console.error(e); process.exit(1); });
