// Запись только по явной команде из Audio Lab (калибровка). Данные остаются в памяти страницы Lab.
class AvtRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.on = false; this.buf = []; this.len = 0; this.port.onmessage = (e) => { this.on = !!e.data.record; }; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (this.on && ch) {
      this.buf.push(Float32Array.from(ch)); this.len += ch.length;
      if (this.len >= 4096) {
        const o = new Float32Array(this.len); let k = 0; for (const b of this.buf) { o.set(b, k); k += b.length; }
        this.port.postMessage(o, [o.buffer]); this.buf = []; this.len = 0;
      }
    }
    return true;
  }
}
registerProcessor('avt-recorder', AvtRecorder);
