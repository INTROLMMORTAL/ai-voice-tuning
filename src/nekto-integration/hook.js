// MAIN world, document_start. «Минимальный след»: подменяется ТОЛЬКО MediaDevices.prototype.getUserMedia (и только для audio).
// Не трогает RTCPeerConnection, не пишет атрибуты в DOM, не шлёт периодических сообщений, ничего не выводит в консоль.
// Fail-open: любая ошибка → сайт получает исходный микрофон.
(() => {
  'use strict';
  if (window.__avtHooked) return; window.__avtHooked = true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let cfg = { profile: null, settings: { enabled: true, capture: 'page' }, workletSource: null };
  let resolveCfg; const cfgReady = new Promise((r) => { resolveCfg = r; });
  const engines = [];
  const params = () => (cfg.profile && cfg.profile.params) || null;
  window.addEventListener('message', (e) => {
    const d = e.data; if (e.source !== window || !d || d.avt !== 1 || d.from !== 'bridge' || d.type !== 'config') return;
    cfg = { profile: d.data.profile, settings: { enabled: true, capture: 'page', ...d.data.settings }, workletSource: d.data.workletSource || cfg.workletSource };
    resolveCfg(); engines.forEach((en) => en.apply(params()));
  });

  async function createEngine(track) {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    if (ctx.state !== 'running') await Promise.race([ctx.resume().catch(() => {}), sleep(400)]);
    if (ctx.state !== 'running') { ctx.close(); throw new Error('AudioContext не запущен (autoplay policy)'); }
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const dest = ctx.createMediaStreamDestination(); dest.channelCount = 1;
    const en = { ctx, node: null, alive: true, lastMeterAt: performance.now(), apply() {} };
    try {
      if (!cfg.workletSource) throw new Error('нет кода worklet');
      const url = URL.createObjectURL(new Blob([cfg.workletSource], { type: 'text/javascript' }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      const node = new AudioWorkletNode(ctx, 'avt-voice', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
      node.port.onmessage = (e) => { if (e.data && e.data.type === 'meters') en.lastMeterAt = performance.now(); };
      en.apply = (p) => { if (p) node.port.postMessage({ type: 'params', params: p }); };
      node.port.postMessage({ type: 'params', params: params() || {}, immediate: true });
      src.connect(node); node.connect(dest); en.node = node;
    } catch (err) {
      // CSP может блокировать blob-worklet → нативная цепочка: HPF + EQ + makeup + limiter (без gate/de-esser/компрессора)
      const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; const eqs = [0, 1, 2, 3, 4].map(() => ctx.createBiquadFilter());
      const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -2; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.08;
      const gain = ctx.createGain(); let prev = src; [hpf, ...eqs, gain, lim].forEach((n) => { prev.connect(n); prev = n; }); prev.connect(dest);
      en.apply = (p) => { if (!p) return; hpf.frequency.value = p.hpf.enabled ? p.hpf.freq : 10; hpf.Q.value = 0.707; eqs.forEach((f, i) => { const b = p.eq[i]; f.type = b.type; f.frequency.value = b.freq; f.Q.value = b.q; f.gain.value = b.enabled ? b.gainDb : 0; }); gain.gain.value = Math.pow(10, ((p.makeupDb || 0) + (p.inputGainDb || 0)) / 20); };
      en.apply(params());
    }
    // watchdog: worklet перестал работать → прямой маршрут (трек у сайта прежний)
    en.timer = setInterval(() => { if (en.node && en.alive && performance.now() - en.lastMeterAt > 2500) { en.alive = false; try { src.disconnect(); en.node.disconnect(); src.connect(dest); } catch (e) {} } }, 1000);
    en.dest = dest; return en;
  }

  async function processStream(stream) {
    const at = stream.getAudioTracks(); if (!at.length) return stream;
    await Promise.race([cfgReady, sleep(700)]);
    const orig = at[0], en = await createEngine(orig), out = en.dest.stream.getAudioTracks()[0];
    const origStop = out.stop.bind(out);
    const teardown = () => { clearInterval(en.timer); en.ctx.close().catch(() => {}); const i = engines.indexOf(en); if (i >= 0) engines.splice(i, 1); };
    out.stop = () => { origStop(); orig.stop(); teardown(); };
    orig.addEventListener('ended', () => { origStop(); teardown(); out.dispatchEvent(new Event('ended')); });
    Object.defineProperty(out, 'label', { value: orig.label });
    const og = out.getSettings.bind(out);
    out.getSettings = () => { const s = orig.getSettings(); return { ...og(), deviceId: s.deviceId, groupId: s.groupId, echoCancellation: s.echoCancellation, noiseSuppression: s.noiseSuppression, autoGainControl: s.autoGainControl }; };
    engines.push(en);
    return new MediaStream([out, ...stream.getVideoTracks()]);
  }

  const orig = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = async function getUserMedia(constraints) {
    if (!constraints || !constraints.audio || cfg.settings.enabled === false) return orig.call(this, constraints);
    let c = constraints;
    if (cfg.settings.capture === 'raw') c = { ...constraints, audio: { ...(typeof constraints.audio === 'object' ? constraints.audio : {}), noiseSuppression: false, autoGainControl: false } };
    const stream = await orig.call(this, c);
    try { return await processStream(stream); } catch (err) { return stream; }
  };
})();
