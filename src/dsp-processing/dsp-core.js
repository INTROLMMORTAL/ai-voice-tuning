// Чистое DSP-ядро. Работает и в AudioWorkletGlobalScope, и в Node (тесты, офлайн-рендер для A/B).
// Цепочка: gain → HPF(24 dB/oct) → [hum-notch ×3] → EQ(5 полос) → gate/expander → de-esser → компрессор → makeup → limiter(lookahead) → mix(bypass)
export const toDb = (x) => 20 * Math.log10(Math.max(x, 1e-12));
export const toLin = (d) => Math.pow(10, d / 20);
const msDb = (ms) => 10 * Math.log10(ms + 1e-14);

export const DEFAULT_PARAMS = {
  bypass: false,
  inputGainDb: 0,
  hpf: { enabled: true, freq: 80 },
  hum: { enabled: false, freq: 50, q: 12 },
  eq: [
    { enabled: true, type: 'lowshelf', freq: 150, gainDb: 0, q: 0.7 },
    { enabled: true, type: 'peaking', freq: 280, gainDb: 0, q: 1.0 },
    { enabled: true, type: 'peaking', freq: 3000, gainDb: 0, q: 1.0 },
    { enabled: true, type: 'peaking', freq: 5200, gainDb: 0, q: 2.0 },
    { enabled: true, type: 'highshelf', freq: 8000, gainDb: 0, q: 0.7 },
  ],
  gate: { enabled: false, thresholdDb: -55, rangeDb: 10, hysteresisDb: 4, attackMs: 4, holdMs: 120, releaseMs: 220 },
  deess: { enabled: false, freq: 6500, q: 1.5, thresholdDb: -9, maxReductionDb: 6 },
  comp: { enabled: false, thresholdDb: -24, ratio: 2, kneeDb: 8, attackMs: 12, releaseMs: 200 },
  makeupDb: 0,
  limiter: { enabled: true, ceilingDb: -1.5, releaseMs: 80 },
};

const clone = (o) => JSON.parse(JSON.stringify(o));
function merge(dst, src) {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (Array.isArray(v)) {
      if (!Array.isArray(dst[k])) dst[k] = [];
      v.forEach((it, i) => {
        if (it && typeof it === 'object') { if (!dst[k][i]) dst[k][i] = {}; merge(dst[k][i], it); } else dst[k][i] = it;
      });
    } else if (v && typeof v === 'object') {
      if (!dst[k] || typeof dst[k] !== 'object') dst[k] = {};
      merge(dst[k], v);
    } else dst[k] = v;
  }
  return dst;
}
export const mergeParams = (base, patch) => merge(clone(base), patch || {});

export function designBiquad(type, fs, f0, q, gainDb = 0) {
  const w0 = 2 * Math.PI * Math.min(Math.max(f0, 1), fs * 0.45) / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0), alpha = sw / (2 * q), A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'notch': b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'peaking': b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case 'lowshelf': { const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
      a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; break; }
    case 'highshelf': { const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; break; }
    default: throw new Error('biquad type ' + type);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
export function biquadMagDb(c, f, fs) {
  const w = 2 * Math.PI * f / fs, cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cw + c.b2 * c2, ni = -(c.b1 * sw + c.b2 * s2);
  const dr = 1 + c.a1 * cw + c.a2 * c2, di = -(c.a1 * sw + c.a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni + 1e-30) / (dr * dr + di * di + 1e-30));
}
export class Biquad {
  constructor() { this.c = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }; this.z1 = 0; this.z2 = 0; }
  run(x) { const c = this.c, y = c.b0 * x + this.z1; this.z1 = c.b1 * x - c.a1 * y + this.z2; this.z2 = c.b2 * x - c.a2 * y; return y; }
  reset() { this.z1 = this.z2 = 0; }
}
const HPF_Q = [0.5412, 1.3066]; // Баттерворт 4-го порядка

/** АЧХ линейной части цепочки (HPF+hum+EQ) для отображения в Lab. */
export function eqResponseDb(params, fs, freqs) {
  const p = mergeParams(DEFAULT_PARAMS, params);
  const cs = [];
  if (p.hpf.enabled) HPF_Q.forEach((q) => cs.push(designBiquad('highpass', fs, p.hpf.freq, q)));
  if (p.hum.enabled) for (let k = 1; k <= 3; k++) cs.push(designBiquad('notch', fs, p.hum.freq * k, p.hum.q));
  p.eq.forEach((b) => { if (b.enabled && Math.abs(b.gainDb) > 0.01) cs.push(designBiquad(b.type, fs, b.freq, b.q, b.gainDb)); });
  return freqs.map((f) => cs.reduce((s, c) => s + biquadMagDb(c, f, fs), 0));
}

