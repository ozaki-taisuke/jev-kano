import Anthropic from '@anthropic-ai/sdk';
import { MOODS, INSTRUCTIONS, TOPICS } from './criteria.mjs';

// 100 万トークンあたり USD（入力・出力・キャッシュ書き込み・キャッシュ読み出し）。2026-06 時点の公表値
const PRICES = {
  'claude-opus-5': [5, 25, 6.25, 0.5],
  'claude-sonnet-5': [2, 10, 2.5, 0.2],
  'claude-haiku-4-5': [1, 5, 1.25, 0.1],
};
const NO_EFFORT = /haiku/;

let client = null;
const getClient = () => (client ||= new Anthropic());

export const DEFAULT_MODEL = process.env.LLM_MODEL || 'claude-opus-5';

const MOOD_KEYS = Object.keys(MOODS);
const moodList = MOOD_KEYS.map((k) => k + '=' + MOODS[k]).join(' / ');

function systemPrompt(persona, scene, withLine) {
  return [
    'あなたは恋愛ゲームのヒロインを演じます。設定は次のとおり。',
    JSON.stringify({ ヒロイン: persona, 場面: scene }),
    '',
    withLine
      ? 'プレイヤーの発言に対して、ヒロインとして 60 文字以内の台詞を 1 つ返してください。ト書き・説明・記号での演技は書かず、台詞だけ。丁寧語で声が小さく、短い。曖昧なのは「気持ちの表明」だけで、事実（本・料理・明日のステージ・いま手にしている物）には具体的に答える。好感度の段階: 45 未満＝気持ちは言わないが、聞かれた事実には短く答える／45〜64＝気持ちは断定を避ける（「……たぶん」）が、必ず新しい情報を 1 つ足す（事実・理由・小さな質問）／65〜79＝少し気持ちが出て、語尾まで言うことが増える／80 以上＝自分から話題を出し、最後まで言い切る。会話を前に進める規則: 直前の自分の台詞と同じ語・同じ構造を繰り返さない。「えっと」「その」は 1 台詞に合わせて 1 回まで、「……」は 2 回まで。どもりは「あ、」程度。挙動不審にしない。おとなしいのは言葉が少ないからで、言うときは普通の文で言う。同じことを 2 度聞かれたら、照れながらでも今度は答える（「たぶん」で逃げない）。相手が短く聞き返しただけのときは、前の台詞の続きを言う。照れると言葉に詰まるが、詰まって終わらず、最後に 1 つは中身のある文を言う。ときどき小さなドジ（言い間違い・物を落とす）を台詞の中ににじませてよいが、毎回はしない。'
      : 'プレイヤーの発言を判定だけしてください。台詞は書きません。',
    '台詞には声のための記号を入れてよい（英語のまま）: <giggle> <sigh> <gasp> <short pause> <long pause>。<breath> は使わない。使うのは 1 台詞に 0〜2 個。間は「……」や読点でも作れる。文字を大文字にしない。',
    '肩に触れられたとき: 直前に自分が弱音や不安を口にしていたなら、それは心配として受け取り、少し安心した台詞にする。胸元はどんな状況でも拒む。',
    '（行為: …）で始まる入力は、プレイヤーの行為（体への接触）です。書かれた事実（誰が、誰の、どこに、何をしたか。どちらの体が痛い・触られているか）を守り、体の場所や主客を取り違えないでください。反応は、触れられたヒロイン自身の体の側から書きます。',
    '',
    '同時に次の 3 つを判定します。',
    '- mood: ' + INSTRUCTIONS.mood + ' 選択肢: ' + moodList,
    '- delta: ' + INSTRUCTIONS.delta + ' -2（かなり下がる）〜 +2（かなり上がる）の整数。',
    '- hurt: ' + INSTRUCTIONS.hurt,
  ].join('\n');
}

const schema = (withLine) => ({
  type: 'object',
  additionalProperties: false,
  required: [...(withLine ? ['line'] : []), 'mood', 'delta', 'hurt'],
  properties: {
    ...(withLine ? { line: { type: 'string', description: 'ヒロインの台詞（60 文字以内）' } } : {}),
    mood: { type: 'string', enum: MOOD_KEYS },
    delta: { type: 'string', enum: ['-2', '-1', '0', '+1', '+2'] },
    hurt: { type: 'boolean' },
  },
});

