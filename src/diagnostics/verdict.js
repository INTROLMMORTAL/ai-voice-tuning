// Классификация причины «заиканий». Вход — снимки, которые собирает hook.js (engine-метрики + WebRTC getStats).
// Принцип: сначала локальный захват/CPU, потом отправка, потом сеть. DSP-обработка пакетные потери не лечит.
const pctl = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))] : NaN; };

export function classify(snaps, { windowSec = 30 } = {}) {
  const evidence = [];
  if (!snaps || snaps.length < 3) return { kind: 'unknown', evidence: ['Недостаточно данных (нужно ≥6 с активного соединения).'] };
  const now = snaps[snaps.length - 1].t, W = snaps.filter((s) => now - s.t <= windowSec * 1000);
  if (W.length < 3) return { kind: 'unknown', evidence: ['Недостаточно свежих данных.'] };
  const first = W[0], last = W[W.length - 1], dt = (last.t - first.t) / 1000;

  if (last.sender && last.sender.trackProcessed === false) return { kind: 'hook-miss', evidence: ['Сайт отправляет НЕ обработанный трек: расширение не перехватило захват (см. лог hook).'] };

  const zero = (last.engine?.zeroRunsTotal ?? 0) - (first.engine?.zeroRunsTotal ?? 0);
  const gaps = (last.engine?.gapEvents ?? 0) - (first.engine?.gapEvents ?? 0);
  const clamp = (last.engine?.hardClampTotal ?? 0) - (first.engine?.hardClampTotal ?? 0);
  const drift = Math.max(...W.map((s) => Math.abs(s.engine?.ctxDriftMs ?? 0)));
  if (last.engine && last.engine.workletAlive === false) evidence.push('AudioWorklet не отвечает — сработал failover на обход (трек идёт без обработки).');
  if (zero > 0) evidence.push(`Внезапная цифровая тишина на входе: ${zero} раз(а) — признак сбоя устройства/драйвера/USB, а не сети.`);
  if (gaps > 0 || drift > 30) evidence.push(`Нестабильность аудиопотока в браузере: gap-событий ${gaps}, дрейф таймлайна до ${Math.round(drift)} мс — загрузка CPU/планировщика или драйвер.`);
  if (zero > 0 || gaps > 0 || drift > 30) return { kind: 'local-capture', evidence };

  const pps = dt > 0 ? ((last.out?.packetsSent ?? 0) - (first.out?.packetsSent ?? 0)) / dt : NaN;
  const voiced = W.some((s) => (s.engine?.inRmsDb ?? -100) > -50);
  if (Number.isFinite(pps) && voiced && pps < 40) { evidence.push(`Отправка пакетов ${pps.toFixed(0)}/с при ожидаемых ~50/с (Opus 20 мс): отправитель «стопорится» — тяжёлая вкладка/энергосбережение.`); return { kind: 'local-send', evidence }; }

  const lostD = (last.remote?.packetsLost ?? 0) - (first.remote?.packetsLost ?? 0), sentD = Math.max(1, (last.out?.packetsSent ?? 0) - (first.out?.packetsSent ?? 0));
  const lossPct = (100 * lostD) / (lostD + sentD), jit = pctl(W.map((s) => s.remote?.jitterMs ?? NaN).filter(Number.isFinite), 0.9), rtt = pctl(W.map((s) => s.remote?.rttMs ?? s.pair?.rttMs ?? NaN).filter(Number.isFinite), 0.9);
  if (lossPct >= 2) evidence.push(`Потери пакетов до собеседника ≈ ${lossPct.toFixed(1)}% (по remote-inbound-rtp).`);
  if (jit > 30) evidence.push(`Джиттер P90 ≈ ${jit.toFixed(0)} мс.`);
  if (rtt > 400) evidence.push(`RTT P90 ≈ ${rtt.toFixed(0)} мс.`);
  if (evidence.length) { evidence.push('Это проблема сети/маршрута: EQ и компрессия её не исправят. Проверьте Wi-Fi→кабель, VPN, фоновые загрузки.'); return { kind: 'network', evidence }; }

  if (clamp > 200) evidence.push(`Limiter срабатывал «жёстко» ${clamp} сэмплов — снизьте усиление (возможны щелчки).`);
  const sm = last.sendMatchDb; if (Number.isFinite(sm)) evidence.push(`Уровень в отправляемом треке отличается от выхода DSP на ${sm.toFixed(1)} дБ (≈0 = передаётся именно обработанный сигнал).`);
  return { kind: 'ok', evidence: evidence.length ? evidence : ['Аномалий в доступных метриках не найдено.'] };
}
