/**
 * 声の聞き比べの頁（bench_tts.mjs が _out/tts_bench/index.html に書く）。
 * 1 枚で完結（外部の読み込みなし）。音声は同じフォルダの WAV を相対パスで読むので、ファイルを直接開いても鳴る。
 * 名前を伏せて聴く → 一番を選ぶ → 答え合わせ、の順。選んだ結果はブラウザに残り、Markdown で写せる（MAKING.md に貼る用）。
 */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderPage(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>声の聞き比べ</title>
<style>
:root { --bg:#f6f4ef; --card:#fffdf8; --ink:#23211c; --sub:#6b665a; --line:#ddd7c8; --accent:#2f6f6a; --accent-ink:#fff; --warn:#a4481f; --chip:#ece7da; }
@media (prefers-color-scheme: dark) { :root { --bg:#17181a; --card:#1f2124; --ink:#e9e6df; --sub:#a09b8e; --line:#34373c; --accent:#6fb7b0; --accent-ink:#10201f; --warn:#e08a5c; --chip:#2a2d31; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.7 "Hiragino Sans","Yu Gothic UI","Meiryo",system-ui,sans-serif; }
header { position:sticky; top:0; z-index:5; background:var(--bg); border-bottom:1px solid var(--line); padding:10px 16px; }
header h1 { font-size:17px; margin:0 0 2px; }
header .meta { color:var(--sub); font-size:12px; }
.bar { display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; margin-top:8px; font-size:13px; }
.bar label { display:inline-flex; gap:5px; align-items:center; cursor:pointer; }
button { font:inherit; font-size:13px; padding:5px 12px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--ink); cursor:pointer; }
button.primary { background:var(--accent); color:var(--accent-ink); border-color:var(--accent); }
main { max-width:980px; margin:0 auto; padding:16px; }
h2 { font-size:15px; margin:26px 0 8px; padding-bottom:4px; border-bottom:1px solid var(--line); }
.note { color:var(--sub); font-size:13px; margin:4px 0 12px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:12px 0; }
.card .text { font-size:16px; margin:6px 0 2px; }
.card .why { color:var(--sub); font-size:12.5px; }
.chips { display:flex; flex-wrap:wrap; gap:6px; font-size:12px; }
.chip { background:var(--chip); border-radius:999px; padding:1px 9px; color:var(--sub); }
.clips { display:grid; gap:8px; margin-top:10px; }
.clip { display:grid; grid-template-columns: 9.5em minmax(0,1fr); gap:4px 10px; align-items:center; padding:8px 10px; border:1px solid var(--line); border-radius:8px; }
.clip.best { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) inset; }
.clip .name { font-weight:600; overflow-wrap:anywhere; }
.clip audio { width:100%; height:34px; }
.clip .pick { grid-column:1 / -1; display:flex; flex-wrap:wrap; gap:4px 14px; font-size:12.5px; color:var(--sub); }
.clip .pick label { display:inline-flex; gap:4px; align-items:center; cursor:pointer; }
.clip .m { grid-column:1 / -1; font-size:12px; color:var(--sub); font-variant-numeric:tabular-nums; }
.clip .sent { grid-column:1 / -1; font-size:12px; color:var(--sub); overflow-wrap:anywhere; }
.clip .err { grid-column:1 / -1; color:var(--warn); font-size:12.5px; overflow-wrap:anywhere; }
body.blind .m, body.blind .sent, body.blind .reveal { display:none; }
input[type=text] { width:100%; font:inherit; font-size:13px; padding:5px 8px; border-radius:6px; border:1px solid var(--line); background:var(--bg); color:var(--ink); margin-top:8px; }
.tablewrap { overflow-x:auto; }
table { border-collapse:collapse; font-size:13px; font-variant-numeric:tabular-nums; min-width:100%; }
th, td { border-bottom:1px solid var(--line); padding:5px 10px; text-align:right; white-space:nowrap; }
th:first-child, td:first-child { text-align:left; }
th { color:var(--sub); font-weight:600; }
textarea { width:100%; height:220px; font:12px/1.5 ui-monospace,Consolas,monospace; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--ink); padding:8px; }
</style>
</head>
<body class="blind">
<header>
  <h1>声の聞き比べ</h1>
  <div class="meta">${esc(data.title || '')}</div>
  <div class="bar">
    <label><input type="checkbox" id="blind" checked> 名前を伏せる</label>
    <label><input type="checkbox" id="norm" checked> 音量をそろえる</label>
    <button class="primary" id="reveal">答え合わせ</button>
    <button id="copy">選んだ結果を写す</button>
    <span id="count" class="meta"></span>
  </div>
</header>
<main>
  <p class="note">同じ台詞・同じ本音を、声の口ごとに読ませたもの。並びは台詞ごとに入れ替えてある。聴いて「一番」を 1 つ選び、気になった点に印をつける。全部でなくてよい。</p>
  <div id="lines"></div>
  <div id="probeWrap"></div>
  <div class="reveal">
    <h2>選んだ結果</h2><div class="tablewrap" id="tally"></div>
    <h2>測った値（口ごと）</h2><div class="tablewrap" id="summary"></div>
    <p class="note">${esc(data.priceNote || '')}</p>
  </div>
  <h2>写す用（Markdown）</h2>
  <textarea id="md" readonly></textarea>
</main>
<script>
const D = ${json};
const KEY = 'tts_bench_' + D.runId + (D.round > 1 ? '_r' + D.round : '');
let S = { best: {}, flags: {}, memo: {}, memoMap: {} };
try { S = Object.assign(S, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} };
const $ = (id) => document.getElementById(id);
const h = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 並べ替え（台詞ごとに決まった順。読み込み直しても変わらない）
function rng(seed) { let x = 2166136261; for (const c of seed) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619); } return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) / 4294967296); }; }
function shuffled(arr, seed) { const r = rng(seed), a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const FLAGS = [['misread', '読み違い'], ['pause', '間が変'], ['other', '別人に聞こえる'], ['noise', '音が変']];
const MOOD = { joy: '嬉しい', shy: '照れ', puzzled: '戸惑い', upset: '怒り', calm: '平静' };
const f1 = (x, n = 1) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(n));
const blind = () => $('blind').checked;
const nameOf = (c) => D.systems[c.system].label + (c.variant ? '（' + c.variant + '）' : '');

