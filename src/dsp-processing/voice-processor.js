import { VoiceDSP } from './dsp-core.js';
class AvtVoice extends AudioWorkletProcessor {
  constructor() {
    super();
    this.dsp = new VoiceDSP(sampleRate, { lookaheadMs: 1 });
    this.acc = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'params') this.dsp.setParams(d.params, { immediate: !!d.immediate });
      else if (d.type === 'reset') this.dsp.reset();
    };
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!out || !out[0]) return true;
    if (!inp || !inp[0]) { out[0].fill(0); } else {
      this.dsp.process(inp[0], out[0]);
      for (let c = 1; c < out.length; c++) out[c].set(out[0]);
    }
    this.acc += out[0].length;
    if (this.acc >= sampleRate * 0.1) { this.acc = 0; this.port.postMessage({ type: 'meters', m: this.dsp.readMeters(), t: currentTime }); }
    return true;
  }
}
registerProcessor('avt-voice', AvtVoice);
