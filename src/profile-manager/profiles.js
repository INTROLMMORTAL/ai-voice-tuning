// Режимы. Каждый режим меняет веса/политику tuner'а, а значит — реальную цепочку DSP (см. tests/tuner.test.js).
export const MODES = {
  natural:   { label: 'Natural Voice', desc: 'Минимум обработки: HPF, мягкая коррекция, limiter.', eqAmount: 0.5, comp: 0.0, deess: 'auto-strong-only', gate: 'off', target: -22, bias: {} },
  clear:     { label: 'Clear Voice', desc: 'Разборчивость: коррекция присутствия, умеренная компрессия.', eqAmount: 1.0, comp: 0.7, deess: 'auto', gate: 'auto', target: -20, bias: { presence: 1.0 } },
  warm:      { label: 'Warm Voice', desc: 'Лёгкое тепло в низах без «утяжеления».', eqAmount: 0.8, comp: 0.4, deess: 'auto', gate: 'auto', target: -21, bias: { body: 1.0, harsh: -1.0 } },
  crisp:     { label: 'Crisp Voice', desc: 'Чёткость + контроль сибилянтов и резкости.', eqAmount: 1.0, comp: 0.7, deess: 'always', gate: 'auto', target: -20, bias: { presence: 1.5, air: 1.0 } },
  noise:     { label: 'Noise Control', desc: 'Сильнее гейт/HPF, мягче компрессия (она поднимает шум).', eqAmount: 0.6, comp: 0.4, deess: 'auto', gate: 'strong', target: -21, bias: {}, hpfExtra: 15 },
  broadcast: { label: 'Broadcast', desc: 'Стабильная громкость: сильнее компрессия, цель −18 LUFS.', eqAmount: 1.0, comp: 1.2, deess: 'auto', gate: 'auto', target: -18, bias: { presence: 0.5 } },
  lowlatency:{ label: 'Low Latency', desc: 'Только HPF + gain + limiter (минимум блоков). Разница в задержке ≈0.7 мс, главный выигрыш — CPU.', eqAmount: 0, comp: 0, deess: 'off', gate: 'off', target: -22, bias: {} },
  custom:    { label: 'Custom AI Profile', desc: 'Персональный: режим, выбранный вами при калибровке + ваши ручные поправки.', eqAmount: 1.0, comp: 0.7, deess: 'auto', gate: 'auto', target: -20, bias: {} },
};
export const MODE_IDS = Object.keys(MODES);

export const emptyProfile = () => ({ version: 1, mode: 'clear', params: null, metrics: null, reasons: [], device: null, createdAt: null, manualOverrides: {}, history: [] });

/** Хранит до 5 предыдущих версий для отката. */
export function pushHistory(profile, next) {
  const hist = [...(profile.history || [])];
  if (profile.params) hist.unshift({ at: Date.now(), mode: profile.mode, params: profile.params, reasons: profile.reasons });
  return { ...next, history: hist.slice(0, 5) };
}
export function revertProfile(profile) {
  const [prev, ...rest] = profile.history || []; if (!prev) return profile;
  return { ...profile, mode: prev.mode, params: prev.params, reasons: prev.reasons, history: rest };
}
