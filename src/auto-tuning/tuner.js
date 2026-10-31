// Метрики → параметры цепочки. Каждый параметр сопровождается причиной. Все коррекции ограничены и ослаблены (deadband).
import { DEFAULT_PARAMS, mergeParams } from '../dsp-processing/dsp-core.js';
import { MODES } from '../profile-manager/profiles.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (v) => Math.round(v * 10) / 10;
// Приблизительная «типовая» форма долговременного спектра речи относительно полосы ~1 кГц, дБ. Это ЭВРИСТИКА, а не истина:
// микрофоны/голоса/расстояние сильно отличаются, поэтому применяется широкий deadband и половинная коррекция.
const REF = { b125: 8, b250: 9, b500: 5, b1k: 0, b2k: -6, b4k: -9, b8k: -15 };
const DEAD = 3;
const correction = (dev) => (Math.abs(dev) <= DEAD ? 0 : 0.5 * (dev - Math.sign(dev) * DEAD));

export function staticGr(levelDb, thr, ratio, knee) {
  const over = levelDb - thr; const slope = 1 / ratio - 1;
  if (ratio <= 1.001 || 2 * over < -knee) return 0;
  if (2 * Math.abs(over) <= knee) return slope * (over + knee / 2) ** 2 / (2 * knee);
  return slope * over;
}