function flatten(p) {
  const f = { inGain: p.inputGainDb, hpf: p.hpf.enabled ? p.hpf.freq : 10 };
  p.eq.forEach((b, i) => { f['eqF' + i] = b.freq; f['eqG' + i] = b.enabled ? b.gainDb : 0; f['eqQ' + i] = b.q; });
  f.gThr = p.gate.thresholdDb; f.gRange = p.gate.enabled ? p.gate.rangeDb : 0; f.gHyst = p.gate.hysteresisDb;
  f.dsF = p.deess.freq; f.dsThr = p.deess.thresholdDb; f.dsMax = p.deess.enabled ? p.deess.maxReductionDb : 0;
  f.cThr = p.comp.thresholdDb; f.cRatio = p.comp.enabled ? p.comp.ratio : 1; f.cKnee = p.comp.kneeDb;
  f.makeup = p.makeupDb; f.ceil = p.limiter.enabled ? p.limiter.ceilingDb : -0.1; f.wet = p.bypass ? 0 : 1;
  return f;
}
const onepole = (ms, fs) => 1 - Math.exp(-1 / Math.max(1, ms * fs / 1000));

export class VoiceDSP {
  constructor(fs = 48000, opts = {}) {
    this.fs = fs;
    this.L = Math.max(1, Math.round(fs * (opts.lookaheadMs ?? 1) / 1000));
    this.p = clone(DEFAULT_PARAMS);
    this.T = flatten(this.p); this.S = { ...this.T };
    this.hpfB = [new Biquad(), new Biquad()];
    this.humB = [new Biquad(), new Biquad(), new Biquad()];
    this.eqB = this.p.eq.map(() => new Biquad());
    this.bp = new Biquad(); this.dsCut = new Biquad();
    const R = this.L + 1;
    this.R = R; this.buf = new Float32Array(R); this.need = new Float32Array(R).fill(1); this.dry = new Float32Array(R); this.w = 0;
    this._humCoefs();
    this.reset();
  }
  get latencySamples() { return this.L; }
  reset() {
    [...this.hpfB, ...this.humB, ...this.eqB, this.bp, this.dsCut].forEach((b) => b.reset());
    Object.assign(this, { gMs: 0, gOpen: true, gHold: 0, gGain: 1, sibMs: 0, wideMs: 0, dsGR: 0, pk: 0, cGR: 0, limG: 1, zeroRun: 0, sinceLoud: 1e9 });
    this.buf.fill(0); this.need.fill(1); this.dry.fill(0);
    this._m = this._newMeters();
  }
  _newMeters() { return { n: 0, inSq: 0, inPeak: 0, outSq: 0, outPeak: 0, clipped: 0, hardClamp: 0, zeroRuns: 0, gateClosed: 0, cGRmin: 0, dsGRmax: 0, limMin: 1, nonFinite: 0 }; }
  setParams(patch, { immediate = false } = {}) {
    this.p = mergeParams(this.p, patch);
    this.T = flatten(this.p);
    if (immediate) this.S = { ...this.T };
    this._humCoefs();
  }
  _humCoefs() { for (let k = 0; k < 3; k++) this.humB[k].c = designBiquad('notch', this.fs, this.p.hum.freq * (k + 1), this.p.hum.q); }
  _updateCoefs() {
    const S = this.S, fs = this.fs;
    this.hpfB[0].c = designBiquad('highpass', fs, S.hpf, HPF_Q[0]);
    this.hpfB[1].c = designBiquad('highpass', fs, S.hpf, HPF_Q[1]);
    this.p.eq.forEach((b, i) => { this.eqB[i].c = designBiquad(b.type, fs, S['eqF' + i], S['eqQ' + i], S['eqG' + i]); });
    this.bp.c = designBiquad('bandpass', fs, S.dsF, 1.2);
    this.dsCut.c = designBiquad('peaking', fs, S.dsF, this.p.deess.q, -this.dsGR);
  }
  process(inp, out) {
    const n = inp.length, fs = this.fs, S = this.S, T = this.T, p = this.p, m = this._m;
    const a = 1 - Math.exp(-n / fs / 0.12);
    for (const k in T) S[k] += (T[k] - S[k]) * a;
    this._updateCoefs();
    const inG = toLin(S.inGain), mk = toLin(S.makeup), ceil = toLin(S.ceil), wet = S.wet;
    const g = p.gate, c = p.comp, humOn = p.hum.enabled;
    const cGA = onepole(g.attackMs, fs), cGR_ = onepole(g.releaseMs, fs), holdN = Math.round(g.holdMs * fs / 1000);
    const cEnv10 = onepole(10, fs), cEnv5 = onepole(5, fs);
    const cDsA = onepole(1, fs), cDsR = onepole(40, fs);
    const cCA = onepole(c.attackMs, fs), cCR = onepole(c.releaseMs, fs), pkRel = Math.exp(-1 / (0.005 * fs));
    const cLA = onepole(0.25, fs), cLR = onepole(p.limiter.releaseMs, fs);
    const gRangeLin = toLin(-S.gRange), R = this.R;
    const ratio = S.cRatio, knee = Math.max(S.cKnee, 0.1), slope = 1 / ratio - 1;
    for (let j = 0; j < n; j++) {
      const x0 = inp[j], ax0 = Math.abs(x0);
      m.n++; m.inSq += x0 * x0; if (ax0 > m.inPeak) m.inPeak = ax0; if (ax0 >= 0.999) m.clipped++;
      if (x0 === 0) { this.zeroRun++; if (this.zeroRun === 480 && this.sinceLoud < 2900) m.zeroRuns++; } else this.zeroRun = 0;
      if (ax0 > 0.02) this.sinceLoud = 0; else this.sinceLoud++;

      let x = x0 * inG;
      x = this.hpfB[1].run(this.hpfB[0].run(x));
      if (humOn) x = this.humB[2].run(this.humB[1].run(this.humB[0].run(x)));
      for (let i = 0; i < this.eqB.length; i++) x = this.eqB[i].run(x);

      // gate / expander
      this.gMs += (x * x - this.gMs) * cEnv10;
      if (S.gRange > 0.05) {
        const lvl = msDb(this.gMs);
        if (lvl > S.gThr) { this.gOpen = true; this.gHold = holdN; }
        else if (lvl < S.gThr - S.gHyst) { if (this.gHold > 0) this.gHold--; else this.gOpen = false; }
      } else this.gOpen = true;
      const gt = this.gOpen ? 1 : gRangeLin;
      this.gGain += (gt - this.gGain) * (gt > this.gGain ? cGA : cGR_);
      if (!this.gOpen) m.gateClosed++;

      // de-esser: детектор (узкополосный/широкополосный RMS) → динамический peaking-срез
      const bx = this.bp.run(x);
      this.sibMs += (bx * bx - this.sibMs) * cEnv5; this.wideMs += (x * x - this.wideMs) * cEnv5;
      const wideDb = msDb(this.wideMs), idx = msDb(this.sibMs) - wideDb;
      let tgt = 0;
      if (S.dsMax > 0.05 && wideDb > -55 && idx > S.dsThr) tgt = Math.min(S.dsMax, (idx - S.dsThr) * 1.5);
      this.dsGR += (tgt - this.dsGR) * (tgt > this.dsGR ? cDsA : cDsR);
      if (this.dsGR > m.dsGRmax) m.dsGRmax = this.dsGR;
      x = this.dsCut.run(x) * this.gGain;

      // компрессор (peak-детектор, мягкое колено, сглаживание в dB)
      this.pk = Math.max(Math.abs(x), this.pk * pkRel);
      let gc = 0;
      if (ratio > 1.001) {
        const over = toDb(this.pk) - S.cThr;
        if (2 * over < -knee) gc = 0;
        else if (2 * Math.abs(over) <= knee) gc = slope * (over + knee / 2) * (over + knee / 2) / (2 * knee);
        else gc = slope * over;
      }
      this.cGR += (gc - this.cGR) * (gc < this.cGR ? cCA : cCR);
      if (this.cGR < m.cGRmin) m.cGRmin = this.cGR;
      x *= Math.exp(this.cGR * 0.11512925465) * mk;

      // limiter с lookahead
      const w = this.w = (this.w + 1) % R;
      this.buf[w] = x; const ay = Math.abs(x); this.need[w] = ay > ceil ? ceil / ay : 1;
      this.dry[w] = x0;
      let mn = 1; for (let k = 0; k < R; k++) if (this.need[k] < mn) mn = this.need[k];
      this.limG += (mn - this.limG) * (mn < this.limG ? cLA : cLR);
      if (this.limG < m.limMin) m.limMin = this.limG;
      const rd = (w + 1) % R;
      let y = this.buf[rd] * this.limG;
      if (y > ceil) { y = ceil; m.hardClamp++; } else if (y < -ceil) { y = -ceil; m.hardClamp++; }
      if (!Number.isFinite(y)) { y = 0; m.nonFinite++; this._panic(); }
      const o = wet * y + (1 - wet) * this.dry[rd];
      out[j] = o; m.outSq += o * o; const ao = Math.abs(o); if (ao > m.outPeak) m.outPeak = ao;
    }
  }
  _panic() { const m = this._m; this.reset(); this._m = m; }
  readMeters() {
    const m = this._m, n = Math.max(1, m.n);
    const r = {
      inRmsDb: msDb(m.inSq / n), inPeakDb: toDb(m.inPeak), outRmsDb: msDb(m.outSq / n), outPeakDb: toDb(m.outPeak),
      clipped: m.clipped, hardClamp: m.hardClamp, zeroRuns: m.zeroRuns, nonFinite: m.nonFinite,
      gateClosedFrac: m.gateClosed / n, compGrDb: -m.cGRmin, deessGrDb: m.dsGRmax, limGrDb: -toDb(m.limMin), samples: m.n,
    };
    this._m = this._newMeters();
    return r;
  }
}
