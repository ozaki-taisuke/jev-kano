/**
 * 音声キャッシュのファイル名。「文・声・モデル・演技指示」のハッシュを含めるので、変えていない台詞は作り直さない（1 日の回数上限を守るため）。
 * サーバー（server.mjs）と同梱スクリプト（bundle_sfx.mjs）で同じ名前になるよう、ここに置く。
 */
import { createHash } from 'node:crypto';
import { INTERJECTIONS, TIER_INTENSITY } from './criteria.mjs';
import { styleFor, TTS_TEXT_VERSION, DEFAULT_TTS_MODEL, DEFAULT_VOICE } from './tts.mjs';

const h8 = (parts) => createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 8);
export const sfxText = (kind, mood, tier) => ((INTERJECTIONS[kind] || {})[mood] || [])[tier] || '';
export const sfxName = (kind, mood, tier, voice = DEFAULT_VOICE) => kind + '_' + mood + '_' + tier + '_' + h8([TTS_TEXT_VERSION, sfxText(kind, mood, tier), voice, DEFAULT_TTS_MODEL, styleFor(mood, { kind, intensity: TIER_INTENSITY[tier] })]) + '.pcm';
export const fixedName = (text, mood, voice = DEFAULT_VOICE) => 'fixed_' + h8([TTS_TEXT_VERSION, text, mood, voice, DEFAULT_TTS_MODEL, styleFor(mood, { kind: 'line', intensity: 0.7 })]) + '.pcm';
/** 結末の組（共通のものと、はじまりごとに差し替えたもの） */
const endingSets = (scenario) => [scenario.endings || {}, ...(scenario.episodes || []).map((ep) => ep.endings || {})];
/** 決まった台詞（冒頭・結末）。scenario にある文だけ（重複は除く） */
export function fixedTexts(scenario) {
  const t = [scenario.opening]; for (const ep of scenario.episodes || []) if (ep.opening) t.push(ep.opening);
  for (const set of endingSets(scenario)) for (const e of Object.values(set)) if (e && e.text) t.push(e.text);
  return [...new Set(t.filter(Boolean))];
}
/** 決まった台詞の声色。画面側（speakFixed の呼び出し）と同じ対応（違うとキャッシュ名が変わり作り直しになる） */
export function fixedMood(scenario, text) {
  for (const e of endingSets(scenario)) {
    if (e.perfect && e.perfect.text === text || e.good && e.good.text === text) return 'joy';
    if (e.normal && e.normal.text === text) return 'calm';
    if (e.bad && e.bad.text === text || e.leave && e.leave.text === text) return 'upset';
  }
  return 'shy';
}
