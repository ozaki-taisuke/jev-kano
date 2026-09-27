#!/usr/bin/env node
/**
 * 一言と決まった台詞の音声を同梱する: いま使う名前のものだけ _out/sfx/ → public/sfx/ にコピーし、使わなくなった古いものは public/sfx/ から消す。
 *   node bundle_sfx.mjs            （npm run sfx:bundle）
 * 声は scenario.voices にある全部（無ければ TTS_VOICE か既定）。
 */
import './lib/env-load.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERJECTIONS } from './lib/criteria.mjs';
import { DEFAULT_VOICE } from './lib/tts.mjs';
import { sfxName, sfxText, fixedName, fixedTexts, fixedMood } from './lib/names.mjs';
import { forSpeech } from './lib/tts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scenario = JSON.parse(fs.readFileSync(path.join(here, 'scenario.json'), 'utf8'));
const SRC = path.join(process.env.REFLEX_GALGE_OUT || path.join(here, '_out'), 'sfx');
const DST = path.join(here, 'public', 'sfx');
fs.mkdirSync(DST, { recursive: true });
const voices = new Set([DEFAULT_VOICE, ...(scenario.names || []).map((n) => ((scenario.voices || {})[n] || {}).id).filter(Boolean)]);
const want = new Set();
for (const voice of voices) {
  for (const kind of Object.keys(INTERJECTIONS)) for (const mood of Object.keys(INTERJECTIONS[kind])) for (let tier = 0; tier < 3; tier++) if (forSpeech(sfxText(kind, mood, tier))) want.add(sfxName(kind, mood, tier, voice));
  for (const text of fixedTexts(scenario)) want.add(fixedName(text, fixedMood(scenario, text), voice));
}
let copied = 0, kept = 0, removed = 0, missing = [];
for (const name of want) {
  const s = path.join(SRC, name), d = path.join(DST, name);
  if (fs.existsSync(d)) { kept++; continue; }
  if (fs.existsSync(s)) { fs.copyFileSync(s, d); copied++; } else missing.push(name);
}
for (const f of fs.readdirSync(DST)) if (/\.pcm$/.test(f) && !want.has(f)) { fs.unlinkSync(path.join(DST, f)); removed++; }
console.log('同梱: 新たに ' + copied + '・既に ' + kept + '・古いものを削除 ' + removed + '・まだ無い ' + missing.length + (missing.length ? '（サーバーを起動すると作られる）' : ''));
