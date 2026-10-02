// Exercise system-audio source ownership without requesting real screen-sharing permission.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const KLineSignal = require('../signal.js');

class Element {
  constructor() {
    this.value = '0'; this.min = '0'; this.max = '100'; this.disabled = false;
    this.children = []; this.listeners = {}; this.attributes = {};
    this.classList = { toggle() {}, add() {}, remove() {} };
    this.style = { setProperty() {} };
  }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelector() { return this.child ||= new Element(); }
  querySelectorAll() { return []; }
  appendChild(child) { this.children.push(child); }
  getContext() {
    if (!this.context) {
      this.context = { calls: [] };
      for (const name of ['setTransform', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fillRect', 'fillText', 'setLineDash']) {
        this.context[name] = (...args) => this.context.calls.push([name, ...args]);
      }
    }
    return this.context;
  }
  getBoundingClientRect() { return { width: 900, height: 400 }; }
}

class AudioNode {
  constructor() { this.connections = []; this.gain = { value: 1, setTargetAtTime() {} }; }
  connect(target) { this.connections.push(target); }
  disconnect() { this.connections = []; this.disconnected = true; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
}

function setup(getDisplayMedia, resume = () => Promise.resolve()) {
  let captureCalls = 0, captureOptions;
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const document = {
    getElementById: get,
    querySelector: selector => selector === 'dialog[open]' ? null : get(selector),
    querySelectorAll: () => [],
    createElement: () => new Element(),
    addEventListener() {},
    body: get('body'), documentElement: get('documentElement')
  };
  class FakeAudioContext {
    constructor() { this.currentTime = 0; this.sampleRate = 44100; this.destination = new AudioNode(); }
    createAnalyser() { const node = new AudioNode(); node.frequencyBinCount = 1024; return node; }
    createGain() { return new AudioNode(); }
    createMediaStreamSource() { return new AudioNode(); }
    createBufferSource() { return new AudioNode(); }
    createBuffer(channels, length) {
      // Synth sample generation itself is covered by browser playback; only source lifecycle matters here.
      return { getChannelData: () => new Float32Array(Math.min(length, 100)) };
    }
    resume() { return resume(); }
    suspend() { return Promise.resolve(); }
  }
  const code = readFileSync(join(__dirname, '..', 'app.js'), 'utf8');
  let api;
  runInNewContext(code.replace(/\}\)\(\);\s*$/, 'expose({ state, model, play, pause, setSource, setView, frame, resizeCanvas, geometry, getSource: () => source, getAnalyser: () => analyser }); })();'), {
    document, navigator: { mediaDevices: getDisplayMedia ? { getDisplayMedia: options => { captureCalls++; captureOptions = options; return getDisplayMedia(options); } } : {} },
    window: { AudioContext: FakeAudioContext, addEventListener() {} },
    KLineSignal, URLSearchParams, location: { search: '', pathname: '/index.html' }, history: { replaceState() {} },
    ResizeObserver: class { observe() {} },
    requestAnimationFrame() {}, setTimeout: () => 0, clearTimeout() {},
    Float32Array, Uint8Array, expose: value => { api = value; }
  });
  return { ...api, elements, captureCalls: () => captureCalls, captureOptions: () => captureOptions };
}

function capture(hasAudio = true) {
  const audio = { kind: 'audio', stops: 0, stop() { this.stops++; } };
  const video = { kind: 'video', stops: 0, stop() { this.stops++; } };
  return { audio, video, stream: { getTracks: () => hasAudio ? [audio, video] : [video], getAudioTracks: () => hasAudio ? [audio] : [] } };
}

test('system audio is the default and startup does not request permission or generate fake data', () => {
  const app = setup(async () => capture().stream);
  assert.equal(app.state.mode, 'speakers');
  assert.equal(app.state.candles.length, 0);
  assert.equal(app.captureCalls(), 0);
  assert.equal(app.elements.get('sourceSelect').value, 'speakers');
  assert.equal(app.elements.get('mediaControls').hidden, true);
});

test('sharing is requested during the click before awaiting audio-context resume', async () => {
  let grant, resumes = 0;
  const pending = new Promise(resolve => { grant = resolve; });
  const app = setup(() => pending, () => { resumes++; return Promise.resolve(); });
  const playing = app.play();
  assert.equal(app.captureCalls(), 1);
  assert.equal(resumes, 0);
  assert.equal(app.captureOptions().systemAudio, 'include');
  assert.equal(app.captureOptions().audio.suppressLocalAudioPlayback, false);
  grant(capture().stream);
  await playing;
  assert.equal(app.state.playing, true);
  assert.equal(resumes, 1);
  app.pause();
});

test('sharing granted after switching source releases both audio and video', async () => {
  let grant, notifyRequested;
  const pending = new Promise(resolve => { grant = resolve; });
  const requested = new Promise(resolve => { notifyRequested = resolve; });
  const app = setup(() => { notifyRequested(); return pending; }), shared = capture();
  const playing = app.play();
  await requested;
  app.setSource('demo');
  grant(shared.stream);
  await playing;
  assert.equal(shared.audio.stops, 1);
  assert.equal(shared.video.stops, 1);
  assert.equal(app.state.mode, 'demo');
  assert.equal(app.state.playing, false);
  assert.equal(app.state.loading, false);
});

test('stopping releases all shared tracks without replaying captured audio', async () => {
  const shared = capture(), app = setup(async () => shared.stream);
  await app.play();
  assert.equal(app.state.playing, true);
  assert.equal(app.getAnalyser().connections.length, 0);
  const node = app.getSource();
  app.pause();
  assert.equal(shared.audio.stops, 1);
  assert.equal(shared.video.stops, 1);
  assert.equal(node.disconnected, true);
  assert.equal(app.state.playing, false);
});

