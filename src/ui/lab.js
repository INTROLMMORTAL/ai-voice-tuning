import { DEFAULT_PARAMS, mergeParams, eqResponseDb, VoiceDSP } from '../dsp-processing/dsp-core.js';
import { analyzeRecording, lufsOfRanges } from '../audio-analysis/analyzer.js';
import { tune } from '../auto-tuning/tuner.js';
import { MODES, emptyProfile, pushHistory, revertProfile } from '../profile-manager/profiles.js';

const $ = (id) => document.getElementById(id);
const store = { get: (k) => chrome.storage.local.get(k), set: (o) => chrome.storage.local.set(o) };
const FS = 48000;
let ctx, src, voice, anIn, anOut, rec, stream, monGain, profile = emptyProfile(), params = mergeParams(DEFAULT_PARAMS, {}), undoStack = [], lastMeters = null;
let recorded = [], recording = false, calData = null, candidates = [], abIdx = -1, abSrc = null, abStart = 0, pending = {};

// ---------- профиль ----------
(async () => {
  const s = await store.get('avtProfile'); if (s.avtProfile) { profile = s.avtProfile; if (profile.params) params = mergeParams(DEFAULT_PARAMS, profile.params); }
  renderManual(); renderReasons(); drawEq(); benchmark();
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); $('dev').innerHTML = devs.map((d) => `<option value="${d.deviceId}">${d.label || d.deviceId.slice(0, 8)}</option>`).join('');
  if (profile.device) $('devNote').textContent = `Профиль откалиброван на устройстве «${profile.device.label}». При смене микрофона, расстояния до него или помещения пройдите калибровку заново.`;
})();

