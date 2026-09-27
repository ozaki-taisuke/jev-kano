#!/usr/bin/env node
/**
 * Cloud Run に置く。鍵の置き場は .env の 1 か所だけ（YAML は手で持たない）。
 *   npm run deploy:stg                         # jev-kano-stg（上限小さめ）
 *   node deploy.mjs --service jev-kano --cap 400 --per-ip 30   # 本番（main で・未コミットなしのときだけ。--force で外せる）
 *   node deploy.mjs --dry-run                  # 何を渡すか（鍵の名前だけ）と gcloud の行を見るだけ
 *
 * やること: .env を読む → 手元専用（PORT・HOST・REFLEX_GALGE_OUT）を落とす → PUBLIC=1 と上限を足す →
 * _out/ に一時的な YAML を書いて gcloud run deploy --env-vars-file に渡す → 終わったら消す。
 * .env は lib/env.mjs と同じ「KEY=VALUE」形式。Cloud Run は PORT を自分で決めるので PORT は渡してはいけない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const SERVICE = opt('service', 'jev-kano-stg');
const REGION = opt('region', 'asia-northeast1');
const CAP = opt('cap', '100');
const PER_IP = opt('per-ip', '30');
const MODEL = opt('model', '');
const DRY = args.includes('--dry-run');
const LOCAL_ONLY = new Set(['PORT', 'HOST', 'REFLEX_GALGE_OUT', 'PREWARM_SFX', 'PREWARM_INTERVAL_MS']);

// 出荷の守り: 名前が -stg で終わらないサービス（本番）は、main で・未コミットの変更が無いときだけ置ける。--force で外せる
const git = (a) => { const r = spawnSync('git', a, { cwd: here, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };
const BRANCH = git(['branch', '--show-current']), DIRTY = git(['status', '--porcelain']) !== '', REV = git(['rev-parse', '--short', 'HEAD']);
const IS_STG = /-stg$/.test(SERVICE);
if (!IS_STG && !args.includes('--force')) {
  const why = BRANCH !== 'main' ? 'ブランチが main でない（' + (BRANCH || '不明') + '）' : DIRTY ? '未コミットの変更がある' : '';
  if (why) { console.error('本番（' + SERVICE + '）には置かない: ' + why + '。実験なら --service jev-kano-stg、それでも置くなら --force'); process.exit(1); }
}

const envFile = path.join(here, '.env');
if (!fs.existsSync(envFile)) { console.error('.env が無い: ' + envFile + '（.env.example をコピーして鍵を入れる）'); process.exit(1); }
const vars = {};
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !LOCAL_ONLY.has(m[1])) vars[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
Object.assign(vars, { PUBLIC: '1', RELAY_DAILY_CAP: String(CAP), RELAY_PER_IP_10MIN: String(PER_IP), APP_ENV: IS_STG ? 'stg' : 'prod', APP_REV: (REV || '') + (DIRTY ? '+' : '') });
if (MODEL) vars.LLM_MODEL = MODEL;
const missing = ['TYPESAFE_API_KEY', 'ANTHROPIC_API_KEY'].filter((k) => !vars[k]);
if (!vars.GEMINI_API_KEY && !vars.GOOGLE_API_KEY && !vars.VOICE_RELAY_URL) missing.push('GEMINI_API_KEY か GOOGLE_API_KEY（か VOICE_RELAY_URL）');
if (missing.length) console.warn('注意: .env に無い: ' + missing.join(', ') + '（その機能は縮退する）');

const yamlStr = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const yaml = Object.entries(vars).map(([k, v]) => k + ': ' + yamlStr(v)).join('\n') + '\n';
const outDir = path.join(here, '_out'); fs.mkdirSync(outDir, { recursive: true });
const tmp = path.join(outDir, 'deploy-' + SERVICE + '.env.yaml'); // _out/ と *.env.yaml は Git 管理外・アップロード対象外

const cmd = ['gcloud', 'run', 'deploy', SERVICE, '--source', '.', '--region', REGION, '--allow-unauthenticated', '--env-vars-file', tmp];
console.log('置く: ' + SERVICE + '（' + REGION + '・' + (IS_STG ? 'stg' : '本番') + '）  元: ' + (BRANCH || '?') + ' @ ' + (REV || '?') + (DIRTY ? '（未コミットあり）' : '') + '  渡す変数: ' + Object.keys(vars).join(', '));
console.log('  上限: 1 人 10 分 ' + PER_IP + ' 手・全体 1 日 ' + CAP + ' 手' + (MODEL ? '  言葉: ' + MODEL : ''));
console.log('  ' + cmd.join(' '));
if (DRY) process.exit(0);

fs.writeFileSync(tmp, yaml, { mode: 0o600 });
let code = 1;
try {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: here, stdio: 'inherit', shell: process.platform === 'win32' }); // Windows は gcloud.cmd なので shell 経由
  code = r.status ?? 1; if (r.error) console.error(r.error.message + '（gcloud が PATH に無い？）');
} finally { try { fs.unlinkSync(tmp); } catch {} }
process.exit(code);
