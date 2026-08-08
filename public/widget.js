/**
 * Ask CII — embeddable popup widget.
 *
 * Drop-in on any page:
 *   <script src="https://YOUR-WORKER.workers.dev/widget.js" defer></script>
 *
 * Optional attributes on the script tag:
 *   data-endpoint="https://YOUR-WORKER.workers.dev"  (defaults to script origin)
 *   data-launcher="false"       hide the floating "Ask CII" button
 *   data-auto-open="true"       open the popup on page load
 *
 * Programmatic API: window.AskCII.open() / .close() / .ask("question")
 */
(() => {
  if (window.AskCII) return;

  const script = document.currentScript;
  const ENDPOINT = (script?.dataset?.endpoint || (script?.src ? new URL(script.src).origin : '')).replace(/\/$/, '');
  const SHOW_LAUNCHER = script?.dataset?.launcher !== 'false';
  const AUTO_OPEN = script?.dataset?.autoOpen === 'true';

  /* ------------------------------- icons ---------------------------------- */
  const I = {
    spark: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1.8l2.3 7 7.2 2.4-7.2 2.4-2.3 7.6-2.3-7.6L2.5 11.2l7.2-2.4z"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3.5"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    chev: '<svg class="acii-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
    back: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6.5 9H3v6h3.5L11 19zM15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    enter: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px"><path d="M20 5v6a3 3 0 01-3 3H5M9 10l-4 4 4 4"/></svg>',
  };

  /* ------------------------------- state ----------------------------------- */
  let overlay = null;
  let suggestions = null;
  let questionsShown = 3;
  let lastAnswer = null;
  let audioEl = null;
  let recorder = null;
  let recChunks = [];
  let busy = false;

  const $ = (sel, root) => (root || overlay).querySelector(sel);

  /* ------------------------------ scaffold ---------------------------------- */
  function ensureStyles() {
    if (document.querySelector('link[data-acii]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${ENDPOINT}/widget.css`;
    link.dataset.acii = '1';
    document.head.appendChild(link);
  }

  function build() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'acii-overlay';
    overlay.innerHTML = `
      <div class="acii-modal" role="dialog" aria-modal="true" aria-label="Ask CII">
        <div class="acii-head">
          <span class="acii-spark">${I.spark}</span>
          <input class="acii-input" type="text" autocomplete="off" spellcheck="false"
                 placeholder="Ask CII anything — or search sectors, reports, offices, people..." aria-label="Ask CII" />
          <button class="acii-iconbtn acii-mic" title="Ask by voice" aria-label="Ask by voice">${I.mic}</button>
          <button class="acii-iconbtn acii-close" title="Close" aria-label="Close">${I.x}</button>
        </div>
        <div class="acii-body"></div>
        <div class="acii-foot">
          <span class="acii-keys"><span>${I.enter} <b>open</b></span><span><b>esc</b> close</span></span>
          <span>CII intelligent search</span>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    $('.acii-close').addEventListener('click', close);
    $('.acii-mic').addEventListener('click', toggleRecording);
    const input = $('.acii-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) ask(input.value.trim());
    });
    loadSuggestions();
  }

  /* ---------------------------- suggestions --------------------------------- */
  async function loadSuggestions() {
    try {
      const res = await fetch(`${ENDPOINT}/api/suggestions`);
      suggestions = await res.json();
    } catch {
      suggestions = { tryAsking: [], commonQuestions: [], quickActions: [] };
    }
    if (suggestions.placeholder) $('.acii-input').placeholder = suggestions.placeholder;
    renderHome();
  }

  /* -------------------------------- views ----------------------------------- */
  function renderHome() {
    if (!overlay || !suggestions) return;
    const body = $('.acii-body');
    const qs = suggestions.commonQuestions || [];
    body.innerHTML = `
      ${(suggestions.tryAsking || []).length ? `
        <div class="acii-label">Try asking</div>
        <div class="acii-chips">
          ${suggestions.tryAsking.map((t) => `<button class="acii-chip">${esc(t)}</button>`).join('')}
        </div>` : ''}
      ${qs.length ? `
        <div class="acii-label">Common questions</div>
        <div class="acii-qlist">
          ${qs.slice(0, questionsShown).map((t) => `<button class="acii-qrow"><span>${esc(t)}</span>${I.chev}</button>`).join('')}
        </div>
        ${questionsShown < qs.length ? '<button class="acii-more">Load more</button>' : ''}` : ''}
      ${(suggestions.quickActions || []).length ? `
        <div class="acii-label">Quick actions</div>
        <div class="acii-cards">
          ${suggestions.quickActions.map((a) => `
            <button class="acii-card" data-q="${esc(a.question || a.title)}" data-url="${esc(a.url || '')}">
              <h4>${esc(a.title)}</h4><p>${esc(a.subtitle || '')}</p>
            </button>`).join('')}
        </div>` : ''}`;

    body.querySelectorAll('.acii-chip, .acii-qrow').forEach((el) =>
      el.addEventListener('click', () => ask(el.textContent.trim())));
    const more = body.querySelector('.acii-more');
    if (more) more.addEventListener('click', () => { questionsShown = qs.length; renderHome(); });
    body.querySelectorAll('.acii-card').forEach((el) =>
      el.addEventListener('click', () => (el.dataset.url ? window.open(el.dataset.url, '_blank') : ask(el.dataset.q))));
  }

  function renderThinking(q, note) {
    const body = $('.acii-body');
    body.innerHTML = `
      <div class="acii-status"><span class="acii-dots"><i></i><i></i><i></i></span> ${esc(note || 'Searching cii.in…')}</div>
      <div class="acii-skel" style="width:92%"></div>
      <div class="acii-skel" style="width:84%"></div>
      <div class="acii-skel" style="width:64%"></div>`;
  }

  function renderError(msg) {
    const body = $('.acii-body');
    body.innerHTML = `
      <button class="acii-back">${I.back} Back</button>
      <div class="acii-error">${esc(msg)}</div>`;
    $('.acii-back').addEventListener('click', goHome);
  }

  function renderAnswer(q, data, { voice } = {}) {
    lastAnswer = data;
    const body = $('.acii-body');
    const buttons = [
      { ...data.link, primary: true },
      ...(data.actions || []).filter((a) => a.url !== data.link?.url),
    ].filter((b) => b && b.url).slice(0, 3);

    body.innerHTML = `
      <button class="acii-back">${I.back} Back</button>
      <div>
        <span class="acii-badge">${I.spark} AI-generated · verify with sources below</span>
      </div>
      <p class="acii-summary">${esc(data.summary || '')}</p>
      <button class="acii-listen" title="Hear this answer">${I.speaker} <span>Listen to this answer</span></button>
      ${(data.sources || []).length ? `
        <div class="acii-label">Sources</div>
        <div>
          ${data.sources.map((s) => `
            <button class="acii-src" data-url="${esc(s.url)}">
              <span class="acii-srctype">${esc(s.type || 'PAGE')}</span>
              <span class="acii-srctitle">${esc(s.title)}</span>
              <span class="acii-srchost">${esc(s.label || hostOf(s.url))}</span>
            </button>`).join('')}
        </div>` : ''}
      ${buttons.length ? `
        <div class="acii-actions">
          ${buttons.map((b) => `
            <button class="acii-btn ${b.primary ? 'acii-btn-primary' : 'acii-btn-secondary'}" data-url="${esc(b.url)}">
              ${esc(b.label)}
            </button>`).join('')}
        </div>` : ''}`;

    $('.acii-back').addEventListener('click', goHome);
    body.querySelectorAll('.acii-src, .acii-btn').forEach((el) =>
      el.addEventListener('click', () => window.open(el.dataset.url, '_blank', 'noopener')));
    const listen = body.querySelector('.acii-listen');
    listen.addEventListener('click', () => playAnswer(listen));
    // The user asked by voice — surface the audio option prominently and
    // start speaking right away (the mic tap counts as the user gesture).
    if (voice && data.summary) playAnswer(listen);
  }

  function goHome() {
    stopAudio();
    const input = $('.acii-input');
    input.value = '';
    input.focus();
    renderHome();
  }

  /* --------------------------------- ask ------------------------------------ */
  async function ask(q, { voice = false } = {}) {
    if (busy || !q) return;
    busy = true;
    stopAudio();
    open();
    const input = $('.acii-input');
    input.value = q;
    renderThinking(q);
    try {
      const res = await fetch(`${ENDPOINT}/api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, voice }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
      renderAnswer(q, data, { voice });
    } catch (e) {
      renderError(`Couldn't get an answer: ${e.message}. Please try again.`);
    } finally {
      busy = false;
    }
  }

  /* -------------------------------- voice ----------------------------------- */
  async function toggleRecording() {
    const micBtn = $('.acii-mic');
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
      return;
    }
    stopAudio();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      renderError('Microphone access was blocked. Allow the microphone in your browser settings to ask by voice.');
      return;
    }
    recChunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = async () => {
      micBtn.classList.remove('acii-rec');
      micBtn.innerHTML = I.mic;
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
      recorder = null;
      if (blob.size < 2000) return; // too short to be speech
      renderThinking('', 'Transcribing your question…');
      try {
        const form = new FormData();
        form.append('audio', blob, 'question.webm');
        const res = await fetch(`${ENDPOINT}/api/transcribe`, { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok || data.error || !data.text) throw new Error(data.error || 'No speech detected');
        ask(data.text, { voice: true });
      } catch (e) {
        renderError(`Couldn't understand the recording: ${e.message}. Please try again.`);
      }
    };
    recorder.start();
    micBtn.classList.add('acii-rec');
    micBtn.innerHTML = I.stop;
    const input = $('.acii-input');
    input.value = '';
    input.placeholder = 'Listening… tap the mic again to finish';
    $('.acii-body').innerHTML = `
      <div class="acii-status"><span class="acii-dots"><i></i><i></i><i></i></span>
      Listening — ask in English, हिंदी, Hinglish or ਪੰਜਾਬੀ…</div>`;
  }

  async function playAnswer(btn) {
    if (!lastAnswer?.summary) return;
    if (audioEl && !audioEl.paused) { stopAudio(); return; }
    const label = btn.querySelector('span');
    btn.disabled = true;
    label.textContent = 'Preparing audio…';
    try {
      const res = await fetch(`${ENDPOINT}/api/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: lastAnswer.summary, langName: lastAnswer.langName }),
      });
      if (!res.ok) throw new Error(`TTS failed (${res.status})`);
      const blob = await res.blob();
      audioEl = new Audio(URL.createObjectURL(blob));
      audioEl.onended = audioEl.onpause = () => {
        btn.innerHTML = `${I.speaker} <span>Listen to this answer</span>`;
        btn.disabled = false;
      };
      await audioEl.play();
      btn.disabled = false;
      btn.innerHTML = `${I.pause} <span>Stop audio</span>`;
    } catch {
      btn.disabled = false;
      btn.innerHTML = `${I.speaker} <span>Listen to this answer</span>`;
    }
  }

  function stopAudio() {
    if (audioEl) { audioEl.pause(); audioEl = null; }
  }

  /* ------------------------------ open/close -------------------------------- */
  function open() {
    ensureStyles();
    build();
    if (!overlay.classList.contains('acii-open')) {
      overlay.style.display = 'flex';
      requestAnimationFrame(() => overlay.classList.add('acii-open'));
      $('.acii-input').focus();
    }
  }

  function close() {
    if (!overlay) return;
    stopAudio();
    if (recorder?.state === 'recording') recorder.stop();
    overlay.classList.remove('acii-open');
    setTimeout(() => { if (overlay) overlay.style.display = 'none'; }, 180);
  }

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); }
    else if (e.key === 'Escape') close();
  });

  if (SHOW_LAUNCHER) {
    const onReady = () => {
      ensureStyles();
      const b = document.createElement('button');
      b.className = 'acii-launcher';
      b.innerHTML = `${I.spark} Ask CII`;
      b.addEventListener('click', open);
      document.body.appendChild(b);
      if (AUTO_OPEN) open();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
    else onReady();
  }

  /* -------------------------------- utils ----------------------------------- */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  window.AskCII = { open, close, ask: (q) => ask(q) };
})();
