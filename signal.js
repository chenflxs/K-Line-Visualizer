'use strict';

// Keep signal mapping independent of the audio devices and canvas renderer.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KLineSignal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const db = rms => rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
  const SILENCE_RMS = .00003;
  const TREND_FLOOR = 200;
  const SILENCE_FALL_SECONDS = 2;

  const SPECTRUM_FLOOR = -96;
  const BAND_COUNT = 80;
  const MIN_HZ = 100, MAX_HZ = 16000, HIGH_GAIN_DB = 6;
  const highGainAt = hz => HIGH_GAIN_DB * clamp(Math.log2(hz / 2000) / 2, 0, 1);
  // Half the horizontal space resolves bass; the remaining sections retain a log axis.
  function frequencyAt(position, maximum = MAX_HZ) {
    const bassEnd = Math.min(500, maximum), midEnd = Math.min(4000, maximum);
    if (position <= .5) return MIN_HZ * (bassEnd / MIN_HZ) ** (position / .5);
    if (position <= .8) return bassEnd * (midEnd / bassEnd) ** ((position - .5) / .3);
    return midEnd * (maximum / midEnd) ** ((position - .8) / .2);
  }
  function frequencyPosition(hz, maximum = MAX_HZ) {
    const bassEnd = Math.min(500, maximum), midEnd = Math.min(4000, maximum);
    if (hz <= bassEnd) return .5 * Math.log(hz / MIN_HZ) / Math.log(bassEnd / MIN_HZ);
    if (hz <= midEnd) return .5 + .3 * Math.log(hz / bassEnd) / Math.log(midEnd / bassEnd);
    return .8 + .2 * Math.log(hz / midEnd) / Math.log(maximum / midEnd);
  }

  function readBands(bins, sampleRate, fftSize, count = BAND_COUNT) {
    const step = sampleRate / fftSize;
    const maxHz = Math.min(MAX_HZ, sampleRate / 2 - step);
    let peak = -Infinity;
    for (let j = Math.ceil(MIN_HZ / step); j <= Math.min(bins.length - 1, Math.floor(maxHz / step)); j++) {
      if (Number.isFinite(bins[j])) peak = Math.max(peak, bins[j] + highGainAt(j * step));
    }
    // Remove common loudness shifts. Work directly in dB, without summing band power.
    const relative = index => Number.isFinite(peak) && Number.isFinite(bins[index]) ? clamp(bins[index] + highGainAt(index * step) - peak, SPECTRUM_FLOOR, 0) : SPECTRUM_FLOOR;
    const atHz = hz => {
      const index = clamp(hz / step, 1, bins.length - 1);
      const left = Math.floor(index), right = Math.min(left + 1, bins.length - 1);
      return relative(left) + (relative(right) - relative(left)) * (index - left);
    };
    return Array.from({ length: count }, (_, i) => {
      const low = frequencyAt(i / count, maxHz), high = frequencyAt((i + 1) / count, maxHz);
      const frequency = Math.sqrt(low * high), level = atHz(frequency);
      let minimum = Math.min(atHz(low), atHz(high), level), maximum = Math.max(atHz(low), atHz(high), level);
      for (let j = Math.ceil(low / step); j * step <= high && j < bins.length; j++) {
        minimum = Math.min(minimum, relative(j)); maximum = Math.max(maximum, relative(j));
      }
      return { frequency, lowHz: low, highHz: high, level, minimum, maximum };
    });
  }

  class SignalModel {
    constructor(random = Math.random) { this.random = random; this.reset(); }
    reset() {
      this.price = 1000; this.reference = .006; this.activity = 0;
      this.lastDb = null; this.lastCentroid = null; this.momentum = 0;
      this.rms = 0; this.levelDb = -100; this.centroid = 0;
      this.silenceStartPrice = null; this.silenceElapsed = 0;
      this.bands = []; this.spectrum = []; this.spectrumSilent = false;
    }

    update(rms, bins, sampleRate, fftSize, dt, gain, smoothing = 0) {
      this.rms = rms;
      this.levelDb = db(rms);
      const active = rms > SILENCE_RMS;
      if (active) {
        this.silenceStartPrice = null; this.silenceElapsed = 0;
      } else if (this.silenceStartPrice === null) {
        this.silenceStartPrice = this.price; this.silenceElapsed = 0;
      } else {
        this.silenceElapsed = Math.min(SILENCE_FALL_SECONDS, this.silenceElapsed + dt);
      }
      const referenceRate = rms > this.reference ? 8 : 1.3;
      this.reference += (Math.max(rms, .0008) - this.reference) * (1 - Math.exp(-dt * referenceRate));
      // Relative loudness and a square-root curve lift quiet music without changing its sound.
      const relative = rms / Math.max(.0015, this.reference * .65);
      this.activity = active ? clamp(Math.sqrt(relative) * Math.sqrt(gain / 2), 0, 1) : 0;
      this.bands = readBands(bins, sampleRate, fftSize);
      const wasSpectrumSilent = this.spectrumSilent;
      // Digital silence is separate from the trend gate: preserve very quiet spectra.
      this.spectrumSilent = rms === 0 || !bins.some(Number.isFinite);
      if (this.spectrumSilent) {
        this.bands = this.bands.map(band => ({ ...band, level: SPECTRUM_FLOOR, minimum: SPECTRUM_FLOOR, maximum: SPECTRUM_FLOOR }));
      }
      let weight = 0, weightedFrequency = 0;
      for (const band of this.bands) {
        const magnitude = 10 ** (band.level / 20);
        weight += magnitude; weightedFrequency += Math.log2(band.frequency) * magnitude;
      }
      this.centroid = weight > 1e-6 ? weightedFrequency / weight : 0;

      const alpha = this.spectrumSilent || wasSpectrumSilent || smoothing <= 0 ? 1 : 1 - Math.exp(-dt / (.02 + smoothing * .45));
      this.bands.forEach((band, i) => {
        const previous = this.spectrum[i];
        const close = previous ? previous.close + (band.level - previous.close) * alpha : band.level;
        // OHLC traverses frequency: every open joins the preceding band's close.
        const open = i ? this.spectrum[i - 1].close : close;
        this.spectrum[i] = { ...band, open, close,
          high: Math.max(band.maximum, open, close), low: Math.min(band.minimum, open, close) };
      });
    }

    sample(time, gain, randomness, smoothing) {
      const open = this.price;
      if (this.rms <= SILENCE_RMS) {
        this.momentum = 0; this.lastDb = null; this.lastCentroid = null;
        const progress = clamp(this.silenceElapsed / SILENCE_FALL_SECONDS, 0, 1);
        const start = this.silenceStartPrice ?? open;
        this.price = progress === 1 ? TREND_FLOOR : start + (TREND_FLOOR - start) * progress;
        return { open, close: this.price, high: Math.max(open, this.price), low: Math.min(open, this.price), energy: 0, time };
      }
      const dbChange = this.lastDb === null ? 0 : clamp(this.levelDb - this.lastDb, -14, 14);
      const colorChange = this.lastCentroid === null ? 0 : clamp(this.centroid - this.lastCentroid, -2, 2);
      const noise = (this.random() + this.random() + this.random() - 1.5) * 1.8;
      const volatility = (4 + this.activity * 17) * randomness;
      const impulse = dbChange * (1 + gain * .25) + colorChange * 10 + noise * volatility;
      const retention = .12 + smoothing * .52;
      this.momentum = this.momentum * retention + impulse * (1 - retention * .35);
      const movement = this.momentum + (1000 - open) * .008;
      const close = clamp(open + movement, TREND_FLOOR, 1800);
      const wick = this.activity * (3 + gain * 2) * (.3 + randomness);
      this.lastDb = this.levelDb; this.lastCentroid = this.centroid; this.price = close;
      return { open, close, high: Math.max(open, close) + wick * (.25 + this.random() * 1.5), low: Math.min(open, close) - wick * (.25 + this.random() * 1.5), energy: this.activity, time };
    }
  }
  // Cap each drawn extension at 3 dB; retain short wicks and real OHLC extrema.
  function spectrumWick(candle) {
    const bodyHigh = Math.max(candle.open, candle.close), bodyLow = Math.min(candle.open, candle.close);
    return {
      high: Math.min(candle.high, bodyHigh + 3), low: Math.max(candle.low, bodyLow - 3)
    };
  }
  return { SignalModel, readBands, spectrumWick, frequencyAt, frequencyPosition, highGainAt, MIN_HZ, MAX_HZ, HIGH_GAIN_DB, BAND_COUNT, SPECTRUM_FLOOR, TREND_FLOOR, SILENCE_FALL_SECONDS, db, SILENCE_RMS };
});
