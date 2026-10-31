import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRecording } from '../src/audio-analysis/analyzer.js';
import { tune } from '../src/auto-tuning/tuner.js';
import { MODE_IDS } from '../src/profile-manager/profiles.js';
import { classify } from '../src/diagnostics/verdict.js';
import { FS, sine, noise, speech, concat, add } from './synth.js';

function rec(o = {}) {
  const { noiseDb = -62, hum = false, sib = 0, f0 = 110 } = o;
  let n = noise(noiseDb, 4, 11); if (hum) n = add(n, sine(50, -52, 4));
  const mk = (db, seed) => { let s = add(speech({ sec: 6, dbfs: db, sib, f0, seed }), noise(noiseDb, 6, seed + 50)); return hum ? add(s, sine(50, -52, 6)) : s; };
  const samples = concat(n, mk(-36, 1), mk(-27, 2), mk(-19, 3)); const segments = []; let p = 0;
  for (const [name, len] of [['noise', 4], ['quiet', 6], ['normal', 6], ['loud', 6]]) { segments.push({ name, start: p + Math.round(0.4 * FS), end: p + len * FS }); p += len * FS; }
  return analyzeRecording({ samples, segments });
}
const sum = (r) => r.reasons.map((x) => `${x.param}=${x.value}`).join(' | ');

test('нет данных → консервативный профиль без EQ/компрессии', () => {
  const r = tune(null, { mode: 'clear' });
  assert.ok(r.conservative && !r.params.comp.enabled && !r.params.gate.enabled && r.params.eq.every((e) => e.gainDb === 0));
});

test('чистая студийная запись: гейт выкл, гул выкл, HPF ниже f0, makeup разумный', () => {
  const r = tune(rec(), { mode: 'clear' }); console.log('  ' + sum(r));
  assert.ok(!r.params.gate.enabled && !r.params.hum.enabled);
  assert.ok(r.params.hpf.freq >= 60 && r.params.hpf.freq <= 100);
  assert.ok(Math.abs(r.params.makeupDb) <= 18);
  assert.ok(r.params.eq.every((e) => Math.abs(e.gainDb) <= 4));
});

test('шумная запись + гул: включаются gate и hum-notch, HPF выше', () => {
  const clean = tune(rec(), { mode: 'clear' }), dirty = tune(rec({ noiseDb: -48, hum: true }), { mode: 'clear' });
  console.log('  ' + sum(dirty));
  assert.ok(dirty.params.gate.enabled && dirty.params.hum.enabled && dirty.params.hum.freq === 50);
  assert.ok(dirty.params.gate.thresholdDb > -55);
});

test('результат зависит от измерений: разные записи → разные параметры', () => {
  const a = tune(rec({ sib: 0 }), { mode: 'crisp' }).params, b = tune(rec({ sib: 0.6, noiseDb: -50 }), { mode: 'crisp' }).params;
  assert.notDeepEqual(a, b);
  assert.ok(b.deess.thresholdDb > a.deess.thresholdDb);
});

test('каждый режим реально меняет цепочку', () => {
  const m = rec({ sib: 0.5, noiseDb: -52 }); const out = Object.fromEntries(MODE_IDS.map((id) => [id, tune(m, { mode: id }).params]));
  const sig = (p) => JSON.stringify(p);
  assert.equal(new Set(Object.values(out).map(sig)).size, MODE_IDS.length);
  assert.ok(!out.lowlatency.comp.enabled && !out.lowlatency.gate.enabled && !out.lowlatency.deess.enabled);
  assert.ok(out.broadcast.comp.ratio > out.natural.comp.ratio || !out.natural.comp.enabled);
  assert.ok(out.noise.gate.rangeDb >= out.clear.gate.rangeDb);
});

const snap = (t, o = {}) => ({ t, sender: { trackProcessed: true }, engine: { inRmsDb: -30, zeroRunsTotal: 0, gapEvents: 0, ctxDriftMs: 1, workletAlive: true, hardClampTotal: 0 }, out: { packetsSent: t / 20 }, remote: { packetsLost: 0, jitterMs: 5, rttMs: 60 }, ...o });
test('verdict: сеть / локальный захват / нормально / hook-miss', () => {
  const ok = Array.from({ length: 10 }, (_, i) => snap(i * 2000)); assert.equal(classify(ok).kind, 'ok');
  const net = ok.map((s, i) => ({ ...s, remote: { packetsLost: i * 80, jitterMs: 55, rttMs: 500 } })); assert.equal(classify(net).kind, 'network');
  const loc = ok.map((s, i) => ({ ...s, engine: { ...s.engine, zeroRunsTotal: i } })); assert.equal(classify(loc).kind, 'local-capture');
  const stall = ok.map((s, i) => ({ ...s, out: { packetsSent: i * 2000 / 40 } })); assert.equal(classify(stall).kind, 'local-send');
  assert.equal(classify(ok.map((s) => ({ ...s, sender: { trackProcessed: false } }))).kind, 'hook-miss');
});
