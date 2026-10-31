// Изолированный мир. Передаёт странице ОДНО сообщение с профилем и кодом worklet (при изменении настроек — ещё одно).
// Никаких атрибутов в DOM, web_accessible_resources нет, статусов страница не получает.
(() => {
  const send = (data) => window.postMessage({ avt: 1, from: 'bridge', type: 'config', data }, '*');
  let source = null;
  async function workletSource() {
    if (source) return source;
    const get = async (p) => (await fetch(chrome.runtime.getURL(p))).text();
    const core = (await get('src/dsp-processing/dsp-core.js')).replace(/^export\s+/gm, '');
    const proc = (await get('src/dsp-processing/voice-processor.js')).replace(/^import .*$/m, '');
    return (source = core + '\n' + proc);
  }
  async function push() {
    try { const s = await chrome.storage.local.get(['avtProfile', 'avtSettings']); send({ profile: s.avtProfile || null, settings: s.avtSettings || {}, workletSource: await workletSource() }); } catch (e) { /* расширение перезагружено */ }
  }
  push(); chrome.storage.onChanged.addListener(push);
})();
