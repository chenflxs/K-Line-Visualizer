'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const canvas = $('chartCanvas'), ctx = canvas.getContext('2d');
  const model = new KLineSignal.SignalModel();
  const tracks = [{ bpm: 112, root: 55 }];
  const demoBuffers = new Map();
  const state = {
    mode: 'speakers', view: new URLSearchParams(location.search).get('view') === 'frequency' ? 'frequency' : 'trend',
    track: 0, playing: false, loading: false, interval: 250, gain: 4, randomness: .8, smoothing: .35, frequencySmoothing: .3,
    offset: 0, startedAt: 0, duration: 0, volume: .65, candles: [], pointer: null,
    sampleAt: 0, lastFrame: 0, lastUi: 0, message: '', dirty: true
  };
  let audioContext, analyser, master, source, stream, frequencyData, timeData;
  let fileBuffer, fileName = '', operation = 0, toastTimer, chartWidth = 0, chartHeight = 0;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const formatTime = time => `${Math.floor(Math.max(0, time) / 60)}:${String(Math.floor(Math.max(0, time) % 60)).padStart(2, '0')}`;
  const formatHz = hz => hz >= 1000 ? `${Number((hz / 1000).toFixed(1))}k` : String(Math.round(hz));

  function toast(message) {
    $('toast').textContent = message; $('toast').classList.add('visible');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 4200);
  }
  function rangeProgress(input) { input.style.setProperty('--range-progress', `${(input.value - input.min) / (input.max - input.min) * 100}%`); }
  document.querySelectorAll('input[type=range]').forEach(rangeProgress);

  function initializeAudio() {
    if (audioContext) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('当前浏览器不支持 Web Audio。');
    audioContext = new AudioContextClass();
    analyser = audioContext.createAnalyser(); analyser.fftSize = 16384;
    analyser.smoothingTimeConstant = 0;
    master = audioContext.createGain(); master.gain.value = state.volume;
    analyser.connect(master); master.connect(audioContext.destination);
    frequencyData = new Float32Array(analyser.frequencyBinCount);
    timeData = new Float32Array(analyser.fftSize);
  }

  function createDemoBuffer(trackIndex) {
    if (demoBuffers.has(trackIndex)) return demoBuffers.get(trackIndex);
    const track = tracks[trackIndex], sampleRate = 22050;
    const buffer = audioContext.createBuffer(2, sampleRate * 64, sampleRate);
    const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
    const progression = [0, -3, 5, 2], melody = [12, 7, 10, 14, 12, 19, 17, 7];
    let random = 3281 + trackIndex;
    // Generate a small original loop locally: kick, bass, hats, chords and melody.
    for (let i = 0; i < left.length; i++) {
      const t = i / sampleRate, beat = t * track.bpm / 60, beatPhase = beat % 1;
      const chord = progression[Math.floor(beat / 8) % progression.length];
      const bassFrequency = track.root * 2 ** (chord / 12);
      const kickTime = beatPhase * 60 / track.bpm;
      const kick = Math.sin(2 * Math.PI * (46 * kickTime + 6 * (1 - Math.exp(-kickTime * 25)))) * Math.exp(-kickTime * 16) * .42;
      const bassEnvelope = Math.min(1, beatPhase * 35) * Math.exp(-beatPhase * 3.6);
      const bass = (Math.sin(2 * Math.PI * bassFrequency * t) + .15 * Math.sin(2 * Math.PI * bassFrequency * 2 * t)) * bassEnvelope * .2;
      random = (Math.imul(random, 1664525) + 1013904223) | 0;
      const noise = random / 2147483648;
      const hat = noise * Math.exp(-(beat * 2 % 1) * 38) * .045;
      const snare = Math.floor(beat) % 4 === 2 ? noise * Math.exp(-beatPhase * 22) * .075 : 0;
      let pad = 0;
      for (const note of [0, 3, 7]) pad += Math.sin(2 * Math.PI * bassFrequency * 2 ** ((note + 12) / 12) * t);
      pad *= .027 * (.6 + .4 * Math.sin(t * .43));
      const melodyFrequency = track.root * 2 ** ((chord + melody[Math.floor(beat * .5) % melody.length]) / 12);
      const melodySound = Math.sin(2 * Math.PI * melodyFrequency * t) * Math.sin(2 * Math.PI * .23 * t) * Math.exp(-(beat % 2) * 2) * .075;
      const fade = Math.min(1, t * 4, (64 - t) * 4);
      left[i] = (kick + bass + hat + snare + pad + melodySound) * fade;
      right[i] = (kick + bass + hat + snare + pad * .95 + melodySound * .8) * fade;
    }
    demoBuffers.set(trackIndex, buffer);
    return buffer;
  }


  function position() {
    if (!state.playing || !audioContext || state.mode === 'speakers') return state.offset;
    const elapsed = state.offset + audioContext.currentTime - state.startedAt;
    return state.mode === 'demo' ? elapsed % state.duration : Math.min(elapsed, state.duration);
  }
  function clearVisuals() {
    model.reset(); state.candles = []; state.sampleAt = 0; state.dirty = true;
    state.pointer = null; $('chartTooltip').hidden = true;
  }
  function stopSource() {
    operation++;
    if (source) {
      source.onended = null;
      if (typeof source.stop === 'function') { try { source.stop(); } catch (_) { /* Already ended. */ } }
      source.disconnect(); source = null;
    }
    if (stream) { stream.getTracks().forEach(track => { track.onended = null; track.stop(); }); stream = null; }
    state.playing = false; state.loading = false;
    updatePlayback(); updateReadout();
  }
  function updatePlayback() {
    const monitoring = state.mode === 'speakers';
    const label = state.loading ? (monitoring ? '连接中…' : '准备中…') : state.playing ? (monitoring ? '停止监控' : '暂停') : monitoring ? '连接扬声器' : '播放';
    $('playLabel').textContent = label; $('playButton').setAttribute('aria-label', label);
    $('playButton').disabled = state.loading; $('playButton').classList.toggle('is-playing', state.playing);
    $('playButton').querySelector('use').setAttribute('href', state.playing ? '#i-pause' : '#i-play');
    $('chartStatus').textContent = state.loading ? (monitoring ? '等待选择来源' : '正在读取音频') : state.playing ? '实时分析' : state.candles.length || model.spectrum.length ? '已暂停' : '待连接';
    $('statusDot').classList.toggle('live', state.playing);
    $('sourceNote').textContent = state.message;
    $('sourceNote').hidden = !state.message;
    $('mediaControls').hidden = monitoring;
    $('chooseFile').hidden = state.mode !== 'file';
    $('seek').disabled = state.loading || !state.duration;
    $('trackName').textContent = monitoring ? '扬声器 / 系统音频' : state.mode === 'demo' ? 'Midnight Market · 内置试听' : fileName || '尚未选择音频';
    $('trackName').hidden = monitoring;
    state.dirty = true;
  }
  async function play() {
    if (state.loading || state.playing) return;
    const token = ++operation;
    state.loading = true; state.message = ''; updatePlayback();
    try {
      initializeAudio();
      if (state.mode === 'speakers') {
        if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('此浏览器无法捕获系统音频，请使用支持音频共享的浏览器，通过 localhost 或 HTTPS 打开。');
        // Invoke before any await: screen sharing requires transient user activation.
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: 'monitor', frameRate: 1 },
          audio: { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          systemAudio: 'include', windowAudio: 'system', selfBrowserSurface: 'exclude'
        });
        if (token !== operation) { displayStream.getTracks().forEach(track => track.stop()); return; }
        stream = displayStream;
        if (!stream.getAudioTracks().length) throw new Error('未获取到共享音频，请重新选择来源并勾选共享音频。');
        await audioContext.resume(); if (token !== operation) return;
        source = audioContext.createMediaStreamSource(stream);
        // Never replay captured audio. Required video tracks are not displayed or recorded.
        analyser.disconnect(); source.connect(analyser);
        stream.getTracks().forEach(track => { track.onended = () => { pause(); state.message = '声音共享已结束，点击连接可重新开始。'; updatePlayback(); }; });
        clearVisuals();
      } else {
        await audioContext.resume(); if (token !== operation) return;
        const buffer = state.mode === 'demo' ? createDemoBuffer(0) : fileBuffer;
        if (!buffer) throw new Error('请先选择音频文件。');
        if (state.offset >= state.duration) { state.offset = 0; clearVisuals(); }
        analyser.disconnect(); analyser.connect(master);
        source = audioContext.createBufferSource(); source.buffer = buffer;
        source.loop = state.mode === 'demo'; source.connect(analyser); source.start(0, state.offset);
        source.onended = () => { if (token !== operation) return; state.offset = state.duration; stopSource(); };
      }
      state.startedAt = audioContext.currentTime; state.playing = true; state.sampleAt = 0;
    } catch (error) {
      if (token !== operation) return;
      stopSource();
      state.message = error.name === 'NotAllowedError' ? '共享已取消或未获许可，点击连接可重试。' : error.message || '音频连接失败，请重试。';
      toast(state.message);
    } finally {
      if (token === operation) state.loading = false;
      updatePlayback();
    }
  }
  function pause() {
    state.offset = position(); stopSource();
    audioContext?.suspend().catch(() => {});
  }
  function setSource(mode) {
    pause(); state.mode = mode; state.offset = 0; state.message = '';
    state.duration = mode === 'demo' ? 64 : mode === 'file' && fileBuffer ? fileBuffer.duration : 0;
    $('sourceSelect').value = mode; clearVisuals(); updatePlayback(); updateReadout();
  }
  async function loadFile(file) {
    if (!file) return;
    if (!file.type.startsWith('audio/') && !/\.(mp3|wav|ogg|flac|m4a|aac|opus|aiff|webm)$/i.test(file.name)) { toast('请选择音频文件。'); return; }
    if (file.size > 150 * 1024 * 1024) { toast('请选择小于 150 MB 的音频文件。'); return; }
    setSource('file'); const token = ++operation; state.loading = true; updatePlayback();
    try {
      initializeAudio(); const buffer = await audioContext.decodeAudioData(await file.arrayBuffer());
      if (token !== operation) return;
      fileBuffer = buffer; fileName = file.name; state.loading = false; setSource('file'); play();
    } catch (_) {
      if (token !== operation) return;
      state.loading = false; state.message = '无法解码此音频，请尝试 MP3 或 WAV。'; toast(state.message); updatePlayback();
    }
  }
  function setView(view, updateUrl = true) {
    state.view = view; state.pointer = null; $('chartTooltip').hidden = true;
    document.body.classList.toggle('frequency-mode', view === 'frequency');
    ['trend', 'frequency'].forEach(name => { $(`${name}View`).classList.toggle('selected', name === view); $(`${name}View`).setAttribute('aria-pressed', String(name === view)); });
    $('chartTitle').textContent = view === 'frequency' ? '频响 K 线' : '声音走势';
    $('axisDescription').textContent = view === 'frequency' ? '100 Hz — 16 kHz' : '时间 / 声音指数';
    $('chartCanvas').setAttribute('aria-label', view === 'frequency' ? '低频加密、相邻开收连续衔接的相对频响 K 线曲线' : '低响度增强的随机音频 K 线走势');
    $('intervalLabel').textContent = '采样周期';
    $('interval').setAttribute('aria-label', '采样周期');
    const smoothing = view === 'frequency' ? state.frequencySmoothing : state.smoothing;
    $('smoothing').value = Math.round(smoothing * 100); $('smoothingOutput').textContent = `${Math.round(smoothing * 100)}%`; rangeProgress($('smoothing'));
    if (updateUrl) history.replaceState(null, '', `${location.pathname}${view === 'frequency' ? '?view=frequency' : ''}`);
    updateReadout();
    state.dirty = true;
  }
  function analyze(dt) {
    analyser.getFloatFrequencyData(frequencyData); analyser.getFloatTimeDomainData(timeData);
    let power = 0; for (const sample of timeData) power += sample * sample;
    model.update(Math.sqrt(power / timeData.length), frequencyData, audioContext.sampleRate, analyser.fftSize, dt, state.gain, state.frequencySmoothing);
  }
  function sampleCandle() {
    const time = state.mode === 'speakers' ? audioContext.currentTime - state.startedAt : position();
    state.candles.push(model.sample(time, state.gain, state.randomness, state.smoothing));
    if (state.candles.length > 220) state.candles.shift();
  }
  function resizeCanvas() {
    const bounds = $('canvasWrap').getBoundingClientRect(); chartWidth = bounds.width; chartHeight = bounds.height;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(chartWidth * ratio); canvas.height = Math.round(chartHeight * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); drawChart(); state.dirty = false;
  }
  function geometry() {
    const left = 16, right = chartWidth < 450 ? 41 : 55, top = 15, bottom = chartHeight - 32;
    const width = chartWidth - left - right, height = bottom - top;
    const frequency = state.view === 'frequency';
    const count = frequency ? KLineSignal.BAND_COUNT : Math.max(18, Math.floor(width / (chartWidth < 500 ? 7 : 11)));
    const candles = frequency ? model.spectrum : state.candles.slice(-count);
    let low = KLineSignal.SPECTRUM_FLOOR, high = frequency ? 3 : 0;
    if (!frequency) {
      low = candles.length ? Math.min(...candles.map(c => c.low)) : 950;
      high = candles.length ? Math.max(...candles.map(c => c.high)) : 1050;
      if (model.silenceStartPrice !== null && candles.length) low = Math.min(low, KLineSignal.TREND_FLOOR);
      const pad = Math.max(20, (high - low) * .18);
      low = low <= KLineSignal.TREND_FLOOR ? KLineSignal.TREND_FLOOR : low - pad;
      high = Math.max(high + pad, low + 100);
    }
    const spacing = width / count, offset = frequency ? 0 : count - candles.length;
    const x = i => left + (offset + i + .5) * spacing;
    const y = value => top + (high - value) / (high - low) * height;
    return { left, right, top, bottom, width, height, low, high, count, candles, spacing, offset, x, y, frequency };
  }
  function drawChart() {
    if (!chartWidth || !chartHeight) return;
    const g = geometry(); ctx.clearRect(0, 0, chartWidth, chartHeight);
    ctx.lineWidth = 1; ctx.font = '9px Consolas, monospace'; ctx.textAlign = 'left';
    for (let i = 0; i <= 5; i++) {
      const value = g.high - (g.high - g.low) * i / 5, y = g.y(value);
      ctx.strokeStyle = '#26314080'; ctx.beginPath(); ctx.moveTo(g.left, Math.round(y) + .5); ctx.lineTo(chartWidth - g.right, Math.round(y) + .5); ctx.stroke();
      ctx.fillStyle = '#8390a2'; ctx.fillText(value.toFixed(0), chartWidth - g.right + 9, y + 3);
    }
    if (g.frequency) {
      const maximum = model.bands.at(-1)?.highHz || KLineSignal.MAX_HZ;
      const ticks = chartWidth < 500 ? [100, 250, 500, 2000, 8000, 16000] : [100, 150, 250, 500, 1000, 2000, 4000, 8000, 16000];
      for (const hz of ticks) {
        if (hz > maximum + 1) continue;
        const x = g.left + KLineSignal.frequencyPosition(hz, maximum) * g.width;
        gridColumn(x, g); ctx.fillStyle = '#8390a2'; ctx.textAlign = hz === KLineSignal.MIN_HZ ? 'left' : hz === KLineSignal.MAX_HZ ? 'right' : 'center'; ctx.fillText(formatHz(hz), x, chartHeight - 9);
      }
      ctx.textAlign = 'left'; ctx.fillStyle = '#8390a2'; ctx.fillText('ΔdB', chartWidth - g.right + 4, chartHeight - 9);
      if (model.spectrumSilent) {
        // This is a visual rest position, not a measured dB value.
        const centerY = (g.top + g.bottom) / 2;
        ctx.strokeStyle = '#82aaff'; ctx.lineWidth = 1.2; ctx.beginPath();
        ctx.moveTo(g.left, centerY); ctx.lineTo(chartWidth - g.right, centerY); ctx.stroke();
      } else if (g.candles.length) {
        ctx.strokeStyle = '#82aaff60'; ctx.lineWidth = 1.2; ctx.beginPath();
        g.candles.forEach((c, i) => { i ? ctx.lineTo(g.x(i), g.y(c.close)) : ctx.moveTo(g.x(i), g.y(c.close)); }); ctx.stroke();
      }
    } else {
      for (let i = 0; i <= 6; i++) {
        const x = g.left + g.width * i / 6; gridColumn(x, g);
        const index = Math.round(g.count * i / 6) - g.offset;
        if (index >= 0 && index < g.candles.length) { ctx.fillStyle = '#8390a2'; ctx.fillText(formatTime(g.candles[index].time), x, chartHeight - 9); }
      }
    }
    ctx.lineWidth = 1;
    const centeredSilence = g.frequency && model.spectrumSilent;
    (centeredSilence ? [] : g.candles).forEach((candle, i) => {
      const x = g.x(i), color = candle.close >= candle.open ? '#32c8a0' : '#ef7484';
      ctx.strokeStyle = color; ctx.fillStyle = color;
      const wick = g.frequency ? KLineSignal.spectrumWick(candle) : candle;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, g.y(wick.high)); ctx.lineTo(Math.round(x) + .5, g.y(wick.low)); ctx.stroke();
      const width = Math.max(g.frequency ? .6 : 2, g.frequency ? g.spacing * .65 : Math.round(g.spacing * .57));
      ctx.fillRect(Math.round(x - width / 2), g.y(Math.max(candle.open, candle.close)), width, Math.max(1.5, Math.abs(g.y(candle.open) - g.y(candle.close))));
    });
    if (!g.frequency && g.candles.length) {
      const last = g.candles.at(-1), y = g.y(last.close), color = last.close >= last.open ? '#32c8a0' : '#ef7484';
      ctx.strokeStyle = color + '60'; ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.moveTo(g.left, y); ctx.lineTo(chartWidth - g.right, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.fillRect(chartWidth - g.right + 3, y - 9, g.right - 7, 18); ctx.fillStyle = '#0d1117'; ctx.fillText(last.close.toFixed(0), chartWidth - g.right + 9, y + 3);
    }
    if (!g.candles.length) {
      ctx.textAlign = 'center'; ctx.fillStyle = '#8390a2'; ctx.font = `${chartWidth < 450 ? 10 : 12}px "Microsoft YaHei",sans-serif`;
      ctx.fillText('等待音频', g.left + g.width / 2, g.top + g.height / 2); ctx.textAlign = 'left';
    }
    if (centeredSilence) $('chartTooltip').hidden = true;
    else if (state.pointer) drawCrosshair(g);
  }
  function gridColumn(x, g) {
    ctx.strokeStyle = '#26314055'; ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, g.top); ctx.lineTo(Math.round(x) + .5, g.bottom); ctx.stroke();
  }
  function drawCrosshair(g) {
    const index = Math.floor((state.pointer.x - g.left) / g.spacing) - g.offset;
    if (index < 0 || index >= g.candles.length || state.pointer.y < g.top || state.pointer.y > g.bottom) { $('chartTooltip').hidden = true; return; }
    const candle = g.candles[index], x = g.x(index);
    ctx.strokeStyle = '#a9b8cf70'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(x, g.top); ctx.lineTo(x, g.bottom); ctx.moveTo(g.left, state.pointer.y); ctx.lineTo(chartWidth - g.right, state.pointer.y); ctx.stroke(); ctx.setLineDash([]);
    const tip = $('chartTooltip');
    tip.textContent = g.frequency ? `${formatHz(candle.frequency)} Hz · 开 ${candle.open.toFixed(1)} / 高 ${candle.high.toFixed(1)} / 低 ${candle.low.toFixed(1)} / 收 ${candle.close.toFixed(1)} dB` : `${formatTime(candle.time)} · 开 ${candle.open.toFixed(1)} / 收 ${candle.close.toFixed(1)}`;
    tip.hidden = false; tip.style.left = `${clamp(x - tip.offsetWidth / 2, 4, chartWidth - tip.offsetWidth - 4)}px`; tip.style.top = `${Math.max(4, state.pointer.y - tip.offsetHeight - 12)}px`;
  }
  function updateReadout() {
    $('levelValue').textContent = state.view === 'frequency' ? '相对 dB' : model.rms > 0 ? `${model.levelDb.toFixed(1)} dBFS` : '— dBFS';
    $('currentTime').textContent = formatTime(position()); $('duration').textContent = formatTime(state.duration);
    $('seek').value = state.duration ? position() / state.duration * 100 : 0; rangeProgress($('seek'));
  }
  function frame(now) {
    if (now - state.lastFrame >= 30) {
      const dt = (now - state.lastFrame) / 1000; state.lastFrame = now;
      if (state.playing) {
        const wasSilent = model.silenceStartPrice !== null;
        analyze(dt);
        const silenceBoundary = model.silenceStartPrice !== null && (!wasSilent ||
          model.silenceElapsed >= KLineSignal.SILENCE_FALL_SECONDS && model.price > KLineSignal.TREND_FLOOR);
        if (silenceBoundary || now - state.sampleAt >= state.interval) { sampleCandle(); state.sampleAt = now; }
        state.dirty = true;
        if (now - state.lastUi >= 160) { updateReadout(); state.lastUi = now; }
      }
      if (state.dirty) { drawChart(); state.dirty = false; }
    }
    requestAnimationFrame(frame);
  }

  $('playButton').addEventListener('click', () => state.playing ? pause() : play());
  $('sourceSelect').addEventListener('change', event => setSource(event.target.value));
  $('chooseFile').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', event => { loadFile(event.target.files[0]); event.target.value = ''; });
  ['trend', 'frequency'].forEach(name => $(`${name}View`).addEventListener('click', () => setView(name)));
  $('gain').addEventListener('input', event => { state.gain = Number(event.target.value); $('gainOutput').textContent = `${state.gain.toFixed(1)}×`; rangeProgress(event.target); });
  $('randomness').addEventListener('input', event => { state.randomness = Number(event.target.value) / 100; $('randomOutput').textContent = `${event.target.value}%`; rangeProgress(event.target); });
  $('smoothing').addEventListener('input', event => {
    const value = Number(event.target.value) / 100;
    if (state.view === 'frequency') state.frequencySmoothing = value; else state.smoothing = value;
    $('smoothingOutput').textContent = `${event.target.value}%`; rangeProgress(event.target);
  });
  $('interval').addEventListener('change', event => { state.interval = Number(event.target.value); });
  $('volume').addEventListener('input', event => { state.volume = Number(event.target.value) / 100; if (master) master.gain.setTargetAtTime(state.volume, audioContext.currentTime, .02); rangeProgress(event.target); });
  $('seek').addEventListener('input', event => { const resume = state.playing; pause(); state.offset = state.duration * Number(event.target.value) / 100; updateReadout(); if (resume) play(); });
  document.addEventListener('dragover', event => { event.preventDefault(); document.body.classList.add('drag-over'); });
  document.addEventListener('dragleave', event => { if (!event.relatedTarget) document.body.classList.remove('drag-over'); });
  document.addEventListener('drop', event => { event.preventDefault(); document.body.classList.remove('drag-over'); loadFile(event.dataTransfer.files[0]); });
  canvas.addEventListener('pointermove', event => { const rect = canvas.getBoundingClientRect(); state.pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top }; state.dirty = true; });
  canvas.addEventListener('pointerleave', () => { state.pointer = null; $('chartTooltip').hidden = true; state.dirty = true; });
  $('fullscreenButton').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else if ($('studio').requestFullscreen) await $('studio').requestFullscreen(); else toast('此浏览器不支持全屏。'); } catch (_) { toast('无法进入全屏，请重试。'); } });
  document.addEventListener('keydown', event => { if (event.code !== 'Space' || event.repeat || /INPUT|BUTTON|SELECT|TEXTAREA/.test(event.target.tagName) || event.target.isContentEditable) return; event.preventDefault(); state.playing ? pause() : play(); });
  window.addEventListener('pagehide', stopSource);
  new ResizeObserver(resizeCanvas).observe($('canvasWrap'));
  setSource('speakers'); setView(state.view, false);
  requestAnimationFrame(frame);
})();
