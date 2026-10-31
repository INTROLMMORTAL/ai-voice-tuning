import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRecording, fft, lufsOfRanges } from '../src/audio-analysis/analyzer.js';
import { FS, sine, noise, speech, concat, add, db, lin } from './synth.js';

function rec({ noiseDb = -62, hum = false, humDb = -52, sib = 0.0, f0 = 110, clip = false, dropout = false } = {}) {
  let n = noise(noiseDb, 4, 11); if (hum) n = add(n, sine(50, humDb, 4)); if (hum) n = add(n, sine(100, humDb - 4, 4));
  const mkSeg = (db, seed) => { let s = speech({ sec: 6, dbfs: db, sib, f0, seed }); s = add(s, noise(noiseDb, 6, seed + 50)); return hum ? add(s, sine(50, humDb, 6)) : s; };
  let q = mkSeg(-36, 1), nm = mkSeg(-27, 2), l = mkSeg(-19, 3);
  if (clip) l = l.map((v) => Math.max(-1, Math.min(1, v * 8)));
  if (dropout) { for (let i = 38600; i < 38600 + 2400; i++) nm[i] = 0; }
  const samples = concat(n, q, nm, l); const segs = []; let p = 0;
  for (const [name, len] of [['noise', 4], ['quiet', 6], ['normal', 6], ['loud', 6]]) { segs.push({ name, start: p + Math.round(0.4 * FS), end: p + len * FS }); p += len * FS; }
  return { samples, segments: segs };
}

test('FFT: синус 1 кГц даёт пик в нужном бине', () => {
  const N = 2048, re = new Float64Array(N), im = new Float64Array(N); const s = sine(1000, -6, 1); for (let i = 0; i < N; i++) re[i] = s[i];
  fft(re, im); let b = 0, m = 0; for (let k = 1; k < N / 2; k++) { const v = re[k] ** 2 + im[k] ** 2; if (v > m) { m = v; b = k; } }
  assert.ok(Math.abs(b * FS / N - 1000) < FS / N);
});

test('чистая запись: уровни, шум, f0, отсутствие ложных тревог', () => {
  const r = analyzeRecording(rec());
  console.log('  levels', JSON.stringify(r.levels, (k, v) => typeof v === 'number' ? +v.toFixed(1) : v), 'f0', r.pitch.medianHz?.toFixed(1), 'DR', r.dynamics.drDb.toFixed(1), 'spread', r.dynamics.segSpreadDb.toFixed(1));
  assert.ok(r.ok); assert.ok(Math.abs(r.levels.noiseFloorDb - -62) < 2);
  assert.ok(Math.abs(r.pitch.medianHz - 110) < 6);
  assert.ok(r.dynamics.segSpreadDb > 12 && r.dynamics.segSpreadDb < 20);
  assert.ok(!r.warnings.includes('CLIPPING') && !r.warnings.includes('HUM') && !r.warnings.includes('DROPOUTS'));
  assert.ok(r.confidence > 0.8);
});

test('гул 50 Гц определяется и отличается от 60 Гц', () => {
  const r = analyzeRecording(rec({ hum: true }));
  console.log('  hum', JSON.stringify(r.noise.hum, (k, v) => typeof v === 'number' ? +v.toFixed(1) : v));
  assert.ok(r.noise.hum.detected && r.noise.hum.freq === 50);
  assert.ok(!analyzeRecording(rec()).noise.hum.detected);
});

test('клиппинг и внезапные цифровые обрывы фиксируются', () => {
  assert.ok(analyzeRecording(rec({ clip: true })).warnings.includes('CLIPPING'));
  const r = analyzeRecording(rec({ dropout: true })); assert.ok(r.warnings.includes('DROPOUTS'), JSON.stringify(r.dropouts));
});

test('K-weighted громкость: синус 1 кГц с RMS −20 dBFS ≈ −20.0 LUFS (BS.1770, ±0.3)', () => {
  const x = sine(1000, -20, 3); const l = lufsOfRanges(x, [[24000, x.length]]);
  console.log('  LUFS', l.toFixed(2)); assert.ok(Math.abs(l + 20.0) < 0.3);
});

test('сибилянты: яркая запись даёт больший idxP90, чем без шипящих', () => {
  const a = analyzeRecording(rec({ sib: 0 })).sibilance.idxP90Db, b = analyzeRecording(rec({ sib: 0.6 })).sibilance.idxP90Db;
  console.log('  sibIdx P90: no sib', a.toFixed(1), ' with sib', b.toFixed(1)); assert.ok(b > a + 3);
});
