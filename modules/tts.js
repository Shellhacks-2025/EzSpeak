// Text-to-Speech engine with queue + optional output level.
const DEFAULT_VOICE_MAP = {
      'en-US': 'en-US-DavisNeural',
  'es-ES': 'es-ES-ArnauNeural',
  'fr-FR': 'fr-FR-HenriNeural', 'fr': 'fr-FR-HenriNeural',
  'de-DE': 'de-DE-ConradNeural', 'de': 'de-DE-ConradNeural'
};

/* Alternative voice options for testing (uncomment to try):

// English (US) alternatives:
// 'en-US': 'en-US-DavisNeural',      // Male, young adult
// 'en-US': 'en-US-JasonNeural',      // Male, adult
// 'en-US': 'en-US-TonyNeural',       // Male, older adult
// 'en-US': 'en-US-AriaNeural',       // Female, young adult
// 'en-US': 'en-US-JennyNeural',      // Female, assistant style
// 'en-US': 'en-US-MichelleNeural',   // Female, adult

// Spanish (Spain) alternatives:
// 'es-ES': 'es-ES-ArnauNeural',      // Male, young adult
// 'es-ES': 'es-ES-DarioNeural',      // Male, adult
// 'es-ES': 'es-ES-SaulNeural',       // Male, older adult
// 'es-ES': 'es-ES-ElviraNeural',     // Female, adult
// 'es-ES': 'es-ES-AbrilNeural',      // Female, young adult
// 'es-ES': 'es-ES-TrisaNeural',      // Female, older adult

// French (France) alternatives:
// 'fr-FR': 'fr-FR-AlainNeural',      // Male, adult
// 'fr-FR': 'fr-FR-ClaudeNeural',     // Male, older adult
// 'fr-FR': 'fr-FR-MauriceNeural',    // Male, senior
// 'fr-FR': 'fr-FR-DeniseNeural',     // Female, adult
// 'fr-FR': 'fr-FR-EloiseNeural',     // Female, young adult
// 'fr-FR': 'fr-FR-JacquelineNeural', // Female, older adult

// German (Germany) alternatives:
// 'de-DE': 'de-DE-KlausNeural',      // Male, adult
// 'de-DE': 'de-DE-RalfNeural',       // Male, older adult
// 'de-DE': 'de-DE-BerndNeural',      // Male, senior
// 'de-DE': 'de-DE-KatjaNeural',      // Female, adult
// 'de-DE': 'de-DE-AmalaNeural',      // Female, young adult
// 'de-DE': 'de-DE-GiselaNeural',     // Female, older adult

*/

