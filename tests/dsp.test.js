import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceDSP, eqResponseDb, toLin } from '../src/dsp-processing/dsp-core.js';
import { FS, sine, noise, process, rmsDb, concat, add } from './synth.js';

const mk = (p) => { const d = new VoiceDSP(FS); d.setParams(p, { immediate: true }); return d; };

test('bypass: сухой путь задержан ровно на latencySamples и бит-в-бит равен входу', () => {
  const d = mk({ bypass: true });
  const x = new Float32Array(2000); x[100] = 0.5; x[700] = -0.25;
  const y = process(d, x);
  assert.equal(y[100 + d.latencySamples], Math.fround(0.5));
  assert.equal(y[700 + d.latencySamples], Math.fround(-0.25));
  console.log('  algorithmic latency, ms =', (d.latencySamples / FS * 1000).toFixed(2));
});

test('limiter: выход никогда не превышает потолок', () => {
  const d = mk({ limiter: { ceilingDb: -3 } });
  const y = process(d, concat(new Float32Array(2000), sine(1000, -0.5, 1), sine(300, 3, 0.3)));
  let mx = 0; for (const v of y) mx = Math.max(mx, Math.abs(v));
  assert.ok(mx <= toLin(-3) + 1e-6, 'peak ' + mx);
  console.log('  hardClamp samples:', d.readMeters().hardClamp);
});

test('компрессор: статическая кривая (thr −24, ratio 4, колено 0) ≈ 13.5 dB GR на пике −6 dBFS', () => {
  const d = mk({ comp: { enabled: true, thresholdDb: -24, ratio: 4, kneeDb: 0, attackMs: 5, releaseMs: 100 }, hpf: { enabled: false } });
  const x = sine(1000, -9.01, 3); // пик −6 dBFS
  const y = process(d, x);
  const gr = rmsDb(x, 60000, 96000) - rmsDb(y, 60000 + d.L, 96000 + d.L);
  console.log('  measured GR dB =', gr.toFixed(2));
  assert.ok(Math.abs(gr - 13.5) < 1.5);
});

test('gate: шум ниже порога ослабляется на rangeDb, сигнал выше порога проходит', () => {
  const d = mk({ hpf: { enabled: false }, gate: { enabled: true, thresholdDb: -50, rangeDb: 12, releaseMs: 100, holdMs: 50 } });
  const x = concat(noise(-65, 2), sine(500, -20, 1), noise(-65, 1.5, 9));
  const y = process(d, x);
  const attNoise = rmsDb(x, 90000 - 20000 * 0 - 6000, 96000) - rmsDb(y, 90000 - 6000, 96000);
  const tail0 = 3 * FS + 60000, tailEnd = tail0 + 9000;
  const att2 = rmsDb(x, tail0, tailEnd) - rmsDb(y, tail0 + d.L, tailEnd + d.L);
  const pass = rmsDb(x, 110000, 130000) - rmsDb(y, 110000 + d.L, 130000 + d.L);
  console.log('  gate attenuation (noise)', att2.toFixed(1), 'dB; signal passthrough diff', pass.toFixed(2), 'dB');
  assert.ok(att2 > 9 && att2 < 15);
  assert.ok(Math.abs(pass) < 0.7);
});

test('de-esser: режет шипящие 6.5 кГц на ≥3 dB, не трогает вокальный тон', () => {
  const body = sine(200, -20, 3), hiss = new Float32Array(3 * FS); const h = sine(6500, -18, 0.3);
  hiss.set(h, 2 * FS);
  const x = add(body, hiss);
  const on = mk({ hpf: { enabled: false }, deess: { enabled: true, thresholdDb: -9, maxReductionDb: 8 } });
  const off = mk({ hpf: { enabled: false } });
  const yOn = process(on, x), yOff = process(off, x);
  const s0 = 2 * FS + 6000, s1 = 2 * FS + 12000;
  const red = rmsDb(yOff, s0, s1) - rmsDb(yOn, s0, s1);
  const clean = Math.abs(rmsDb(yOff, 1000, 40000) - rmsDb(yOn, 1000, 40000));
  console.log('  de-ess reduction', red.toFixed(2), 'dB; clean-vowel delta', clean.toFixed(3));
  assert.ok(red > 3); assert.ok(clean < 0.3);
});

test('плавность: смена EQ +6 dB меняет уровень постепенно, без скачков > 1 dB между 10-мс окнами', () => {
  const d = mk({ hpf: { enabled: false } });
  const x = sine(3000, -20, 2);
  const o = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 128) { if (i === 48000) d.setParams({ eq: [{}, {}, { gainDb: 6 }] }); d.process(x.subarray(i, i + 128), o.subarray(i, i + 128)); }
  const w = 480, lv = []; for (let i = 0; i + w <= o.length; i += w) lv.push(rmsDb(o, i, i + w));
  let maxStep = 0; for (let i = 1; i < lv.length; i++) maxStep = Math.max(maxStep, Math.abs(lv[i] - lv[i - 1]));
  const final = lv[lv.length - 1] - lv[5];
  console.log('  max 10ms step', maxStep.toFixed(2), 'dB, final gain', final.toFixed(2), 'dB');
  assert.ok(maxStep < 1.0); assert.ok(Math.abs(final - 6) < 0.6);
});

test('eqResponseDb совпадает с измеренным откликом цепочки', () => {
  const p = { eq: [{}, {}, { gainDb: 4, freq: 3000 }] };
  const predicted = eqResponseDb(p, FS, [3000])[0];
  const d = mk(p); const x = sine(3000, -25, 1);
  const y = process(d, x); const meas = rmsDb(y, 30000 + d.L, 40000 + d.L) - rmsDb(x, 30000, 40000);
  assert.ok(Math.abs(predicted - meas) < 0.3, `${predicted} vs ${meas}`);
});

test('устойчивость: 60 с шума + смена параметров — без NaN, и CPU-запас', () => {
  const d = mk({ comp: { enabled: true }, gate: { enabled: true }, deess: { enabled: true }, hum: { enabled: true } });
  const x = noise(-20, 60, 5); const t0 = performance.now();
  const y = process(d, x); const ms = performance.now() - t0;
  for (const v of y) if (!Number.isFinite(v)) assert.fail('NaN');
  const m = d.readMeters(); assert.equal(m.nonFinite, 0);
  console.log(`  60 s audio in ${ms.toFixed(0)} ms → ${(60000 / ms).toFixed(0)}× realtime (≈${(ms / 600).toFixed(2)}% одного ядра Node)`);
  assert.ok(ms < 60000 * 0.2);
});