// ---------- запуск микрофона ----------
$('start').onclick = async () => {
  stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: $('dev').value ? { exact: $('dev').value } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  ctx = new AudioContext({ sampleRate: FS, latencyHint: 'interactive' }); await ctx.resume();
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('src/dsp-processing/voice-processor.js')); await ctx.audioWorklet.addModule(chrome.runtime.getURL('src/dsp-processing/recorder-processor.js'));
  src = ctx.createMediaStreamSource(stream);
  voice = new AudioWorkletNode(ctx, 'avt-voice', { outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
  rec = new AudioWorkletNode(ctx, 'avt-recorder', { numberOfOutputs: 1, outputChannelCount: [1] });
  anIn = ctx.createAnalyser(); anOut = ctx.createAnalyser(); anIn.fftSize = anOut.fftSize = 4096; anIn.smoothingTimeConstant = anOut.smoothingTimeConstant = 0.7;
  monGain = ctx.createGain(); monGain.gain.value = 0;
  src.connect(anIn); src.connect(voice); voice.connect(anOut); voice.connect(monGain); monGain.connect(ctx.destination);
  src.connect(rec); const z = ctx.createGain(); z.gain.value = 0; rec.connect(z); z.connect(ctx.destination);
  voice.port.onmessage = (e) => { if (e.data.type === 'meters') { lastMeters = e.data.m; } };
  voice.port.postMessage({ type: 'params', params, immediate: true });
  rec.port.onmessage = (e) => { if (recording) recorded.push(e.data); };
  const t = stream.getAudioTracks()[0]; const s = t.getSettings();
  $('devNote').textContent = `Устройство: «${t.label}», ${s.sampleRate || '?'} Гц. Браузерные NS/AGC/AEC выключены для измерения. Базовая задержка контекста ${(ctx.baseLatency * 1000).toFixed(1)} мс, выходная ${((ctx.outputLatency || 0) * 1000).toFixed(1)} мс.`;
  $('lat').textContent = `lookahead limiter 1.0 мс + блок AudioWorklet 2.7 мс (≈3.7 мс алгоритмически; полную сквозную задержку измеряйте loopback-тестом, см. README, раздел ограничений)`;
  $('cal').disabled = !$('consent').checked; draw();
};
$('consent').onchange = () => { $('cal').disabled = !$('consent').checked || !ctx; };
$('mon').onchange = () => { if (monGain) monGain.gain.value = $('mon').checked ? 1 : 0; };

// ---------- рисование ----------
const dbToY = (d, h) => h * (1 - (d + 100) / 100);
function drawSpec(c, g, a, col) {
  const buf = new Float32Array(a.frequencyBinCount); a.getFloatFrequencyData(buf); g.strokeStyle = col; g.beginPath();
  const w = c.width, h = c.height; for (let k = 1; k < buf.length; k++) { const f = k * FS / a.fftSize, x = w * Math.log(f / 20) / Math.log(20000 / 20); if (x < 0) continue; const y = dbToY(buf[k], h); k === 1 ? g.moveTo(x, y) : g.lineTo(x, y); } g.stroke();
}
function draw() {
  if (!ctx) return; requestAnimationFrame(draw);
  const c = $('spec'), g = c.getContext('2d'); c.width = c.clientWidth; c.height = c.clientHeight; g.clearRect(0, 0, c.width, c.height);
  g.strokeStyle = '#2a2f3a'; for (const f of [100, 1000, 10000]) { const x = c.width * Math.log(f / 20) / Math.log(1000); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, c.height); g.stroke(); g.fillStyle = '#667'; g.fillText(f + ' Гц', x + 2, 10); }
  drawSpec(c, g, anIn, '#888'); drawSpec(c, g, anOut, '#4cc38a');
  const w = $('wave'), wg = w.getContext('2d'); w.width = w.clientWidth; w.height = w.clientHeight; const t = new Float32Array(anOut.fftSize); anOut.getFloatTimeDomainData(t);
  wg.clearRect(0, 0, w.width, w.height); wg.strokeStyle = '#4cc38a'; wg.beginPath(); for (let i = 0; i < t.length; i += 4) { const x = w.width * i / t.length, y = w.height / 2 - t[i] * w.height / 2; i ? wg.lineTo(x, y) : wg.moveTo(x, y); } wg.stroke();
  const m = lastMeters; if (m) {
    const lv = (id, tid, d) => { $(id).style.width = Math.max(0, Math.min(100, (d + 60) / 60 * 100)) + '%'; $(tid).textContent = d.toFixed(0) + ' дБ'; };
    lv('mIn', 'tIn', m.inPeakDb); lv('mOut', 'tOut', m.outPeakDb);
    $('mGr').style.width = Math.min(100, m.compGrDb * 6) + '%'; $('tGr').textContent = m.compGrDb.toFixed(1); $('mDs').style.width = Math.min(100, m.deessGrDb * 10) + '%'; $('tDs').textContent = m.deessGrDb.toFixed(1);
    $('flags').innerHTML = [m.clipped ? '<span class="bad">КЛИППИНГ ВХОДА</span>' : '', m.hardClamp ? '<span class="warn">limiter hard-clamp</span>' : '', m.zeroRuns ? '<span class="bad">обрыв сигнала (цифровая тишина)</span>' : '', params.gate.enabled ? `gate: ${m.gateClosedFrac > 0.5 ? 'закрыт' : 'открыт'}` : 'gate: выкл', params.deess.enabled ? 'de-esser: вкл' : '', params.comp.enabled ? 'comp: вкл' : ''].filter(Boolean).join(' · ');
  }
}
function drawEq() {
  const c = $('eqc'), g = c.getContext('2d'); c.width = c.clientWidth; c.height = c.clientHeight; g.clearRect(0, 0, c.width, c.height);
  const fr = Array.from({ length: 200 }, (_, i) => 20 * Math.pow(1000, i / 199)), r = eqResponseDb(params, FS, fr);
  g.strokeStyle = '#2a2f3a'; g.beginPath(); g.moveTo(0, c.height / 2); g.lineTo(c.width, c.height / 2); g.stroke(); g.strokeStyle = '#9fb4ff'; g.beginPath();
  r.forEach((d, i) => { const x = c.width * i / 199, y = c.height / 2 - Math.max(-12, Math.min(12, d)) / 12 * c.height / 2; i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); g.fillStyle = '#667'; g.fillText('±12 дБ, 20 Гц–20 кГц', 4, 10);
}
function benchmark() { const d = new VoiceDSP(FS); d.setParams({ comp: { enabled: true }, gate: { enabled: true }, deess: { enabled: true } }); const x = new Float32Array(FS * 5).map(() => (Math.random() - 0.5) * 0.2), o = new Float32Array(x.length); const t0 = performance.now(); for (let i = 0; i < x.length; i += 128) d.process(x.subarray(i, i + 128), o.subarray(i, i + 128)); $('bench').textContent = `${(5000 / (performance.now() - t0)).toFixed(0)}× реального времени (полная цепочка, основной поток этой страницы)`; }

// ---------- калибровка ----------
const STAGES = [{ name: 'noise', sec: 4, text: 'Молчите. Не двигайтесь, не дышите в микрофон.' }, { name: 'quiet', sec: 6, text: 'Говорите ТИХО, как поздним вечером. Любые обычные фразы.' }, { name: 'normal', sec: 8, text: 'Говорите КАК ОБЫЧНО в разговоре.' }, { name: 'loud', sec: 6, text: 'Говорите ГРОМЧЕ, как будто собеседник плохо слышит.' }];
$('cal').onclick = async () => {
  if (!$('consent').checked) return; recorded = []; recording = true; $('cal').disabled = true; $('discard').disabled = false; const segs = []; let pos = 0;
  const total = STAGES.reduce((s, x) => s + x.sec, 0), t0 = performance.now(); rec.port.postMessage({ record: true });
  for (const st of STAGES) { $('prompt').textContent = st.text; const start = recordedLen(); const tt = performance.now(); while (performance.now() - tt < st.sec * 1000) { $('prog').style.width = ((performance.now() - t0) / 10 / total) + '%'; await new Promise((r) => setTimeout(r, 100)); } segs.push({ name: st.name, start: start + Math.round(0.4 * FS), end: recordedLen() }); }
  rec.port.postMessage({ record: false }); recording = false; await new Promise((r) => setTimeout(r, 200)); $('prompt').textContent = 'Анализ…'; $('prog').style.width = '100%';
  const all = new Float32Array(recordedLen()); let k = 0; for (const b of recorded) { all.set(b, k); k += b.length; }
  const metrics = analyzeRecording({ samples: all, fs: FS, segments: segs.map((s) => ({ ...s, end: Math.min(s.end, all.length) })) });
  calData = { samples: all, segs, metrics }; renderMetrics(metrics); buildCandidates(); $('prompt').textContent = 'Готово. Прослушайте варианты ниже.'; $('cal').disabled = false;
};
const recordedLen = () => recorded.reduce((s, b) => s + b.length, 0);
$('discard').onclick = () => { recorded = []; calData = null; candidates = []; $('ab').textContent = 'Запись удалена из памяти.'; $('discard').disabled = true; };
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
function renderMetrics(m) {
  if (!m.ok) { $('metrics').innerHTML = '<span class="bad">Речь не обнаружена — повторите калибровку.</span>'; return; }
  const W = { NOT_ENOUGH_SPEECH: 'мало речи', NO_NOISE_SEGMENT: 'нет сегмента тишины', UPSTREAM_GATE: 'шум уже обнулён браузером/драйвером (скрытый гейт)', CLIPPING: 'клиппинг на входе — снизьте усиление микрофона в Windows', DROPOUTS: 'обрывы сигнала на уровне устройства — это не лечится EQ', HUM: 'сетевой гул' };
  $('metrics').innerHTML = `<table>
  <tr><td>Громкость речи (RMS / K-weighted)</td><td>${f1(m.levels.speechRmsDb)} дБFS / ${f1(m.levels.speechLufs)} LUFS</td><td>Пик / crest</td><td>${f1(m.levels.peakDb)} дБFS / ${f1(m.levels.crestDb)} дБ</td></tr>
  <tr><td>Шумовой пол / SNR</td><td>${f1(m.levels.noiseFloorDb)} дБFS / ${f1(m.levels.snrDb)} дБ</td><td>Динамика речи (P95−P10) / тихо↔громко</td><td>${f1(m.dynamics.drDb)} / ${f1(m.dynamics.segSpreadDb)} дБ</td></tr>
  <tr><td>Гул</td><td>${m.noise.hum ? (m.noise.hum.detected ? `${m.noise.hum.freq} Гц, +${f1(m.noise.hum.prominenceDb)} дБ` : 'не обнаружен') : '—'}</td><td>Низкочастотный шум / шипение (отн.)</td><td>${f1(m.noise.rumbleDb)} / ${f1(m.noise.hissDb)} дБ</td></tr>
  <tr><td>Наклон спектра</td><td>${f1(m.spectrum.tiltDbPerOct)} дБ/окт</td><td>Эффективная полоса</td><td>до ~${Math.round(m.spectrum.bandwidthHz)} Гц</td></tr>
  <tr><td>Сибилянты (P50/P90 индекса)</td><td>${f1(m.sibilance.idxP50Db)} / ${f1(m.sibilance.idxP90Db)} дБ</td><td>Прокси разборчивости (SNR 2–4.5 кГц)</td><td>${f1(m.clarityProxy.presenceSnrDb)} дБ <span class="muted">(не STOI)</span></td></tr>
  <tr><td>Клиппинг / обрывы</td><td>${m.clipping.clippedSamples} сэмпл. / ${m.dropouts.suddenSilenceRuns}</td><td>Уверенность анализа</td><td>${(m.confidence * 100).toFixed(0)}%</td></tr></table>
  ${m.warnings.map((w) => `<div class="warn">⚠ ${W[w] || w}</div>`).join('')}<div class="muted">«Приятность» и «идеальный тембр» не измеряются — окончательное решение за вашим слухом (раздел 4).</div>`;
}

// ---------- A/B ----------
function render(samples, p) { const d = new VoiceDSP(FS); d.setParams(p, { immediate: true }); const o = new Float32Array(samples.length); for (let i = 0; i < samples.length; i += 128) d.process(samples.subarray(i, Math.min(samples.length, i + 128)), o.subarray(i, Math.min(samples.length, i + 128))); return o; }
function buildCandidates() {
  const { samples, segs, metrics } = calData; const sp = segs.filter((s) => s.name !== 'noise').map((s) => [s.start, Math.min(s.end, samples.length)]);
  const ref = lufsOfRanges(samples, sp);
  const defs = [{ id: 'orig', label: 'Оригинал', samples }, ...['natural', 'clear', 'warm', 'crisp'].map((id) => { const t = tune(metrics, { mode: id }); return { id, label: MODES[id].label, samples: render(samples, t.params), tuned: t }; })];
  candidates = defs.map((c) => { const l = lufsOfRanges(c.samples, sp); let g = Math.pow(10, (ref - l) / 20); const pk = Math.max(...c.samples.map(Math.abs)) * g; if (pk > 0.98) g *= 0.98 / pk; return { ...c, gain: g, lufs: l }; });
  const perm = candidates.map((_, i) => i); if ($('blind').checked) perm.sort(() => Math.random() - 0.5);
  $('ab').innerHTML = perm.map((i, n) => `<button data-i="${i}">${$('blind').checked ? String.fromCharCode(88 + n) : candidates[i].label}</button>`).join(' ');
  $('ab').querySelectorAll('button').forEach((b) => (b.onclick = () => playAb(+b.dataset.i)));
  $('pickRow').innerHTML = 'Лучший вариант: ' + candidates.slice(1).map((c) => `<button data-p="${c.id}">${c.label}</button>`).join(' ');
  $('pickRow').querySelectorAll('button').forEach((b) => (b.onclick = () => applyMode(b.dataset.p, true)));
}
function playAb(i) {
  const c = candidates[i], nm = calData.segs.find((s) => s.name === 'normal'); const off = abSrc ? (ctx.currentTime - abStart) : 0; if (abSrc) abSrc.stop();
  const buf = ctx.createBuffer(1, c.samples.length, FS); const ch = buf.getChannelData(0); const g = $('match').checked ? c.gain : 1; for (let k = 0; k < ch.length; k++) ch[k] = c.samples[k] * g;
  abSrc = ctx.createBufferSource(); abSrc.buffer = buf; abSrc.loop = true; abSrc.loopStart = nm.start / FS; abSrc.loopEnd = nm.end / FS; abSrc.connect(ctx.destination);
  const o = nm.start / FS + (off % ((nm.end - nm.start) / FS)); abSrc.start(0, o); abStart = ctx.currentTime - (o - nm.start / FS);
}
$('blind').onchange = () => calData && buildCandidates();

// ---------- применение / ручная настройка ----------
function push(patch, label) { undoStack.push({ params: structuredClone(params), label }); params = mergeParams(params, patch); voice && voice.port.postMessage({ type: 'params', params }); drawEq(); $('changes').innerHTML = undoStack.slice(-6).map((u) => `· ${u.label}`).join('<br>'); }
function applyMode(id, fromPick) {
  const t = tune(calData ? calData.metrics : profile.metrics, { mode: id }); undoStack.push({ params: structuredClone(params), label: `режим → ${MODES[id].label}` });
  params = t.params; profile = { ...profile, mode: id, reasons: t.reasons, warnings: t.warnings }; if (calData) profile.metrics = calData.metrics;
  voice && voice.port.postMessage({ type: 'params', params }); renderManual(); renderReasons(); drawEq();
}
function renderReasons() { $('reasons').innerHTML = (profile.reasons || []).map((r) => `<li><b>${r.param}</b> = ${r.value}: <span class="muted">${r.why}</span></li>`).join('') + (profile.warnings || []).map((w) => `<li class="warn">⚠ ${w}</li>`).join(''); }
const SL = [['Усиление (makeup), дБ', 'makeupDb', -12, 24, 0.5], ['HPF, Гц', 'hpf.freq', 40, 200, 1], ['EQ мути 280 Гц', 'eq.1.gainDb', -6, 6, 0.1], ['EQ присутствие 3 кГц', 'eq.2.gainDb', -6, 6, 0.1], ['EQ резкость 5.2 кГц', 'eq.3.gainDb', -6, 6, 0.1], ['EQ воздух 8 кГц', 'eq.4.gainDb', -6, 6, 0.1], ['Компрессор: порог, дБ', 'comp.thresholdDb', -50, 0, 0.5], ['Компрессор: ratio', 'comp.ratio', 1, 6, 0.1], ['Gate: порог, дБ', 'gate.thresholdDb', -80, -20, 0.5], ['De-esser: порог, дБ', 'deess.thresholdDb', -25, 0, 0.5]];
const getP = (o, path) => path.split('.').reduce((a, k) => a[k], o);
function patchFor(path, v) { const ks = path.split('.'); if (ks[0] === 'eq') return { eq: Object.assign([], { [ks[1]]: { [ks[2]]: v } }) }; return ks.length === 1 ? { [ks[0]]: v } : { [ks[0]]: { [ks[1]]: v } }; }
function renderManual() {
  $('manual').innerHTML = SL.map(([n, p, lo, hi, st]) => `<label class="sl">${n}<input type="range" min="${lo}" max="${hi}" step="${st}" value="${getP(params, p)}" data-p="${p}"><span>${getP(params, p)}</span></label>`).join('') + ['comp', 'gate', 'deess'].map((k) => `<label><input type="checkbox" data-en="${k}" ${params[k].enabled ? 'checked' : ''}> ${k}</label>`).join(' ');
  $('manual').querySelectorAll('input[type=range]').forEach((el) => (el.oninput = () => { const v = +el.value; el.nextElementSibling.textContent = v; const old = getP(params, el.dataset.p); push(patchFor(el.dataset.p, v), `${el.dataset.p}: ${old} → ${v} (ручная правка: параметр больше не следует авто-расчёту)`); profile.manualOverrides = { ...profile.manualOverrides, [el.dataset.p]: v }; }));
  $('manual').querySelectorAll('[data-en]').forEach((el) => (el.onchange = () => push({ [el.dataset.en]: { enabled: el.checked } }, `${el.dataset.en}: ${el.checked ? 'вкл' : 'выкл'}`)));
}
$('undo').onclick = () => { const u = undoStack.pop(); if (!u) return; params = u.params; voice && voice.port.postMessage({ type: 'params', params }); renderManual(); drawEq(); };
$('reset').onclick = () => { undoStack.push({ params: structuredClone(params), label: 'reset' }); params = mergeParams(DEFAULT_PARAMS, {}); profile = { ...profile, reasons: [], manualOverrides: {} }; voice && voice.port.postMessage({ type: 'params', params, immediate: true }); renderManual(); renderReasons(); drawEq(); };
$('revert').onclick = async () => { const p = revertProfile(profile); if (p === profile) { alert('Нет предыдущих версий.'); return; } profile = p; params = mergeParams(DEFAULT_PARAMS, p.params); await store.set({ avtProfile: profile }); voice && voice.port.postMessage({ type: 'params', params }); renderManual(); renderReasons(); drawEq(); };
$('save').onclick = async () => {
  const label = stream ? stream.getAudioTracks()[0].label : (profile.device && profile.device.label) || 'не указано';
  const next = pushHistory(profile, { ...profile, version: 1, params, createdAt: Date.now(), device: { label, calibratedAt: Date.now() } });
  profile = next; await store.set({ avtProfile: profile }); $('changes').textContent = 'Профиль сохранён локально (chrome.storage.local). Вкладка nekto.me подхватит его без перезагрузки.';
};