export function createTTSEngine({ SpeechSDK, creds, targetLanguage, voiceMap = DEFAULT_VOICE_MAP, onState = () => {}, onLevel = null }) {
  if (!SpeechSDK) throw new Error('SpeechSDK missing');
  if (!targetLanguage) throw new Error('targetLanguage missing');

  let enabled = true, synthesizer = null, creating = null, currentLang = null;
  const queue = []; let speaking = false; let disposed = false;
  let audioCtx = null, gainNode = null, analyser = null, levelRaf = null, lastLevelEmit = 0;

  function voiceFor(lang) { return voiceMap[lang] || voiceMap[lang.split('-')[0]] || 'en-US-GuyNeural'; }

  function makeSpeechConfig(lang) {
    let cfg;
    if (creds.isToken && creds.token) cfg = SpeechSDK.SpeechConfig.fromAuthorizationToken(creds.token, creds.region);
    else if (creds.key && creds.region) cfg = SpeechSDK.SpeechConfig.fromSubscription(creds.key, creds.region);
    else throw new Error('Incomplete credentials');
    cfg.speechSynthesisLanguage = lang;
    cfg.speechSynthesisVoiceName = voiceFor(lang);
    try { cfg.setSpeechSynthesisOutputFormat(SpeechSDK.SpeechSynthesisOutputFormat.Riff16Khz16BitMonoPcm); } catch(_) {}
    return cfg;
  }

  function ensureSynth(lang) {
    if (disposed) return Promise.reject(new Error('disposed'));
    if (synthesizer && lang === currentLang) return Promise.resolve(synthesizer);
    if (creating) return creating;
    creating = new Promise((resolve, reject) => {
      try {
        currentLang = lang;
        const config = makeSpeechConfig(lang);
        if (synthesizer) { try { synthesizer.close(); } catch(_) {} }
        // Route synthesis to a non-speaker stream to avoid duplicate playback (we will play result.audioData ourselves)
        let audioConfig;
        try {
          const nullSink = SpeechSDK.AudioOutputStream.createPullStream();
          audioConfig = SpeechSDK.AudioConfig.fromAudioOutputStream(nullSink);
        } catch(_) {
          try {
            // Fallback for older SDK naming
            const nullSink = SpeechSDK.AudioOutputStream.createPullStream();
            audioConfig = SpeechSDK.AudioConfig.fromStreamOutput(nullSink);
          } catch(_) {
            audioConfig = undefined; // as a last resort
          }
        }
        synthesizer = new SpeechSDK.SpeechSynthesizer(config, audioConfig);
        creating = null; resolve(synthesizer);
      } catch(e) { creating = null; reject(e); }
    });
    return creating;
  }

  function emit(state, detail) { try { onState(state, detail); } catch(_) {} }

  function ensureAudioContext() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioCtx.createGain(); gainNode.gain.value = 1; gainNode.connect(audioCtx.destination);
    if (onLevel) { analyser = audioCtx.createAnalyser(); analyser.fftSize = 256; analyser.connect(gainNode); }
  }
  function setVolume(v) { ensureAudioContext(); if (gainNode) gainNode.gain.value = Math.min(1, Math.max(0, Number(v))); }

  async function playPcmWavBytes(bytes) {
    // Accept both ArrayBuffer and TypedArray views
    if (!bytes) return;
    const byteLength = bytes.byteLength !== undefined ? bytes.byteLength : (bytes.length !== undefined ? bytes.length : 0);
    if (!byteLength) return;
    ensureAudioContext(); try { await audioCtx.resume(); } catch(_) {}
    return new Promise(resolve => {
      let ab;
      try {
        if (bytes instanceof ArrayBuffer) {
          ab = bytes;
        } else if (ArrayBuffer.isView(bytes)) {
          ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        } else if (bytes.buffer && bytes.byteOffset !== undefined && bytes.byteLength !== undefined) {
          ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        } else {
          // Fallback: try to construct a Uint8Array and use its buffer
          const view = new Uint8Array(bytes);
          ab = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
        }
      } catch(_) { resolve(); return; }

      // decodeAudioData may require a copyable buffer in some browsers
      const bufToDecode = ab.slice(0);
      audioCtx.decodeAudioData(bufToDecode, buffer => {
        const src = audioCtx.createBufferSource(); src.buffer = buffer;
        if (analyser) {
          try {
            src.connect(analyser);
          } catch(_) { src.connect(gainNode); }
        } else {
          src.connect(gainNode);
        }
        src.onended = resolve; src.start();
        if (analyser && !levelRaf) startLevelLoop();
      }, () => resolve());
    });
  }

  function startLevelLoop() {
    if (!analyser || levelRaf) return;
    const data = new Uint8Array(analyser.fftSize);
    const loop = (ts) => {
      try {
        analyser.getByteTimeDomainData(data);
        let sum = 0; for (let i=0;i<data.length;i++){ const v = (data[i]-128)/128; sum += v*v; }
        const rms = Math.sqrt(sum / data.length);
        if (onLevel && ts - lastLevelEmit > 50) { lastLevelEmit = ts; try { onLevel(rms); } catch(_) {} }
      } catch(_) {}
      if (!disposed) levelRaf = requestAnimationFrame(loop);
    };
    levelRaf = requestAnimationFrame(loop);
  }
  function stopLevelLoop() { try { if (levelRaf) cancelAnimationFrame(levelRaf); } catch(_) {} levelRaf = null; }

  function dequeue() {
    if (speaking || !enabled || disposed) return;
    const item = queue.shift(); if (!item) { emit('idle'); return; }
    speaking = true; emit('synthesizing', { text: item.text });
    ensureSynth(item.lang).then(s => {
      s.speakTextAsync(item.text,
        async result => {
          try {
            if (result && result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted && result.audioData?.byteLength) {
              emit('decoding'); await playPcmWavBytes(result.audioData); emit('done');
            } else emit('error', new Error('Synthesis incomplete'));
          } finally { speaking = false; dequeue(); }
        },
        err => { emit('error', err); speaking = false; dequeue(); }
      );
    }).catch(err => { emit('error', err); speaking = false; dequeue(); });
  }

  function speak(text, lang = targetLanguage) {
    if (disposed || !enabled || !text || !text.trim()) return;
    const trimmed = text.trim();
    queue.push({ text: trimmed.length > 100 ? trimmed.slice(0, 100) : trimmed, lang });
    emit('queue', { size: queue.length });
    dequeue();
  }
  function setEnabled(val) { enabled = !!val; emit(enabled ? 'enabled' : 'disabled'); if (enabled) dequeue(); else queue.length = 0; }

  function dispose() {
    disposed = true; queue.length = 0; stopLevelLoop();
    try { if (synthesizer) synthesizer.close(); } catch(_) {}
    try { if (audioCtx) audioCtx.close(); } catch(_) {}
    synthesizer = null; audioCtx = null; gainNode = null; analyser = null; emit('disposed');
  }

  emit('enabled');
  return { speak, setEnabled, dispose, setVolume };
}
