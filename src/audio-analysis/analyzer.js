// Офлайн-анализ записи калибровки. Чистые DSP-метрики; субъективные оценки («приятность») не вычисляются.
import { designBiquad, Biquad } from '../dsp-processing/dsp-core.js';

const FRAME = 2048, HOP = 1024;
const db10 = (x) => 10 * Math.log10(x + 1e-14);
const pct = (arr, p) => { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);

const twCache = new Map();
export function fft(re, im) {
  const n = re.length;
  let tw = twCache.get(n);
  if (!tw) { tw = { c: new Float64Array(n / 2), s: new Float64Array(n / 2) }; for (let i = 0; i < n / 2; i++) { tw.c[i] = Math.cos(2 * Math.PI * i / n); tw.s[i] = -Math.sin(2 * Math.PI * i / n); } twCache.set(n, tw); }
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < half; k++) {
      const wr = tw.c[k * step], wi = tw.s[k * step], a = i + k, b = a + half;
      const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
      re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
    }
  }
}

/** K-взвешивание ITU-R BS.1770 (коэффициенты для 48 кГц). */
export function kWeight(x) {
  const s1 = { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 };
  const s2 = { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 };
  const A = new Biquad(), B = new Biquad(); A.c = s1; B.c = s2;
  const o = new Float32Array(x.length); for (let i = 0; i < x.length; i++) o[i] = B.run(A.run(x[i])); return o;
}
/** Интегральная громкость диапазонов (LUFS-подобная, без относительного гейта) */
export function lufsOfRanges(samples, ranges) {
  const k = kWeight(samples); let q = 0, n = 0;
  for (const [s, e] of ranges) for (let i = s; i < e; i++) { q += k[i] * k[i]; n++; }
  return -0.691 + db10(q / Math.max(1, n));
}

const BANDS = {
  sub: [20, 80], b125: [88, 177], b250: [177, 354], b500: [354, 707], b1k: [707, 1414], b2k: [1414, 2828], b4k: [2828, 5657], b8k: [5657, 11314],
  sib: [5000, 9000], pres: [2000, 4500], mud: [150, 400], harsh: [3500, 6500],
};
const CENTER = { b125: 125, b250: 250, b500: 500, b1k: 1000, b2k: 2000, b4k: 4000, b8k: 8000 };

function f0Autocorr(frame, fs) { // грубая оценка на децимированном (÷4) кадре; только для HPF и статистики
  const d = 4, n = Math.floor(frame.length / d), x = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < d; k++) s += frame[i * d + k]; x[i] = s / d; }
  const f = fs / d, lo = Math.floor(f / 400), hi = Math.floor(f / 70); let e0 = 0; for (let i = 0; i < n; i++) e0 += x[i] * x[i];
  if (e0 < 1e-9) return null; let best = 0, bl = 0;
  for (let l = lo; l <= hi; l++) { let s = 0, e1 = 0; for (let i = 0; i + l < n; i++) { s += x[i] * x[i + l]; e1 += x[i + l] * x[i + l]; } const r = s / Math.sqrt(e0 * e1 + 1e-12); if (r > best) { best = r; bl = l; } }
  return best > 0.6 ? f / bl : null;
}

function welchHum(noise, fs) {
  const N = 16384; if (noise.length < N) return null;
  const P = new Float64Array(N / 2); let cnt = 0;
  for (let s = 0; s + N <= noise.length; s += N / 2) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = noise[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    fft(re, im); for (let k = 0; k < N / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k]; cnt++;
  }
  const bin = fs / N, at = (f) => Math.round(f / bin);
  const prom = (f) => { // выступ пика над медианой окрестности, дБ
    const c = at(f); let pk = 0; for (let k = c - 2; k <= c + 2; k++) pk = Math.max(pk, P[k]);
    const nb = []; for (let k = c - at(40); k <= c + at(40); k++) if (Math.abs(k - c) > 4) nb.push(P[k]);
    nb.sort((a, b) => a - b); return db10(pk / (nb[nb.length >> 1] + 1e-30));
  };
  let best = null;
  for (const base of [50, 60]) { const ps = [1, 2, 3].map((h) => prom(base * h)); const m = mean(ps); if (!best || m > best.prominenceDb) best = { freq: base, prominenceDb: m, harmonics: ps }; }
  best.detected = best.prominenceDb > 10; return best;
}