export function tune(metrics, { mode = 'clear', amount = 1, prefs = {} } = {}) {
  const M = MODES[mode] || MODES.clear;
  const p = mergeParams(DEFAULT_PARAMS, {});
  const reasons = [], warnings = [];
  const why = (param, value, text) => reasons.push({ param, value, why: text });

  if (!metrics || !metrics.ok || metrics.confidence < 0.3) {
    p.hpf.freq = 80; why('hpf.freq', 80, 'Консервативный профиль: измерений недостаточно. Пройдите калибровку (≥10 с речи + 3 с тишины) и прослушайте результат.');
    warnings.push('LOW_CONFIDENCE');
    return { params: p, reasons, warnings, confidence: metrics?.confidence ?? 0, conservative: true };
  }
  const L = metrics.levels, S = metrics.spectrum, D = metrics.dynamics, N = metrics.noise;
  const eqAmt = M.eqAmount * amount;

  // 1. HPF: ниже нижней границы голоса; выше при низкочастотном шуме. f0 используется ТОЛЬКО для этого расчёта.
  const f0lo = metrics.pitch?.p10Hz;
  let hpf = 70 + (M.hpfExtra || 0) * 0;
  const rumble = Number.isFinite(N.rumbleDb) ? N.rumbleDb : 0;
  hpf += clamp((rumble - 10) * 1.5, 0, 30) + (M.hpfExtra || 0);
  const cap = f0lo ? clamp(f0lo * 0.85, 60, 120) : 100;
  hpf = clamp(Math.min(hpf, cap + (M.hpfExtra || 0)), 60, 130);
  p.hpf.freq = Math.round(hpf);
  why('hpf.freq', p.hpf.freq, `HPF 24 дБ/окт: ниже основного тона (нижняя граница f0 ≈ ${f0lo ? Math.round(f0lo) + ' Гц' : 'не определена'}), низкочастотный шум комнаты ${r1(rumble)} дБ относительно 500 Гц.`);

  // 2. Сетевой гул
  if (N.hum?.detected) { p.hum = { enabled: true, freq: N.hum.freq, q: 12 }; why('hum', `${N.hum.freq} Гц ×3`, `Обнаружен гул ${N.hum.freq} Гц (выступ ${r1(N.hum.prominenceDb)} дБ над окружением). Узкие notch на 1–3 гармонику. Лучше устранить источник: кабель, заземление, USB-порт.`); }

  // 3. EQ — только измеренные отклонения от эвристической цели; бусты запрещены там, где SNR полосы мал
  const rel = S.relTo1kDb, dev = (k) => rel[k] - REF[k], b = M.bias;
  const snr = (k) => S.speechBandsDb[k] - S.noiseBandsDb[k];
  const canBoost = (k, need = 15) => !Number.isFinite(snr(k)) || snr(k) >= need;
  const eq = p.eq;
  let g;
  const mud = correction(dev('b250')); eq[1].gainDb = r1(clamp(-mud * eqAmt, -4, 0)); if (eq[1].gainDb) why('eq[1] 280 Гц', eq[1].gainDb, `Избыток «мути» 200–350 Гц: ${r1(dev('b250'))} дБ выше типовой формы.`);
  const body = correction(dev('b125')) ; g = -body * eqAmt + (b.body || 0) * amount;
  if (g > 0 && !canBoost('b125', 12)) g = 0;
  eq[0].gainDb = r1(clamp(g, -3, 3)); if (eq[0].gainDb) why('eq[0] low-shelf 150 Гц', eq[0].gainDb, body > 0 ? 'Басовый избыток (эффект близости/бубнёж).' : body < 0 ? 'Недостаток низов (тонкий звук) — аккуратный буст.' : 'Режим просит немного тепла.');
  const pr = correction((dev('b2k') + dev('b4k')) / 2); g = -pr * eqAmt + (b.presence || 0) * amount;
  if (g > 0 && !canBoost('pres')) { g = 0; warnings.push('NO_PRESENCE_BOOST_LOW_SNR'); }
  eq[2].gainDb = r1(clamp(g, -3, 3.5)); if (eq[2].gainDb) why('eq[2] 3 кГц', eq[2].gainDb, 'Присутствие 2–4 кГц: коррекция к типовой форме спектра (+ предпочтение режима).');
  const hr = correction(dev('b4k') - 1); g = -Math.max(0, hr) * eqAmt + (b.harsh || 0) * amount;
  eq[3].gainDb = r1(clamp(g, -3, 0)); if (eq[3].gainDb) why('eq[3] 5.2 кГц', eq[3].gainDb, 'Контроль резкости 4–6.5 кГц.');
  const air = correction(dev('b8k')); g = -air * eqAmt + (b.air || 0) * amount;
  if (g > 0 && (!canBoost('b8k', 20) || S.bandwidthHz < 11000)) { if (g > 0) why('eq[4] 8 кГц', 0, 'Буст верхов отключён: полоса микрофона/канала ограничена или SNR на верхних частотах низкий — он поднял бы только шум.'); g = 0; }
  eq[4].gainDb = r1(clamp(g, -3, 2.5)); if (eq[4].gainDb) why('eq[4] high-shelf 8 кГц', eq[4].gainDb, 'Баланс верхних частот.');
  if (M.eqAmount === 0) eq.forEach((e) => { e.gainDb = 0; });

  // 4. Gate / expander
  const snrDb = L.snrDb, floor = L.noiseFloorDb;
  const gateWanted = M.gate === 'strong' || (M.gate === 'auto' && floor > -58 && snrDb >= 15);
  if (N.upstreamGate) why('gate', 'выкл', 'Тишина уже зануляется до расширения (шумодав браузера/драйвера). Второй гейт дал бы «рубку» слов.');
  else if (gateWanted) {
    const thr = Math.min(floor + 7, (D.peakP40Db - L.crestDb) - 10);
    p.gate = { enabled: true, thresholdDb: r1(thr), rangeDb: M.gate === 'strong' ? 14 : 8, hysteresisDb: 5, attackMs: 4, holdMs: 150, releaseMs: 250 };
    why('gate', `${r1(thr)} дБ / −${p.gate.rangeDb} дБ`, `Шум ${r1(floor)} дБFS, SNR ${r1(snrDb)} дБ: мягкий expander (не полный гейт) на 7 дБ выше шума, ≥10 дБ ниже тихой речи.`);
  } else why('gate', 'выкл', `Шум ${r1(floor)} дБFS достаточно низкий — гейт не нужен (меньше риска обрезать начала слов).`);

  // 5. Компрессор
  const strength = M.comp * amount;
  let avgGr = 0;
  if (strength > 0.05 && (D.drDb > 10 || M.comp >= 1)) {
    const ratio = clamp((1.3 + (D.drDb - 10) * 0.12) * strength + (1 - Math.min(strength, 1)) * 0.0, 1.2, mode === 'broadcast' ? 4 : 3);
    const thr = D.peakP50Db - (mode === 'broadcast' ? 8 : 4);
    p.comp = { enabled: true, thresholdDb: r1(thr), ratio: r1(ratio), kneeDb: 9, attackMs: mode === 'broadcast' ? 8 : 15, releaseMs: mode === 'broadcast' ? 160 : 230 };
    // ожидаемое среднее GR по измеренному распределению пиков (мощностное усреднение), ограничение «не передавить»
    const grCap = mode === 'broadcast' ? 8 : 5; avgGr = clamp(-staticGr(D.peakP50Db, p.comp.thresholdDb, p.comp.ratio, 9) * 0.7, 0, grCap);
    why('comp', `thr ${p.comp.thresholdDb} дБ, ${p.comp.ratio}:1`, `Динамический диапазон речи ${r1(D.drDb)} дБ, разброс тихо/громко ${r1(D.segSpreadDb)} дБ. Атака ${p.comp.attackMs} мс пропускает согласные, релиз ${p.comp.releaseMs} мс без «дыхания».`);
  } else why('comp', 'выкл', `Динамика ${r1(D.drDb)} дБ — в пределах естественной, либо режим не требует сжатия.`);

  // 6. De-esser — порог из собственного распределения сибилянтности пользователя
  const SB = metrics.sibilance, sibStrong = SB.idxP90Db > -8;
  if (M.deess === 'always' || (M.deess === 'auto' && SB.idxP90Db > -11) || (M.deess === 'auto-strong-only' && sibStrong)) {
    const thr = Math.max(SB.idxP75Db, SB.idxP90Db - 3);
    p.deess = { enabled: true, freq: 6500, q: 1.5, thresholdDb: r1(thr), maxReductionDb: r1(clamp((SB.idxP95Db - thr) * 1.5 + 1, 2, mode === 'crisp' ? 8 : 6)) };
    why('deess', `thr ${p.deess.thresholdDb} дБ, до −${p.deess.maxReductionDb} дБ`, `Индекс сибилянтности (энергия 6.5 кГц / полная): P90 = ${r1(SB.idxP90Db)} дБ. Порог выше типичных кадров — режутся только выбросы.`);
  } else why('deess', 'выкл', `Сибилянты в норме (P90 индекса ${r1(SB.idxP90Db)} дБ).`);

  // 7. Громкость → makeup, предел-проверки
  const needed = M.target - L.speechLufs;
  let makeup = clamp(needed + avgGr, -12, 18);
  const expectedPeak = L.peakDb + makeup - avgGr;
  const limCeil = mode === 'broadcast' ? -1.0 : -1.5;
  if (expectedPeak > limCeil + 6) { makeup -= expectedPeak - (limCeil + 6); warnings.push('LIMITER_WOULD_WORK_HARD'); }
  p.makeupDb = r1(makeup);
  why('makeupDb', p.makeupDb, `Цель ${M.target} LUFS-подобной речи; измерено ${r1(L.speechLufs)}. Учтено ожидаемое сжатие ${r1(avgGr)} дБ.`);
  if (makeup > 12) warnings.push('HIGH_GAIN_RAISES_NOISE');
  p.limiter = { enabled: true, ceilingDb: limCeil, releaseMs: 80 };
  why('limiter', `${limCeil} дБFS`, 'Страховка от перегрузки кодека и клиппинга; lookahead 1 мс.');
  if (L.noiseFloorDb + makeup > -50 && !p.gate.enabled) warnings.push('NOISE_AFTER_GAIN_AUDIBLE');

  // 8. Low Latency: минимальная цепочка
  if (mode === 'lowlatency') { p.comp.enabled = p.gate.enabled = p.deess.enabled = false; }

  if (metrics.clipping.clippedSamples > 0) warnings.push('INPUT_CLIPPING_REDUCE_MIC_GAIN');
  if (metrics.warnings.includes('DROPOUTS')) warnings.push('DROPOUTS_NOT_FIXABLE_BY_DSP');
  return { params: p, reasons, warnings, confidence: metrics.confidence, conservative: false };
}
