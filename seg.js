// Audio segmentation (voice-activity based) + WAV encoding.
// Pure logic, no browser APIs — also loadable in Node for tests.

class Segmenter {
  constructor(sampleRate, onSegment, opts = {}) {
    this.rate = sampleRate;
    this.onSegment = onSegment;          // (float32Array, durationMs, startMs) => void
    this.o = Object.assign({
      minSegMs: 2500,     // don't cut before this much audio
      pauseMs: 650,       // a pause this long ends a sentence
      longSegMs: 12000,   // after this, a shorter pause is enough
      shortPauseMs: 250,
      maxSegMs: 20000,    // hard cut
      minSpeechMs: 400,   // less speech than this = noise, discard
      leadMs: 400,        // keep this much audio before speech starts
      absThresh: 0.006,
    }, opts);
    this.floor = 0.01;
    this.level = 0;
    this.clock = 0;       // ms since start
    this.reset();
  }
  reset() {
    this.frames = []; this.segMs = 0; this.speechMs = 0; this.silenceMs = 0; this.startMs = this.clock;
  }
  push(frame) {
    const n = frame.length, ms = n / this.rate * 1000;
    let sum = 0; for (let i = 0; i < n; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / n);
    this.level = rms;
    // adaptive noise floor: falls fast, rises very slowly
    if (rms < this.floor) this.floor = this.floor * 0.9 + rms * 0.1;
    else this.floor = this.floor * 0.999 + rms * 0.001;
    const thr = Math.max(this.floor * 2.5, this.o.absThresh);
    const speech = rms > thr;
    this.speaking = speech;

    this.frames.push(frame); this.segMs += ms; this.clock += ms;
    if (speech) { this.speechMs += ms; this.silenceMs = 0; } else this.silenceMs += ms;

    // no speech yet: keep only a short lead-in
    if (this.speechMs === 0) {
      while (this.segMs - this.frames[0].length / this.rate * 1000 >= this.o.leadMs && this.frames.length > 1) {
        this.segMs -= this.frames.shift().length / this.rate * 1000;
      }
      this.startMs = this.clock - this.segMs;
      return;
    }
    // a short blip followed by long silence: discard
    if (this.speechMs < this.o.minSpeechMs && this.silenceMs > 1500) { this.reset(); return; }

    const o = this.o;
    const cut = (this.segMs >= o.minSegMs && this.silenceMs >= o.pauseMs) ||
                (this.segMs >= o.longSegMs && this.silenceMs >= o.shortPauseMs) ||
                (this.segMs >= o.maxSegMs);
    if (cut && this.speechMs >= o.minSpeechMs) this.flush();
  }
  flush() {
    if (this.speechMs >= this.o.minSpeechMs && this.frames.length) {
      // trim trailing silence beyond 300 ms
      let trailing = this.silenceMs, frames = this.frames;
      while (trailing > 300 && frames.length > 1) {
        const fms = frames[frames.length - 1].length / this.rate * 1000;
        if (trailing - fms < 300) break;
        frames = frames.slice(0, -1); trailing -= fms;
      }
      let len = 0; frames.forEach(f => len += f.length);
      const out = new Float32Array(len); let off = 0;
      frames.forEach(f => { out.set(f, off); off += f.length; });
      this.onSegment(out, len / this.rate * 1000, this.startMs);
    }
    this.reset();
  }
}

function downsample(f32, inRate, outRate = 16000) {
  if (inRate <= outRate) return f32;
  const ratio = inRate / outRate, n = Math.floor(f32.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i * ratio), e = Math.min(f32.length, Math.floor((i + 1) * ratio));
    let sum = 0; for (let j = s; j < e; j++) sum += f32[j];
    out[i] = sum / Math.max(1, e - s);
  }
  return out;
}

function encodeWav(f32, rate) {
  const buf = new ArrayBuffer(44 + f32.length * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + f32.length * 2, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, f32.length * 2, true);
  for (let i = 0, o = 44; i < f32.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

if (typeof module !== "undefined") module.exports = { Segmenter, downsample, encodeWav };
