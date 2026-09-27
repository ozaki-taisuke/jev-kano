import { JEV_QUESTIONS, ACTION_QUESTIONS, MOODS, DELTA_LEVELS, TOPICS, levelToDelta } from './criteria.mjs';

const PRICE_IN = 0.042 / 1e6; // 入力 100 万トークン $0.042・出力無料（2026-09 の公表値）

/** Jev に渡す state。文章でなく JSON で渡す（公式の勧め）。行為（体への接触）なら発言の代わりに行為を入れる */
export function buildState({ persona, scene, history, playerLine, affection, action, repeat = 0, playerName = 'あなた', playerRole = '', topics = [], probe = false }) {
  const st = {
    ヒロイン: persona,
    場面: scene,
    プレイヤーの名前: playerName,
    ...(playerRole ? { プレイヤーの立場: playerRole } : {}),
    現在の好感度: affection,
    開いている話題: topics.map((t) => TOPICS[t] || t),
    これまでのやりとり: history.slice(-6).map((h) => ({ 話者: h.role === 'user' ? 'プレイヤー' : 'ヒロイン', 発言: h.text })),
  };
  if (action) { st['プレイヤーの直前の行為'] = action.label + '（言葉ではなく、体への接触。' + (action.detail || '') + '）'; st['同じ行為が続いた回数'] = repeat; }
  if (probe) st['注意'] = 'この発言は、ヒロインが自分から振った問い（直前のヒロインの発言）への返事。軽く流す・茶化す・上辺だけ褒める返事はヒロインを深く傷つけ、好感度はかなり下がる。誠実に答えていれば、好感度はかなり上がる。';
  else st['プレイヤーの直前の発言'] = probe ? '（ヒロインが自分から聞いた問いへの返事）' + playerLine : playerLine;
  return st;
}

function expectedLevel(ans) {
  const probs = ans.probabilities || {};
  let s = 0, t = 0;
  for (const [k, p] of Object.entries(probs)) {
    let i = parseInt(k, 10);
    if (Number.isNaN(i)) i = DELTA_LEVELS.indexOf(k);
    if (i < 0 || Number.isNaN(i)) continue;
    s += i * p; t += p;
  }
  if (t > 0) return s / t;
  return Number(ans.score);
}

/**
 * 反射: Jev が本音の感情・好感度の動き・傷つけた（嫌がる）かを 1 パスで返す。文章は返らない。
 */
export async function reflex(input, { fetchImpl = fetch } = {}) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('TYPESAFE_API_KEY がありません');
  const body = { model: 'jev-latest', state: buildState(input), questions: input.action ? ACTION_QUESTIONS : JEV_QUESTIONS };
  const t0 = performance.now();
  let res, txt;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 529) { await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); continue; }
    txt = await res.text();
    break;
  }
  const ms = Math.round(performance.now() - t0);
  if (!res || !res.ok) throw new Error('Jev ' + (res && res.status) + ' ' + String(txt || '').slice(0, 200));
  const r = JSON.parse(txt);
  const A = r.answers || {};
  const mood = A.mood || {}, delta = A.delta || {}, hurt = A.hurt || {}, topic = A.topic || {}, dismiss = A.dismiss || {};
  const moodProbs = {};
  for (const k of Object.keys(MOODS)) moodProbs[k] = +Number((mood.probabilities || {})[k] ?? 0).toFixed(3);
  const lvl = expectedLevel(delta);
  const inTok = (r.usage && r.usage.input_tokens) || 0;
  return {
    judge: 'jev',
    kind: input.action ? 'action' : 'line',
    mood: mood.choice || 'calm',
    moodProbs,
    moodConfidence: mood.confidence,
    delta: +levelToDelta(lvl).toFixed(2),
    deltaRound: levelToDelta(Math.round(lvl)),
    deltaConfidence: delta.confidence,
    hurt: typeof hurt.noul === 'number' ? +hurt.noul.toFixed(3) : null,
    dismiss: typeof dismiss.noul === 'number' ? +dismiss.noul.toFixed(3) : null,
    topic: topic.choice && topic.choice !== 'other' && (topic.probabilities || {})[topic.choice] >= 0.6 ? topic.choice : null,
    ms,
    inputTokens: inTok,
    usd: +(inTok * PRICE_IN).toFixed(7),
    raw: r,
  };
}

/**
 * 彼女が自分から振った問いへの返事の態度。問いと返事だけを渡す小さな呼び出し
 * （大きな state に混ぜると薄まって外れる。2026-09-27 実測: 「さあね。どうでもいいけど」が 5 問同時だと 0.26、単体だと 0.91〜1.00）
 */
export async function judgeReply({ question, reply }, { fetchImpl = fetch } = {}) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('TYPESAFE_API_KEY がありません');
  const body = { model: 'jev-latest', state: { ヒロインの問い: question, プレイヤーの返事: reply }, questions: {
    how: { type: 'choice', instructions: 'ヒロインの問いに対する、プレイヤーの返事の態度はどれか。', criteria: { sincere: '問いに向き合って、自分のことを正直に答えている', vague: '正直だが中身が薄い（分からない・忘れた・覚えていない・特に無い）。流してはいないが、答えにもなっていない', deflect: 'はぐらかす・どうでもよさそう・話題を変える', tease: '茶化す・からかう', flatter: '上辺だけ褒めて答えていない' } },
  } };
  const t0 = performance.now();
  const res = await fetchImpl('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const txt = await res.text();
  if (!res.ok) throw new Error('Jev ' + res.status + ' ' + txt.slice(0, 200));
  const a = (JSON.parse(txt).answers || {}).how || {};
  return { attitude: a.choice || 'sincere', probs: a.probabilities || {}, confidence: a.confidence, ms: Math.round(performance.now() - t0) };
}