function card(line, clips, group) {
  const order = shuffled(clips, D.runId + '|' + group + '|' + line.id);
  const lk = group + '/' + line.id;
  const rows = order.map((c, i) => {
    const letter = String.fromCharCode(65 + i);
    const id = lk + '/' + c.key;
    const flags = FLAGS.map(([k, t]) => '<label><input type="checkbox" data-flag="' + k + '" data-id="' + h(id) + '"' + ((S.flags[id] || []).includes(k) ? ' checked' : '') + '> ' + t + '</label>').join('');
    const body = c.error
      ? '<div class="err">作れなかった: ' + h(c.error) + '</div>'
      : '<audio controls preload="none" data-raw="' + h(c.file) + '" data-norm="' + h(c.normFile || c.file) + '"></audio>'
        + '<div class="pick"><label><input type="radio" name="' + h(lk) + '" data-best="' + h(lk) + '" value="' + h(c.key) + '"' + (S.best[lk] === c.key ? ' checked' : '') + '> これが一番</label>' + flags + '</div>'
        + '<div class="m">最初の音まで ' + c.msFirst + ' ms ・ 全部届くまで ' + c.ms + ' ms ・ 長さ ' + f1(c.seconds, 2) + ' 秒（頭の無音 ' + f1(c.lead, 2) + '・いちばん長い間 ' + f1(c.longestGap, 2) + '・無音の合計 ' + f1(c.silence, 2) + '）・ 音量 ' + f1(c.rmsDb) + ' dB ・ ' + c.chars + ' 字 ・ 約 ' + f1(c.usd * D.jpy, 3) + ' 円</div>'
        + (c.heard != null ? '<div class="sent">機械の聞き取り: ' + h(c.heard || '（聞き取れず）') + '</div>' : '')
        + '<div class="sent">送った文: ' + h(c.sent || '') + (c.style && !(c.sent || '').includes(c.style) ? ' ／ 指示: ' + h(c.style) : '') + (c.modelUsed && c.modelUsed !== c.model ? ' ／ 実際のモデル: ' + h(c.modelUsed) : '') + '</div>';
    return '<div class="clip' + (S.best[lk] === c.key ? ' best' : '') + '" data-clip="' + h(id) + '"><div class="name" data-letter="' + letter + '" data-name="' + h(nameOf(c)) + '"></div>' + body + '</div>';
  }).join('');
  return '<div class="card"><div class="chips"><span class="chip">' + h(line.id) + '</span><span class="chip">' + (MOOD[line.mood] || line.mood) + '</span><span class="chip">' + (line.kind === 'action' ? '触れられた' : '言葉を受けた') + '</span><span class="chip">強さ ' + line.intensity + '</span><span class="chip">親しさ ' + line.affection + '</span></div>'
    + '<div class="text">' + h(line.text) + '</div><div class="why">' + h(line.why || '') + '</div><div class="clips">' + rows + '</div>'
    + '<input type="text" placeholder="メモ（気づいたこと）" data-memo="' + h(lk) + '" value="' + h(S.memo[lk] || '') + '"><div class="m" data-memomap="' + h(lk) + '"></div></div>';
}
function draw() {
  const main = D.lines.map((l) => { const cs = D.clips.filter((c) => c.line === l.id && inGroup(c, 'main')); return cs.length ? card(l, cs, 'main') : ''; }).join('');
  $('lines').innerHTML = main || '<p class="note">まだ音声がありません。</p>';
  const probe = !D.showProbe ? '' : D.lines.map((l) => { const cs = D.clips.filter((c) => c.line === l.id && inGroup(c, 'probe')); return cs.filter((c) => c.variant).length ? card(l, cs, 'probe') : ''; }).join('');
  $('probeWrap').innerHTML = probe ? '<h2>指示の言語と「……」の扱い（同じ口で、渡し方だけ替えた）</h2><p class="note">tag＝演技指示の言語（en・ja・none＝なし）、ellipsis＝「……」をそのまま渡す（keep）・... に替える（ascii）・読点に替える（comma）。</p>' + probe : '';
  apply();
}
function apply() {
  document.body.classList.toggle('blind', blind());
  for (const n of document.querySelectorAll('.name')) n.textContent = blind() ? n.dataset.letter : n.dataset.letter + ' ＝ ' + n.dataset.name;
  for (const a of document.querySelectorAll('audio')) { const want = $('norm').checked ? a.dataset.norm : a.dataset.raw; if (a.getAttribute('src') !== want) a.setAttribute('src', want); }
  for (const m of document.querySelectorAll('[data-memomap]')) m.textContent = S.memo[m.dataset.memomap] ? 'メモを書いたときの並び: ' + (S.memoMap[m.dataset.memomap] || '記録なし（口を足す前に書いたメモ）') : '';
  $('reveal').textContent = blind() ? '答え合わせ' : '名前を伏せる';
  const lines = new Set(D.clips.filter((c) => !c.error && (inGroup(c, 'main') || (D.showProbe && c.variant))).map((c) => (c.variant ? 'probe/' : 'main/') + c.line));
  $('count').textContent = '選んだ台詞 ' + Object.keys(S.best).length + ' / ' + lines.size;
  tally(); summary(); $('md').value = markdown();
}
const inGroup = (c, group) => !(D.hidden || []).includes(c.system) && (group === 'main' ? !c.variant : !!(c.variant || c.probeBase));
function counts(group) {
  const out = {}; const keyOf = (c) => (group === 'probe' ? (c.variant || '元のまま') : c.system);
  for (const c of D.clips) { if (!inGroup(c, group)) continue; const k = keyOf(c); out[k] = out[k] || { name: group === 'probe' ? k : D.systems[c.system].label, best: 0, of: 0, flags: {} }; }
  for (const [lk, key] of Object.entries(S.best)) {
    if (!lk.startsWith(group + '/')) continue;
    const c = D.clips.find((x) => x.key === key); if (c && inGroup(c, group)) out[keyOf(c)].best++;
    const id = lk.slice(group.length + 1); for (const x of D.clips) if (x.line === id && !x.error && inGroup(x, group)) out[keyOf(x)].of++;
  }
  for (const [id, fl] of Object.entries(S.flags)) { if (!id.startsWith(group + '/')) continue; const c = D.clips.find((x) => x.key === id.split('/').slice(2).join('/')); if (!c || !inGroup(c, group)) continue; for (const k of fl) out[keyOf(c)].flags[k] = (out[keyOf(c)].flags[k] || 0) + 1; }
  return out;
}
function tallyRows(group) { const c = counts(group); return Object.values(c).map((v) => [v.name, v.best + ' / ' + v.of, ...FLAGS.map(([k]) => v.flags[k] || 0)]); }
function table(head, rows) { return '<table><tr>' + head.map((x) => '<th>' + h(x) + '</th>').join('') + '</tr>' + rows.map((r) => '<tr>' + r.map((x) => '<td>' + h(x) + '</td>').join('') + '</tr>').join('') + '</table>'; }
const TALLY_HEAD = ['口', '一番に選んだ', ...FLAGS.map(([, t]) => t)];
function tally() { const p = tallyRows('probe'); $('tally').innerHTML = table(TALLY_HEAD, tallyRows('main')) + (p.length ? '<p class="note">渡し方の比べ</p>' + table(['渡し方', ...TALLY_HEAD.slice(1)], p) : ''); }
const SUM_HEAD = ['口', '本数', '最初の音まで（中央）', '同（最大）', '全部届くまで（中央）', '無音の割合', '音量', '1 本あたり', '合計'];
function sumRows() { return D.summary.filter((s) => !(D.hidden || []).includes(s.id)).map((s) => [s.label, s.n + (s.errors ? '（失敗 ' + s.errors + '）' : ''), s.n ? s.firstP50 + ' ms' : '—', s.n ? s.firstMax + ' ms' : '—', s.n ? s.totalP50 + ' ms' : '—', s.n ? f1(s.silenceRatio * 100, 0) + ' %' : '—', s.n ? f1(s.rmsDb) + ' dB' : '—', s.n ? f1(s.usdPerLine * D.jpy, 3) + ' 円' : '—', s.n ? f1(s.usd * D.jpy, 2) + ' 円' : '—']); }
function summary() { $('summary').innerHTML = table(SUM_HEAD, sumRows()); }
const mdTable = (head, rows) => '| ' + head.join(' | ') + ' |\\n|' + head.map((_, i) => (i ? '--:' : ':--')).join('|') + '|\\n' + rows.map((r) => '| ' + r.join(' | ') + ' |').join('\\n') + '\\n';
function markdown() {
  let md = '### 声の聞き比べ（' + D.title + '）\\n\\n' + mdTable(TALLY_HEAD, tallyRows('main')) + '\\n';
  const p = tallyRows('probe'); if (p.some((r) => !/^0 /.test(r[1]))) md += mdTable(['渡し方', ...TALLY_HEAD.slice(1)], p) + '\\n';
  md += mdTable(SUM_HEAD, sumRows()) + '\\n';
  const memos = Object.entries(S.memo).filter(([, v]) => v); const picks = Object.entries(S.best);
  if (picks.length) md += '選んだもの: ' + picks.map(([lk, key]) => { const c = D.clips.find((x) => x.key === key); return lk.split('/')[1] + '（' + lk.split('/')[0] + '）→ ' + (c ? nameOf(c) : '?'); }).join('／') + '\\n\\n';
  if (memos.length) md += memos.map(([lk, v]) => '- ' + lk.split('/')[1] + ': ' + v + (S.memoMap[lk] ? '（' + S.memoMap[lk] + '）' : '')).join('\\n') + '\\n';
  return md;
}
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.best) { S.best[t.dataset.best] = t.value; for (const c of t.closest('.clips').children) c.classList.toggle('best', c.contains(t)); }
  else if (t.dataset.flag) { const a = new Set(S.flags[t.dataset.id] || []); t.checked ? a.add(t.dataset.flag) : a.delete(t.dataset.flag); if (a.size) S.flags[t.dataset.id] = [...a]; else delete S.flags[t.dataset.id]; }
  else if (t.dataset.memo) { S.memo[t.dataset.memo] = t.value; S.memoMap[t.dataset.memo] = [...t.closest('.card').querySelectorAll('.name')].map((x) => x.dataset.letter + '＝' + x.dataset.name).join('・'); }
  save(); apply();
});
document.addEventListener('play', (e) => { for (const a of document.querySelectorAll('audio')) if (a !== e.target) a.pause(); }, true);
$('reveal').onclick = () => { $('blind').checked = !$('blind').checked; apply(); };
$('copy').onclick = async () => { const md = markdown(); try { await navigator.clipboard.writeText(md); $('copy').textContent = '写した'; } catch { $('md').select(); $('copy').textContent = '下の欄から写して'; } setTimeout(() => { $('copy').textContent = '選んだ結果を写す'; }, 1600); };
draw();
</script>
</body>
</html>
`;
}
