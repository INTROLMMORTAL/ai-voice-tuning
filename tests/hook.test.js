// Логика hook.js на заглушках браузерных API (это НЕ проверка на реальном nekto.me).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const realSI = globalThis.setInterval; globalThis.setInterval = (f, t) => { const h = realSI(f, t); h.unref?.(); return h; };
let n = 0;
function env({ ctxState = 'running', workletFails = false } = {}) {
  const handlers = [], w = globalThis; w.window = w; w.__avtHooked = false; w.posts = [];
  w.addEventListener = (t, f) => { if (t === 'message') handlers.push(f); };
  w.postMessage = (m) => { w.posts.push(m); setImmediate(() => handlers.forEach((h) => h({ source: w, data: m }))); };
  w.document = { documentElement: { dataset: {} } };
  w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
  const mkTrack = (kind, label) => ({ kind, label, stopped: false, stop() { this.stopped = true; }, addEventListener() {}, getSettings: () => ({ deviceId: 'dev1', echoCancellation: true }), dispatchEvent() {} });
  w.MediaStream = class { constructor(tr = []) { this.t = tr; } getAudioTracks() { return this.t.filter((x) => x.kind === 'audio'); } getVideoTracks() { return this.t.filter((x) => x.kind === 'video'); } };
  const micTrack = mkTrack('audio', 'Test Mic'), outTrack = Object.assign(mkTrack('audio', 'dest'), { getSettings: () => ({}) });
  w.MediaDevices = class { async getUserMedia(c) { w.lastConstraints = c; return new w.MediaStream([micTrack]); } };
  const node = () => ({ connect() {}, disconnect() {}, port: { postMessage() {} } });
  w.AudioContext = class { constructor() { this.state = ctxState; this.audioWorklet = { addModule: async () => { if (workletFails) throw new Error('CSP'); } };
      this.createMediaStreamSource = () => node(); this.createMediaStreamDestination = () => ({ channelCount: 2, stream: new w.MediaStream([outTrack]) });
      this.createBiquadFilter = () => ({ connect() {}, frequency: {}, Q: {}, gain: {} }); this.createGain = () => ({ connect() {}, gain: {} });
      this.createDynamicsCompressor = () => ({ connect() {}, threshold: {}, knee: {}, ratio: {}, attack: {}, release: {} }); }
    async resume() {} close() { return Promise.resolve(); } };
  w.AudioWorkletNode = class { constructor() { return node(); } };
  w.RTCPeerConnection = class {}; w.__origRTC = w.RTCPeerConnection;
  return { micTrack, outTrack, w, config: () => handlers.forEach((h) => h({ source: w, data: { avt: 1, from: 'bridge', type: 'config', data: { profile: null, settings: {}, workletSource: 'x' } } })) };
}
const load = async () => { await import('../src/nekto-integration/hook.js?n=' + (++n)); };

test('сайт получает ОБРАБОТАННЫЙ трек; метка и deviceId сохранены', async () => {
  const e = env(); await load(); e.config();
  const t = (await new MediaDevices().getUserMedia({ audio: true })).getAudioTracks()[0]; assert.equal(t, e.outTrack);
  assert.equal(t.label, 'Test Mic'); assert.equal(t.getSettings().deviceId, 'dev1');
});
test('stop() обработанного трека останавливает исходный микрофон', async () => {
  const e = env(); await load(); e.config(); (await new MediaDevices().getUserMedia({ audio: true })).getAudioTracks()[0].stop(); assert.equal(e.micTrack.stopped, true);
});
test('fail-open: AudioContext suspended → оригинальный трек', async () => {
  const e = env({ ctxState: 'suspended' }); await load(); e.config();
  assert.equal((await new MediaDevices().getUserMedia({ audio: true })).getAudioTracks()[0], e.micTrack);
});
test('CSP блокирует worklet → нативная запасная цепочка, трек обработан', async () => {
  const e = env({ workletFails: true }); await load(); e.config();
  assert.equal((await new MediaDevices().getUserMedia({ audio: true })).getAudioTracks()[0], e.outTrack);
});
test('МИНИМАЛЬНЫЙ СЛЕД: RTCPeerConnection не тронут, DOM без атрибутов, страница не получает сообщений от хука, треки без маркеров', async () => {
  const e = env(); await load(); e.config();
  const t = (await new MediaDevices().getUserMedia({ audio: true })).getAudioTracks()[0];
  assert.equal(window.RTCPeerConnection, e.w.__origRTC);
  assert.deepEqual(Object.keys(document.documentElement.dataset), []);
  assert.equal(e.w.posts.filter((m) => m.from === 'page').length, 0);
  assert.equal(t.__avt, undefined);
});
test('video-only запрос не затрагивается', async () => {
  const e = env(); await load(); await new MediaDevices().getUserMedia({ video: true }); assert.equal(e.w.lastConstraints.video, true);
});
test('склеенный код worklet (как делает bridge) синтаксически корректен и регистрирует процессор', () => {
  const core = fs.readFileSync('src/dsp-processing/dsp-core.js', 'utf8').replace(/^export\s+/gm, '');
  const proc = fs.readFileSync('src/dsp-processing/voice-processor.js', 'utf8').replace(/^import .*$/m, '');
  let registered = null; const ctx = { AudioWorkletProcessor: class { constructor() { this.port = {}; } }, registerProcessor: (n) => { registered = n; }, sampleRate: 48000, currentTime: 0, Math, Float32Array, Number, JSON, Object };
  vm.runInNewContext(core + '\n' + proc, ctx); assert.equal(registered, 'avt-voice');
});