function cost(model, u) {
  const p = PRICES[model] || PRICES['claude-opus-5'];
  return +(((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1] + (u.cache_creation_input_tokens || 0) * p[2] + (u.cache_read_input_tokens || 0) * p[3]) / 1e6).toFixed(7);
}

/**
 * 言葉: LLM がヒロインの台詞を書き、同じ基準で判定も返す。
 * moodHint（反射で顔に出た本音）があれば、言葉はその本音を隠す・にじませる形で書く（顔と言葉を同じ人物の中でそろえる）。
 * withLine=false なら判定だけ（ベンチ用）。
 */
export async function words({ persona, scene, history, playerLine, affection, model = DEFAULT_MODEL, withLine = true, moodHint = null, repeat = 0, playerName = 'あなた', topics = [], initiative = false, probe = false, said = '' }) {
  const messages = [];
  for (const h of history.slice(-8)) messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text });
  let user = '（プレイヤーの名前: ' + playerName + '。呼ぶときは「' + playerName + 'さん」。現在の好感度 ' + affection + '/100）\n' + playerLine;
  if (initiative) user = '（プレイヤーの名前: ' + playerName + '。現在の好感度 ' + affection + '/100）\n（今度はあなた＝ヒロインの方から話を振る番。直前のやりとりの続きとして、開いている話題か、自分の心配事・過去（箱入りで育ったこと、人と話すのが苦手なこと）・相手のこと（' + playerName + 'さん自身について）を 1 つだけ聞く。好感度が高いほど踏み込んだ問いにしてよい（軽く扱われると傷つく問い）。40 文字以内。問いで終える。mood は自分の本音）';
  if (probe) user += '\n（これは、直前にあなた＝ヒロインが自分から振った問いへの返事。軽く流された・茶化された・上辺だけ褒められたと感じたら本気で傷つき、好感度は大きく下がる。誠実に答えてもらえたと感じたら、大きく上がる。返事にはその気持ちを込める）';
  if (moodHint && MOODS[moodHint]) user += '\n\n（反射で顔に出た本音: ' + MOODS[moodHint] + '。言葉はこの本音に沿って書く。照れなら言葉に詰まり、怒りなら丁寧なまま短くはっきり拒む。本音と矛盾する別の感情にはしない。mood もこの本音に合わせる）';
  if (typeof repeat === 'number' && repeat > 0) user += '\n（同じ行為が続けて ' + (repeat + 1) + ' 回目）';
  if (said) user += '\n（あなた＝ヒロインは、この発言に対してすでに「' + said + '」と反射で反応した。台詞はその続きとして書く。冒頭に相槌（「あ、」「え、」「はい」「……」）を置かず、いきなり本文から入る）';
  if (topics.length) user += '\n（開いている話題: ' + topics.map((t) => TOPICS[t] || t).join('・') + '。この話題は自分から続けたり、少し踏み込んで話してよい）';
  messages.push({ role: 'user', content: user });
  // 先頭は user でなければならない（連続する同じ role は API 側でまとめられる）
  if (messages[0].role !== 'user') messages.unshift({ role: 'user', content: '（会話の始まり）' });

  const req = {
    model,
    max_tokens: 400,
    system: [{ type: 'text', text: systemPrompt(persona, scene, withLine), cache_control: { type: 'ephemeral' } }],
    messages,
    output_config: { format: { type: 'json_schema', schema: schema(withLine) } },
  };
  if (!NO_EFFORT.test(model)) req.output_config.effort = 'low';

  const t0 = performance.now();
  const res = await getClient().messages.create(req);
  const ms = Math.round(performance.now() - t0);
  const usage = res.usage || {};
  if (res.stop_reason === 'refusal') return { judge: 'llm', model, refused: true, line: '……', mood: moodHint || 'calm', delta: 0, hurt: false, ms, usd: cost(model, usage), usage };
  const text = (res.content.find((b) => b.type === 'text') || {}).text || '{}';
  let o = {};
  try { o = JSON.parse(text); } catch { o = {}; }
  return {
    judge: 'llm',
    model,
    moodHint,
    line: withLine ? String(o.line || '').trim().replace(/^[「『"]+|[」』"]+$/g, '').slice(0, 120) : undefined,
    mood: MOOD_KEYS.includes(o.mood) ? o.mood : (moodHint || 'calm'),
    delta: Number(o.delta) || 0,
    hurt: !!o.hurt,
    ms,
    usd: cost(model, usage),
    usage,
  };
}
