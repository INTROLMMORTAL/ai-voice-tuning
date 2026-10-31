import { MODES, MODE_IDS, emptyProfile } from '../profile-manager/profiles.js';
import { tune } from '../auto-tuning/tuner.js';
const $ = (id) => document.getElementById(id);
const store = { get: (k) => chrome.storage.local.get(k), set: (o) => chrome.storage.local.set(o) };
let profile = emptyProfile(), settings = { enabled: true, capture: 'page' };
async function init() {
  const s = await store.get(['avtProfile', 'avtSettings']); profile = s.avtProfile || emptyProfile(); settings = { ...settings, ...(s.avtSettings || {}) };
  $('mode').innerHTML = MODE_IDS.map((id) => `<option value="${id}">${MODES[id].label}</option>`).join(''); $('mode').value = profile.mode;
  $('on').checked = settings.enabled !== false; $('bp').checked = !!(profile.params && profile.params.bypass); $('cap').value = settings.capture || 'page';
  $('note').textContent = profile.metrics ? MODES[profile.mode].desc : 'Калибровка не пройдена — используется консервативный профиль.';
  $('mode').onchange = async () => { const mode = $('mode').value; const t = tune(profile.metrics, { mode }); profile = { ...profile, mode, params: t.params, reasons: t.reasons }; await store.set({ avtProfile: profile }); $('note').textContent = MODES[mode].desc; };
  $('on').onchange = () => { settings.enabled = $('on').checked; store.set({ avtSettings: settings }); };
  $('cap').onchange = () => { settings.capture = $('cap').value; store.set({ avtSettings: settings }); };
  $('bp').onchange = async () => { const base = profile.params || tune(profile.metrics, { mode: profile.mode }).params; profile = { ...profile, params: { ...base, bypass: $('bp').checked } }; await store.set({ avtProfile: profile }); };
  $('lab').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/lab.html') });
  $('st').innerHTML = '<span class="muted">Режим минимального следа: на странице подменяется только getUserMedia, диагностика WebRTC отключена. После изменения настроек перезагрузите вкладку nekto.me.</span>';
}
init();