test('denied sharing permission leaves playback usable', async () => {
  const app = setup(async () => { const error = new Error('denied'); error.name = 'NotAllowedError'; throw error; });
  await app.play();
  assert.equal(app.state.loading, false);
  assert.equal(app.state.playing, false);
  assert.equal(app.elements.get('playButton').disabled, false);
  app.setSource('demo');
  await app.play();
  assert.equal(app.state.playing, true);
});

test('demo audio does not fabricate candles while paused', async () => {
  const app = setup(async () => capture().stream);
  app.setSource('demo');
  assert.equal(app.state.candles.length, 0);
  await app.play();
  assert.equal(app.state.candles.length, 0);
  assert.equal(app.getSource().started, true);
  app.pause();
  assert.equal(app.state.playing, false);
});

test('a shared screen without audio is rejected and released', async () => {
  const shared = capture(false), app = setup(async () => shared.stream);
  await app.play();
  assert.equal(shared.video.stops, 1);
  assert.equal(app.state.playing, false);
  assert.equal(app.state.loading, false);
  assert.match(app.elements.get('sourceNote').textContent, /未获取到共享音频/);
});

test('ending screen sharing releases the companion audio track', async () => {
  const shared = capture(), app = setup(async () => shared.stream);
  await app.play();
  shared.video.onended();
  assert.equal(shared.audio.stops, 1);
  assert.equal(shared.video.stops, 1);
  assert.equal(app.state.playing, false);
  assert.equal(shared.video.onended, null);
});

test('an audio-context resume failure releases the granted capture', async () => {
  const shared = capture(), app = setup(async () => shared.stream, async () => { throw new Error('audio unavailable'); });
  await app.play();
  assert.equal(shared.audio.stops, 1);
  assert.equal(shared.video.stops, 1);
  assert.equal(app.state.loading, false);
});

test('browsers without display capture show an actionable error', async () => {
  const app = setup();
  await app.play();
  assert.equal(app.state.loading, false);
  assert.equal(app.elements.get('playButton').disabled, false);
  assert.match(app.elements.get('sourceNote').textContent, /此浏览器无法捕获系统音频/);
});

test('switching visualization preserves an active capture', async () => {
  const shared = capture(), app = setup(async () => shared.stream);
  await app.play();
  const source = app.getSource();
  app.setView('frequency');
  assert.equal(app.state.view, 'frequency');
  assert.equal(app.state.playing, true);
  assert.equal(app.getSource(), source);
  assert.equal(app.captureCalls(), 1);
  assert.equal(shared.audio.stops, 0);
  assert.equal(shared.video.stops, 0);
  app.pause();
});

test('frequency smoothing defaults to 30 percent and each view retains its own adjustment', () => {
  const app = setup();
  app.setView('frequency');
  const slider = app.elements.get('smoothing');
  assert.equal(slider.value, 30);
  slider.value = '75'; slider.listeners.input({ target: slider });
  assert.equal(app.state.frequencySmoothing, .75);
  app.setView('trend');
  assert.equal(slider.value, 35);
  app.setView('frequency');
  assert.equal(slider.value, 75);
});

test('silent frequency rendering is a single centered line without candles or a dB tooltip', () => {
  const app = setup();
  app.setView('frequency');
  app.model.update(0, new Float32Array(8192).fill(-Infinity), 48000, 16384, .03, 4, .3);
  app.state.pointer = { x: 100, y: 100 };
  app.resizeCanvas();
  const g = app.geometry(), calls = app.elements.get('chartCanvas').getContext().calls;
  assert.ok(calls.some(c => c[0] === 'moveTo' && c[1] === g.left && c[2] === (g.top + g.bottom) / 2));
  assert.ok(calls.some(c => c[0] === 'lineTo' && c[1] === g.left + g.width && c[2] === (g.top + g.bottom) / 2));
  assert.equal(calls.filter(c => c[0] === 'fillRect').length, 0);
  assert.equal(app.elements.get('chartTooltip').hidden, true);
});

test('silence uses the two-second clock without flooding trend candles and stays at the chart bottom', async () => {
  const app = setup(async () => capture().stream);
  await app.play();
  const analyser = app.getAnalyser();
  analyser.getFloatTimeDomainData = data => data.fill(0);
  analyser.getFloatFrequencyData = data => data.fill(-Infinity);
  app.state.interval = 500;
  app.state.sampleAt = 10;
  app.frame(40);
  assert.equal(app.state.candles.length, 1);
  assert.equal(app.state.candles[0].close, 1000);
  for (let i = 1; i <= 25; i++) app.frame(40 + i * 40);
  assert.ok(app.state.candles.at(-1).close > KLineSignal.TREND_FLOOR);
  assert.ok(app.state.candles.at(-1).close < 1000);
  for (let i = 26; i <= 50; i++) app.frame(40 + i * 40);
  assert.equal(app.state.candles.at(-1).close, KLineSignal.TREND_FLOOR);
  assert.ok(app.state.candles.length <= 6);
  app.resizeCanvas();
  let g = app.geometry();
  assert.equal(g.y(KLineSignal.TREND_FLOOR), g.bottom);
  for (let i = 1; i < 300; i++) app.frame(2040 + i * 501);
  g = app.geometry();
  assert.ok(g.candles.every(c => c.close === KLineSignal.TREND_FLOOR));
  assert.equal(g.y(KLineSignal.TREND_FLOOR), g.bottom);
  assert.ok(g.high > g.low);
  app.pause();
});