/**
 * @param samples Float32Array моно 48 кГц; segments: [{name:'noise'|'quiet'|'normal'|'loud', start, end}] (в сэмплах)
 */
export function analyzeRecording({ samples, fs = 48000, segments }) {
  const warnings = [];
  if (fs !== 48000) warnings.push('FS_NOT_48K');
  const kw = kWeight(samples);
  const bpS = new Float32Array(samples.length); { const bp = new Biquad(); bp.c = designBiquad('bandpass', fs, 6500, 1.2); for (let i = 0; i < samples.length; i++) bpS[i] = bp.run(samples[i]); }
  const win = new Float64Array(FRAME); let w2 = 0; for (let i = 0; i < FRAME; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FRAME); w2 += win[i] * win[i]; }
  const binHz = fs / FRAME, frames = [];
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  let clippedTotal = 0, zeroRuns = 0, maxZeroMs = 0;
  for (const seg of segments) {
    let run = 0, prevLoud = 1e9;
    for (let i = seg.start; i < seg.end; i++) { // дропауты: внезапная цифровая тишина после громкого сигнала
      const v = samples[i]; if (Math.abs(v) >= 0.999) clippedTotal++;
      if (v === 0) { run++; if (run === 480 && prevLoud < 2900 && seg.name !== 'noise') zeroRuns++; maxZeroMs = Math.max(maxZeroMs, run / fs * 1000); } else run = 0;
      if (Math.abs(v) > 0.02) prevLoud = 0; else prevLoud++;
    }
    for (let s = seg.start; s + FRAME <= seg.end; s += HOP) {
      let q = 0, pk = 0, kq = 0, bq = 0; for (let i = 0; i < FRAME; i++) { const v = samples[s + i]; q += v * v; kq += kw[s + i] ** 2; bq += bpS[s + i] ** 2; if (Math.abs(v) > pk) pk = Math.abs(v); }
      for (let i = 0; i < FRAME; i++) { re[i] = samples[s + i] * win[i]; im[i] = 0; } fft(re, im);
      const bands = {}; for (const [k, [lo, hi]] of Object.entries(BANDS)) { let p = 0; for (let b = Math.max(1, Math.floor(lo / binHz)); b <= Math.min(FRAME / 2 - 1, Math.floor(hi / binHz)); b++) p += re[b] * re[b] + im[b] * im[b]; bands[k] = 2 * p / (FRAME * w2); }
      frames.push({ seg: seg.name, s, ms: q / FRAME, rmsDb: db10(q / FRAME), peakDb: 20 * Math.log10(pk + 1e-12), kMs: kq / FRAME, sibIdxDb: db10(bq / FRAME) - db10(q / FRAME), bands });
    }
  }
  const noiseSeg = segments.find((s) => s.name === 'noise');
  const nf = frames.filter((f) => f.seg === 'noise');
  const allSpeech = frames.filter((f) => f.seg !== 'noise');
  let noiseFloorDb, noiseFromGaps = false;
  if (nf.length >= 3) noiseFloorDb = db10(mean(nf.map((f) => f.ms)));
  else { noiseFromGaps = true; noiseFloorDb = pct(allSpeech.map((f) => f.rmsDb), 0.1); warnings.push('NO_NOISE_SEGMENT'); }
  const speech = allSpeech.filter((f) => f.rmsDb > noiseFloorDb + 10 && f.rmsDb > -55);
  const speechSec = speech.length * HOP / fs;
  if (speechSec < 6) warnings.push('NOT_ENOUGH_SPEECH');
  if (!speech.length) return { ok: false, warnings, confidence: 0 };

  const bandDb = (list, k) => db10(mean(list.map((f) => f.bands[k])));
  const sp = {}, nz = {}; for (const k of Object.keys(BANDS)) { sp[k] = bandDb(speech, k); nz[k] = nf.length ? bandDb(nf, k) : NaN; }
  const rel = {}; for (const k of Object.keys(CENTER)) rel[k] = sp[k] - sp.b1k;
  // наклон спектра, dB/oct (регрессия по 250..8k)
  const xs = ['b250', 'b500', 'b1k', 'b2k', 'b4k', 'b8k'].map((k) => Math.log2(CENTER[k])), ys = ['b250', 'b500', 'b1k', 'b2k', 'b4k', 'b8k'].map((k) => sp[k]);
  const mx = mean(xs), my = mean(ys); const tilt = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);

  const speechMs = mean(speech.map((f) => f.ms)), speechRmsDb = db10(speechMs);
  const peakDb = Math.max(...speech.map((f) => f.peakDb));
  const lufs = -0.691 + db10(mean(speech.map((f) => f.kMs)));
  const rmsList = speech.map((f) => f.rmsDb);
  const segLevels = {}; for (const n of ['quiet', 'normal', 'loud']) { const l = speech.filter((f) => f.seg === n); if (l.length) segLevels[n] = db10(mean(l.map((f) => f.ms))); }
  const lv = Object.values(segLevels);

  const f0s = []; { let c = 0; for (const f of speech) { if (c++ % 2) continue; const v = f0Autocorr(samples.subarray(f.s, f.s + FRAME), fs); if (v) f0s.push(v); } }
  const noiseSamples = noiseSeg ? samples.subarray(noiseSeg.start + Math.round(0.3 * fs), noiseSeg.end) : null;
  const hum = noiseSamples ? welchHum(noiseSamples, fs) : null;

  let bandwidthHz = 0; for (const k of ['b125', 'b250', 'b500', 'b1k', 'b2k', 'b4k', 'b8k']) if (!nf.length || sp[k] - nz[k] > 10) bandwidthHz = BANDS[k][1];
  const upstreamGate = nf.length >= 3 && nf.filter((f) => f.rmsDb < -85).length / nf.length > 0.8;
  if (upstreamGate) warnings.push('UPSTREAM_GATE');
  if (clippedTotal > 0) warnings.push('CLIPPING');
  if (zeroRuns > 0) warnings.push('DROPOUTS');
  if (hum && hum.detected) warnings.push('HUM');

  const confidence = Math.max(0, Math.min(1, (speechSec / 12) * 0.5 + (nf.length >= 3 ? 0.3 : 0) + (Object.keys(segLevels).length >= 3 ? 0.2 : 0.07)));
  return {
    ok: true, fs, warnings, confidence, speechSec,
    levels: { speechRmsDb, speechLufs: lufs, peakDb, crestDb: peakDb - speechRmsDb, noiseFloorDb, snrDb: speechRmsDb - noiseFloorDb, noiseFromGaps },
    dynamics: { drDb: pct(rmsList, 0.95) - pct(rmsList, 0.1), segLevelsDb: segLevels, segSpreadDb: lv.length > 1 ? Math.max(...lv) - Math.min(...lv) : 0, peakP50Db: pct(speech.map((f) => f.peakDb), 0.5), peakP40Db: pct(speech.map((f) => f.peakDb), 0.4) },
    clipping: { clippedSamples: clippedTotal },
    spectrum: { speechBandsDb: sp, noiseBandsDb: nz, relTo1kDb: rel, tiltDbPerOct: tilt, bandwidthHz },
    noise: { hum, rumbleDb: nf.length ? nz.sub - nz.b500 : NaN, hissDb: nf.length ? (nz.b8k - nz.b1k) : NaN, upstreamGate },
    sibilance: { idxP50Db: pct(speech.map((f) => f.sibIdxDb), 0.5), idxP75Db: pct(speech.map((f) => f.sibIdxDb), 0.75), idxP90Db: pct(speech.map((f) => f.sibIdxDb), 0.9), idxP95Db: pct(speech.map((f) => f.sibIdxDb), 0.95) },
    pitch: { medianHz: f0s.length ? pct(f0s, 0.5) : null, p10Hz: f0s.length ? pct(f0s, 0.1) : null, voicedFrames: f0s.length }, // используется только для расчёта HPF
    clarityProxy: { presenceSnrDb: nf.length ? sp.pres - nz.pres : NaN, note: 'прокси: отношение сигнал/шум в полосе 2–4.5 кГц, это не STOI/PESQ' },
    dropouts: { suddenSilenceRuns: zeroRuns, maxZeroRunMs: maxZeroMs },
  };
}
