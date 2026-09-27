/**
 * Jev に渡す state の形（鍵なしで確かめられる範囲）。
 *   node test/run.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildState } from '../lib/jev.mjs';

const base = { persona: { 名前: '日向まひろ' }, scene: '部室', history: [{ role: 'assistant', text: '……本は、好きですか' }], playerLine: '好きだよ。最近は詩集を読んでる', affection: 66 };
const action = { id: 'pat', label: '頭をなでる', detail: 'プレイヤーがまひろの頭を手でなでる' };

test('ふつうの手: 発言が入り、注意は入らない', () => {
  const st = buildState(base);
  assert.equal(st['プレイヤーの直前の発言'], base.playerLine);
  assert.equal(st['注意'], undefined);
});

test('彼女の問いへの返事の手: 注意と発言の両方が入る', () => {
  const st = buildState({ ...base, probe: true });
  assert.ok(st['注意'], '注意が無い');
  assert.ok(st['プレイヤーの直前の発言'], '発言が無い（Jev が発言を見ずに判定してしまう）');
  assert.ok(st['プレイヤーの直前の発言'].endsWith(base.playerLine));
});

test('触れる手: 行為と続いた回数が入る', () => {
  const st = buildState({ ...base, playerLine: '（行為: 頭をなでる。）', action, repeat: 1 });
  assert.ok(st['プレイヤーの直前の行為'].startsWith('頭をなでる'));
  assert.equal(st['同じ行為が続いた回数'], 1);
});

test('問いのあとに触れた手: 行為も発言も抜けない', () => {
  const st = buildState({ ...base, playerLine: '（行為: 頭をなでる。）', action, probe: true });
  assert.ok(st['プレイヤーの直前の行為']);
  assert.equal(st['プレイヤーの直前の発言'], '（行為: 頭をなでる。）');
});

test('履歴は直近 6 つまで', () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', text: 'h' + i }));
  assert.equal(buildState({ ...base, history })['これまでのやりとり'].length, 6);
});
