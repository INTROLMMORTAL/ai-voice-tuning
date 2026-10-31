import { designBiquad, Biquad } from '../src/dsp-processing/dsp-core.js';
export const FS = 48000;
export function rng(seed = 1) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
export const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));
export const lin = (d) => Math.pow(10, d / 20);
export const rmsDb = (a, s = 0, e = a.length) => { let q = 0; for (let i = s; i < e; i++) q += a[i] * a[i]; return 10 * Math.log10(q / (e - s) + 1e-14); };
export function sine(f, dbfs, sec, fs = FS) { const n = Math.round(sec * fs), o = new Float32Array(n), A = lin(dbfs) * Math.SQRT2; for (let i = 0; i < n; i++) o[i] = A * Math.sin(2 * Math.PI * f * i / fs); return o; }
export function noise(dbfs, sec, seed = 3, fs = FS) { const r = rng(seed), n = Math.round(sec * fs), o = new Float32Array(n), A = lin(dbfs); for (let i = 0; i < n; i++) o[i] = A * gauss(r); return o; }
export function process(dsp, x, block = 128) { const o = new Float32Array(x.length); for (let i = 0; i < x.length; i += block) { const e = Math.min(x.length, i + block); dsp.process(x.subarray(i, e), o.subarray(i, e)); } return o; }
/** Синтетическая «речь»: гармоники f0 со спадом −6 дБ/окт, слоговая огибающая 3 Гц, сибилянты (шум 5–9 кГц). */
export function speech({ sec = 6, f0 = 110, dbfs = -26, sib = 0.0, seed = 7, fs = FS } = {}) {
  const r = rng(seed), n = Math.round(sec * fs), o = new Float32Array(n), bp = new Biquad(); bp.c = designBiquad('bandpass', fs, 7000, 1.0);
  for (let i = 0; i < n; i++) {
    const t = i / fs, env = Math.pow(Math.max(0, Math.sin(2 * Math.PI * 1.5 * t)), 0.5);
    let v = 0; for (let h = 1; h <= 40 && f0 * h < 8000; h++) v += Math.sin(2 * Math.PI * f0 * h * t + h) / h;
    o[i] = v * env;
  }
  // нормировка по активным участкам
  let q = 0, c = 0; for (let i = 0; i < n; i++) if (Math.abs(o[i]) > 1e-3) { q += o[i] * o[i]; c++; }
  const g = lin(dbfs) / Math.sqrt(q / c); for (let i = 0; i < n; i++) o[i] *= g;
  if (sib > 0) for (let b = 0.4; b < sec - 0.3; b += 1.2) { const s0 = Math.round(b * fs), len = Math.round(0.12 * fs); for (let i = 0; i < len; i++) { const w = Math.sin(Math.PI * i / len); o[s0 + i] += bp.run(gauss(r)) * lin(dbfs) * sib * w * 3; } }
  return o;
}
export const concat = (...a) => { const o = new Float32Array(a.reduce((s, x) => s + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
export const add = (a, b) => { const o = Float32Array.from(a); for (let i = 0; i < o.length; i++) o[i] += b[i % b.length]; return o; };
