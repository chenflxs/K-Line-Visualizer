const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SignalModel, readBands, spectrumWick, frequencyAt, frequencyPosition } = require('../signal.js');
const sampleRate = 48000, fftSize = 16384;

function seededRandom() {
  let seed = 12345;
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
function toneBins(frequency = 1000, level = -60) {
  const bins = new Float32Array(fftSize / 2).fill(-100);
  bins[Math.round(frequency * fftSize / sampleRate)] = level;
  return bins;
}
function samples(rms, gain, randomness) {
  const model = new SignalModel(seededRandom()), bins = toneBins();
  const candles = [];
  for (let i = 0; i < 100; i++) {
    model.update(rms, bins, sampleRate, fftSize, .25, gain, .35, 250);
    candles.push(model.sample(i * .25, gain, randomness, .35));
  }
  return candles;
}
const averageMovement = candles => candles.reduce((total, c) => total + Math.abs(c.close - c.open), 0) / candles.length;

test('very quiet audio still produces substantial, bidirectional candle movement', () => {
  const candles = samples(.0001, 4, .8); // -80 dBFS: well below the old byte-resolution waveform.
  assert.ok(averageMovement(candles) > 4);
  assert.ok(candles.filter(c => c.close > c.open).length > 20);
  assert.ok(candles.filter(c => c.close < c.open).length > 20);
});
test('gain improves quiet-audio motion without modifying input levels', () => {
  const low = samples(.0001, 1, .8), high = samples(.0001, 8, .8);
  assert.ok(averageMovement(high) > averageMovement(low) * 1.2);
});
test('randomness creates variation for a steady tone and can be disabled', () => {
  const steady = samples(.001, 4, 0), varied = samples(.001, 4, .8);
  assert.ok(averageMovement(steady) < .001);
  assert.ok(averageMovement(varied) > 6);
});
test('silence lowers the trend steadily over two seconds and then stays flat', () => {
  for (const interval of [.1, .25, .5]) {
    const model = new SignalModel(seededRandom()), silentBins = new Float32Array(8192).fill(-Infinity);
    model.update(.01, toneBins(), sampleRate, fftSize, .1, 8, .35);
    const active = model.sample(0, 8, 1, .35);
    model.update(0, silentBins, sampleRate, fftSize, .03, 8, .35);
    let last = model.sample(.03, 8, 1, .35);
    assert.equal(last.close, active.close);
    for (let i = 1; i <= Math.round(2 / interval); i++) {
      model.update(0, silentBins, sampleRate, fftSize, interval, 8, .35);
      const candle = model.sample(.03 + i * interval, 8, 1, .35);
      assert.equal(candle.open, last.close);
      assert.ok(candle.close <= candle.open);
      assert.ok(Math.abs(candle.close - (active.close + (200 - active.close) * Math.min(1, i * interval / 2))) < 1e-8);
      assert.equal(candle.high, candle.open);
      assert.equal(candle.low, candle.close);
      last = candle;
    }
    assert.ok(Math.abs(last.close - 200) < 1e-8);
    model.update(0, silentBins, sampleRate, fftSize, .5, 8, .35);
    const flat = model.sample(2.53, 8, 1, .35);
    assert.equal(flat.close, 200);
  }
});

test('returning audio cancels an unfinished silence fall and a later silence starts afresh', () => {
  const model = new SignalModel(seededRandom()), bins = toneBins(), silent = new Float32Array(8192).fill(-Infinity);
  model.update(.01, bins, sampleRate, fftSize, .03, 4, .35);
  model.sample(0, 4, 1, .35);
  model.update(0, silent, sampleRate, fftSize, .03, 4, .35);
  model.update(0, silent, sampleRate, fftSize, .75, 4, .35);
  const partial = model.sample(.78, 4, 1, .35);
  assert.ok(partial.close > 200);
  model.update(.01, bins, sampleRate, fftSize, .03, 4, .35);
  const resumed = model.sample(.81, 4, 1, .35);
  assert.equal(resumed.open, partial.close);
  assert.equal(model.silenceStartPrice, null);
  model.update(0, silent, sampleRate, fftSize, .03, 4, .35);
  assert.equal(model.silenceStartPrice, resumed.close);
  assert.equal(model.silenceElapsed, 0);
  assert.equal(model.sample(.84, 4, 1, .35).close, resumed.close);
});

test('logarithmic spectrum bins locate a known tone correctly', () => {
  const bands = readBands(toneBins(), sampleRate, fftSize);
  const peak = bands.reduce((a, b) => a.maximum > b.maximum ? a : b);
  const actualHz = Math.round(1000 * fftSize / sampleRate) * sampleRate / fftSize;
  assert.ok(peak.lowHz <= actualHz && peak.highHz >= actualHz);
  assert.equal(bands.length, 80);
  assert.ok(bands.every((b, i) => i === 0 || b.frequency > bands[i - 1].frequency));
});
test('frequency candles join consecutive closes and enclose measured band peaks', () => {
  const model = new SignalModel();
  model.update(.001, toneBins(1000, -70), sampleRate, fftSize, .05, 4, 0, 250);
  const actualHz = Math.round(1000 * fftSize / sampleRate) * sampleRate / fftSize;
  const index = model.bands.findIndex(b => b.lowHz <= actualHz && b.highHz >= actualHz);
  const first = model.spectrum[index].high;
  model.update(.002, toneBins(1000, -30), sampleRate, fftSize, .05, 4, 0, 250);
  const candle = model.spectrum[index];
  assert.equal(first, 0);
  assert.equal(candle.high, 0);
  for (let i = 0; i < model.spectrum.length; i++) {
    const c = model.spectrum[i];
    assert.equal(c.open, i ? model.spectrum[i - 1].close : c.close);
    assert.ok(c.high >= Math.max(c.open, c.close));
    assert.ok(c.low <= Math.min(c.open, c.close));
  }
  // A peak that disappears must not remain as a stale temporal wick.
  for (let i = 0; i < 10; i++) model.update(.001, new Float32Array(fftSize / 2).fill(-80), sampleRate, fftSize, .05, 4, 0);
  assert.ok(model.spectrum[index].high < -5);
});
test('frequency curves are unaffected by visual gain and randomness', () => {
  const a = new SignalModel(seededRandom()), b = new SignalModel(seededRandom());
  for (let i = 0; i < 6; i++) {
    const bins = toneBins(1000, -50 + i);
    a.update(.001, bins, sampleRate, fftSize, .05, 1, .35, 250);
    b.update(.001, bins, sampleRate, fftSize, .05, 8, .35, 250);
    a.sample(i * .05, 1, 0, .35); b.sample(i * .05, 8, 1, .35);
  }
  assert.deepEqual(a.spectrum, b.spectrum);
});

test('100 to 500 Hz receives half the frequency candles and matching axis space', () => {
  const bands = readBands(toneBins(), sampleRate, fftSize);
  assert.equal(bands[0].lowHz, 100);
  assert.ok(Math.abs(bands.at(-1).highHz - 16000) < 1e-8);
  assert.equal(bands.filter(b => b.highHz <= 500).length, 40);
  assert.equal(frequencyPosition(500), .5);
  for (const hz of [100, 150, 250, 500, 1000, 4000, 8000, 16000]) {
    assert.ok(Math.abs(frequencyAt(frequencyPosition(hz)) - hz) < 1e-8);
  }
});

test('frequency shape ignores overall loudness and RMS, even far below the trend silence gate', () => {
  const bins = toneBins(250, -40);
  bins[Math.round(4000 * fftSize / sampleRate)] = -50;
  const quietBins = Float32Array.from(bins, value => value - 70);
  const a = new SignalModel(), b = new SignalModel();
  a.update(.1, bins, sampleRate, fftSize, .05, 1, .35);
  b.update(.0000001, quietBins, sampleRate, fftSize, .05, 8, .35);
  a.spectrum.forEach((c, i) => {
    for (const field of ['open', 'close', 'high', 'low']) assert.ok(Math.abs(c[field] - b.spectrum[i][field]) < 1e-9);
  });
});

test('high-frequency compensation raises an 8 kHz peak by 6 dB relative to bass', () => {
  const bins = toneBins(250, -40);
  bins[Math.round(8000 * fftSize / sampleRate)] = -60;
  const bands = readBands(bins, sampleRate, fftSize);
  const actualHz = Math.round(8000 * fftSize / sampleRate) * sampleRate / fftSize;
  const band = bands.find(b => b.lowHz <= actualHz && b.highHz >= actualHz);
  assert.ok(Math.abs(band.maximum - (-14)) < .01);
});

test('out-of-range tones do not change normalization of the visible curve', () => {
  const bins = toneBins(1000, -60), cropped = bins.slice();
  cropped[Math.round(50 * fftSize / sampleRate)] = 0;
  cropped[Math.round(18000 * fftSize / sampleRate)] = 0;
  assert.deepEqual(readBands(bins, sampleRate, fftSize), readBands(cropped, sampleRate, fftSize));
});

test('frequency spectrum remains finite and flat when no frequency data exists', () => {
  const model = new SignalModel();
  model.update(0, new Float32Array(fftSize / 2).fill(-Infinity), sampleRate, fftSize, .05, 4, .35);
  assert.ok(model.spectrum.every(c => c.open === -96 && c.close === -96 && c.high === -96 && c.low === -96));
  assert.equal(model.spectrumSilent, true);
});

test('digital silence bypasses smoothing and stale FFT peaks; returning audio restores its shape', () => {
  const model = new SignalModel(), bins = toneBins();
  model.update(.01, bins, sampleRate, fftSize, .03, 4, .9);
  model.update(0, bins, sampleRate, fftSize, .03, 4, .9);
  assert.equal(model.spectrumSilent, true);
  assert.ok(model.spectrum.every(c => c.open === -96 && c.close === -96 && c.high === -96 && c.low === -96));
  model.update(.0000001, bins, sampleRate, fftSize, .03, 4, .9);
  assert.equal(model.spectrumSilent, false);
  assert.deepEqual(model.spectrum.map(c => c.close), readBands(bins, sampleRate, fftSize).map(b => b.level));
});

test('frequency response follows the current frame immediately without smoothing or retained peaks', () => {
  const model = new SignalModel();
  const first = toneBins(250, -20), next = toneBins(8000, -25);
  model.update(.1, first, sampleRate, fftSize, .03, 4, 0);
  model.update(.001, next, sampleRate, fftSize, .03, 4, 0);
  const current = readBands(next, sampleRate, fftSize);
  model.spectrum.forEach((c, i) => {
    assert.equal(c.close, current[i].level);
    assert.equal(c.minimum, current[i].minimum);
    assert.equal(c.maximum, current[i].maximum);
    assert.equal(c.open, i ? current[i - 1].level : current[i].level);
  });
});

test('all frequency wicks have a fixed cap while preserving short wicks and full OHLC', () => {
  const candle = { frequency: 8000, open: -40, close: -36, high: -10, low: -90 };
  const displayed = spectrumWick(candle);
  assert.equal(displayed.high, -33);
  assert.equal(displayed.low, -43);
  assert.equal(candle.high, -10);
  assert.equal(candle.low, -90);
  const bass = { ...candle, frequency: 250 };
  assert.deepEqual(spectrumWick(bass), displayed);
  assert.deepEqual(spectrumWick({ ...candle, high: -20, low: -60 }), displayed);
  const narrow = { ...candle, high: -35, low: -41 };
  assert.deepEqual(spectrumWick(narrow), { high: -35, low: -41 });
});

test('30 percent smoothing reduces rapid spectrum jitter and converges without breaking candle continuity', () => {
  const raw = new SignalModel(), smooth = new SignalModel();
  let rawMovement = 0, smoothMovement = 0, previousRaw, previousSmooth;
  const index = readBands(toneBins(), sampleRate, fftSize).findIndex(b => b.lowHz <= 8000 && b.highHz >= 8000);
  const binsFor = level => {
    const bins = toneBins(250, -20);
    for (let j = Math.round(7500 * fftSize / sampleRate); j < Math.round(8500 * fftSize / sampleRate); j++) bins[j] = level;
    return bins;
  };
  for (let i = 0; i < 40; i++) {
    const bins = binsFor(i % 2 ? -35 : -65);
    raw.update(.01, bins, sampleRate, fftSize, .03, 4, 0);
    smooth.update(.01, bins, sampleRate, fftSize, .03, 4, .3);
    const a = raw.spectrum[index].close, b = smooth.spectrum[index].close;
    if (i) { rawMovement += Math.abs(a - previousRaw); smoothMovement += Math.abs(b - previousSmooth); }
    previousRaw = a; previousSmooth = b;
    smooth.spectrum.forEach((c, j) => {
      assert.equal(c.open, j ? smooth.spectrum[j - 1].close : c.close);
      assert.ok(c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close));
    });
  }
  assert.ok(smoothMovement < rawMovement * .2);
  const held = binsFor(-35);
  for (let i = 0; i < 60; i++) smooth.update(.01, held, sampleRate, fftSize, .03, 4, .3);
  assert.ok(Math.abs(smooth.spectrum[index].close - readBands(held, sampleRate, fftSize)[index].level) < .1);
});
