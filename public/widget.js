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
    down: '<svg class="acii-srcchev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    back: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6.5 9H3v6h3.5L11 19zM15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    enter: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px"><path d="M20 5v6a3 3 0 01-3 3H5M9 10l-4 4 4 4"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg>',
    // guided-flow persona icons
    building: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10.5 21v-3h3v3"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 19h16M5 15l4-4 3 3 6-6"/><path d="M14 8h4v4"/></svg>',
    rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15c-1-3 0-7.5 4.5-10.5 1.5 4-1 9-4.5 10.5z"/><path d="M12 15l-3-3M9 12c-2 0-3.5 1-4.5 3.5C6.5 15 8 15 9 15m3 0c0 2-1 3.5-3.5 4.5.5-2 .5-3.5.5-4.5"/><circle cx="14.5" cy="8.5" r="1"/></svg>',
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3.5 19c.7-3 3-4.5 5.5-4.5s4.8 1.5 5.5 4.5"/><circle cx="16.5" cy="9.5" r="2.2"/><path d="M16 14.6c2 .2 3.8 1.5 4.4 3.9"/></svg>',
    cap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 9.5L12 5l9.5 4.5L12 14 2.5 9.5z"/><path d="M6.5 11.5v4.2c0 1 2.5 2.3 5.5 2.3s5.5-1.3 5.5-2.3v-4.2M21 10v5"/></svg>',
    org: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9.5" y="3" width="5" height="5" rx="1"/><rect x="3" y="16" width="5" height="5" rx="1"/><rect x="16" y="16" width="5" height="5" rx="1"/><path d="M12 8v4M12 12H5.5v4M12 12h6.5v4"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.3 3.8 5.2 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.2-3.8-8.5s1.3-6.2 3.8-8.5z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20s-7.5-4.6-9.3-9.3C1.5 7.5 3.6 4.5 6.8 4.5c2 0 3.7 1.2 5.2 3 1.5-1.8 3.2-3 5.2-3 3.2 0 5.3 3 4.1 6.2C19.5 15.4 12 20 12 20z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.5l5 5 10-11"/></svg>',
  };

  /* ------------------------------- state ----------------------------------- */
  let overlay = null;
  let suggestions = null;
  let questionsShown = 4;
  let lastAnswer = null;
  let audioEl = null;
  let recorder = null;
  let recChunks = [];
  let recCancelled = false;
  let busy = false;
  let profile = {}; // guided-flow selections
  const HIST_KEY = 'acii_history';
  const history = {
    all: () => { try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch { return []; } },
    add: (q) => {
      try {
        const list = [q, ...history.all().filter((x) => x !== q)].slice(0, 10);
        localStorage.setItem(HIST_KEY, JSON.stringify(list));
      } catch { /* private mode */ }
    },
    clear: () => { try { localStorage.removeItem(HIST_KEY); } catch {} },
  };

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
          <form class="acii-form" action="#">
            <input class="acii-input" type="search" autocomplete="off" spellcheck="false"
                   autocapitalize="off" autocorrect="off" enterkeyhint="search"
                   placeholder="Ask CII anything — or search sectors, reports, offices, people..." aria-label="Ask CII" />
          </form>
          <button class="acii-iconbtn acii-go" title="Ask" aria-label="Ask" hidden>${I.arrow}</button>
          <button class="acii-iconbtn acii-mic" title="Ask by voice" aria-label="Ask by voice">${I.mic}</button>
          <button class="acii-iconbtn acii-close" title="Close" aria-label="Close">${I.x}</button>
        </div>
        <div class="acii-body">
          <div class="acii-skel" style="width:38%;margin-top:26px"></div>
          <div class="acii-skel" style="width:88%"></div>
          <div class="acii-skel" style="width:70%"></div>
        </div>
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
    // A real <form> makes mobile keyboards show "search/go" and submit
    // reliably (some Android IMEs never emit a usable Enter keydown).
    $('.acii-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (input.value.trim()) { input.blur(); ask(input.value.trim()); }
    });
    const goBtn = $('.acii-go');
    goBtn.addEventListener('click', () => { if (input.value.trim()) ask(input.value.trim()); });
    input.addEventListener('input', () => { goBtn.hidden = !input.value.trim(); });
    loadSuggestions();
  }

  /** Swap body content with a quick fade/rise transition. */
  function setBody(html, { roomy = false } = {}) {
    // Guided steps get a wider, fixed-height canvas so the modal never jumps
    // between steps and choices have space to breathe.
    $('.acii-modal').classList.toggle('acii-roomy', roomy);
    const body = $('.acii-body');
    body.innerHTML = `<div class="acii-view">${html}</div>`;
    return body;
  }

  /* ---------------------------- suggestions --------------------------------- */
  async function loadSuggestions() {
    try {
      // Send the host page's path+title so suggestions can match the page the
      // visitor is on (membership page -> membership question first, etc.).
      const pageCtx = encodeURIComponent(`${location.pathname} ${document.title}`.slice(0, 200));
      const res = await fetch(`${ENDPOINT}/api/suggestions?page=${pageCtx}`);
      suggestions = await res.json();
    } catch {
      suggestions = { questions: [] };
    }
    if (suggestions.placeholder) $('.acii-input').placeholder = suggestions.placeholder;
    renderHome();
  }

  /* -------------------------------- views ----------------------------------- */
  function renderHome() {
    if (!overlay || !suggestions) return;
    setListening(false);
    const qs = suggestions.questions
      || [...(suggestions.tryAsking || []), ...(suggestions.commonQuestions || [])];
    const g = suggestions.guided;
    const body = setBody(`
      ${g ? `
        <button class="acii-guide">
          <span class="acii-guide-orb"></span>
          <span class="acii-guide-txt">
            <b>${esc(g.title)}</b>
            <small>${esc(g.subtitle)}</small>
          </span>
          ${I.chev}
        </button>` : ''}
      ${history.all().length ? `
        <div class="acii-label" style="display:flex;justify-content:space-between;align-items:center">Your recent questions
          <button class="acii-histclear">Clear</button></div>
        <div>
          ${history.all().slice(0, 3).map((t) => `<button class="acii-qrow acii-recent"><span>${esc(t)}</span>${I.chev}</button>`).join('')}
        </div>` : ''}
      ${qs.length ? `
        <div class="acii-label">Ask anything</div>
        <div class="acii-qlist">
          ${qs.slice(0, questionsShown).map((t) => `<button class="acii-qrow"><span>${esc(t)}</span>${I.chev}</button>`).join('')}
        </div>
        ${questionsShown < qs.length ? '<button class="acii-more">Show more questions</button>' : ''}` : ''}`);

    body.querySelector('.acii-guide')?.addEventListener('click', () => renderGuided(0));
    body.querySelector('.acii-histclear')?.addEventListener('click', (e) => { e.stopPropagation(); history.clear(); renderHome(); });
    body.querySelectorAll('.acii-qrow').forEach((el) =>
      el.addEventListener('click', () => ask(el.textContent.trim())));
    const more = body.querySelector('.acii-more');
    if (more) more.addEventListener('click', () => { questionsShown = qs.length; renderHome(); });
  }

  const THINKING_STEPS = ['Searching cii.in…', 'Reading the best sources…', 'Writing your answer…'];
  let thinkTimer = null;

  function renderThinking(note) {
    const body = setBody(`
      <div class="acii-think">
        <span class="acii-orb acii-orb-sm"></span>
        <span class="acii-think-txt">${esc(note || THINKING_STEPS[0])}</span>
      </div>
      <div class="acii-skel" style="width:92%"></div>
      <div class="acii-skel" style="width:84%"></div>
      <div class="acii-skel" style="width:64%"></div>`);
    clearInterval(thinkTimer);
    if (!note) {
      let i = 0;
      thinkTimer = setInterval(() => {
        i = Math.min(i + 1, THINKING_STEPS.length - 1);
        const el = body.querySelector('.acii-think-txt');
        if (el) { el.textContent = THINKING_STEPS[i]; el.classList.remove('acii-fadein'); void el.offsetWidth; el.classList.add('acii-fadein'); }
        if (i === THINKING_STEPS.length - 1) clearInterval(thinkTimer);
      }, 2400);
    }
  }

  function renderError(msg) {
    setListening(false);
    const body = setBody(`
      <button class="acii-back">${I.back} Back</button>
      <div class="acii-error">${esc(msg)}</div>`);
    body.querySelector('.acii-back').addEventListener('click', goHome);
  }

  function renderAnswer(q, data, { voice = false, pathway = false } = {}) {
    clearInterval(thinkTimer);
    lastAnswer = data;
    // Max two CTAs: one primary (the best link) + one secondary.
    const secondary = (data.actions || []).find((a) => a && a.url && a.url !== data.link?.url);
    const buttons = [
      data.link?.url ? { ...data.link, primary: true } : null,
      secondary || null,
    ].filter(Boolean);
    const srcDomains = [...new Set((data.sources || []).map((s) => (s.label || hostOf(s.url)).split('/')[0]))].slice(0, 3);
    // Blocks below the summary fade in after the word-by-word reveal ends.
    const tail = Math.min((data.summary || '').split(/\s+/).length, 70) * 26 + 150;
    const after = (i) => `animation-delay:${tail + i * 110}ms`;

    const body = setBody(`
      <button class="acii-back">${I.back} Back</button>
      <div>
        <span class="acii-badge ${pathway ? 'acii-badge-path' : ''}">${I.spark} ${pathway ? 'Your personalised pathway · based on your profile' : 'AI-generated · verify sources'}</span>
      </div>
      <p class="acii-summary">${revealWords(data.summary || '')}</p>
      ${data.place ? `
        <a class="acii-map acii-stagger" style="${after(0)}" target="_blank" rel="noopener"
           href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(data.place)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1116 0z"/><circle cx="12" cy="10" r="3"/></svg>
          ${esc(data.place)} — open in Maps
        </a>` : ''}
      ${(data.items || []).length ? `
        <div class="acii-items acii-stagger" style="${after(0)}">
          ${data.items.map((it) => `
            <button class="acii-item" data-url="${esc(it.url)}">
              <span class="acii-item-txt">
                <b>${esc(it.title)}</b>
                ${it.detail ? `<small>${esc(it.detail)}</small>` : ''}
              </span>
              <span class="acii-item-go">${I.arrow}</span>
            </button>`).join('')}
        </div>` : ''}
      <button class="acii-listen acii-stagger" style="${after(1)}" title="Hear this answer">${I.speaker} <span>Listen to this answer</span></button>
      ${data.summaryEn && data.lang !== 'en' ? `
        <div class="acii-english acii-stagger" style="${after(2)}">
          <button class="acii-entoggle" aria-expanded="false">In English ${I.down}</button>
          <p class="acii-entext" hidden>${linkify(data.summaryEn)}</p>
        </div>` : ''}
      ${buttons.length ? `
        <div class="acii-actions acii-stagger" style="${after(3)}">
          ${buttons.map((b) => `
            <button class="acii-btn ${b.primary ? 'acii-btn-primary acii-shimmer' : 'acii-btn-secondary'}" data-url="${esc(b.url)}">
              ${esc(b.label)}
            </button>`).join('')}
        </div>` : ''}
      ${(data.sources || []).length ? `
        <button class="acii-srctoggle acii-stagger" style="${after(4)}" aria-expanded="false">
          ${srcDomains.map((d) => `<span class="acii-srcdot">${esc(d)}</span>`).join('')}
          <span class="acii-srccount">${data.sources.length} source${data.sources.length > 1 ? 's' : ''}</span>
          ${I.down}
        </button>
        <div class="acii-srclist" hidden>
          ${data.sources.map((s) => `
            <button class="acii-src" data-url="${esc(s.url)}">
              <span class="acii-srctype">${esc(s.type || 'PAGE')}</span>
              <span class="acii-srctitle">${esc(s.title)}</span>
              <span class="acii-srchost">${esc(s.label || hostOf(s.url))}</span>
            </button>`).join('')}
        </div>` : ''}`);

    body.querySelector('.acii-back').addEventListener('click', goHome);
    body.querySelectorAll('.acii-src, .acii-btn, .acii-item').forEach((el) =>
      el.addEventListener('click', () => window.open(el.dataset.url, '_blank', 'noopener')));
    const enToggle = body.querySelector('.acii-entoggle');
    if (enToggle) enToggle.addEventListener('click', () => {
      const p = body.querySelector('.acii-entext');
      p.hidden = !p.hidden;
      enToggle.setAttribute('aria-expanded', String(!p.hidden));
      enToggle.classList.toggle('acii-srcopen', !p.hidden);
    });
    const srcToggle = body.querySelector('.acii-srctoggle');
    if (srcToggle) {
      srcToggle.addEventListener('click', () => {
        const list = body.querySelector('.acii-srclist');
        const open = list.hidden;
        list.hidden = !open;
        srcToggle.setAttribute('aria-expanded', String(open));
        srcToggle.classList.toggle('acii-srcopen', open);
      });
    }
    const listen = body.querySelector('.acii-listen');
    listen.addEventListener('click', () => playAnswer(listen));
    // The user asked by voice — start speaking right away (the mic tap counts
    // as the user gesture).
    if (voice && data.summary) playAnswer(listen);
  }

  function goHome() {
    stopAudio();
    clearInterval(thinkTimer);
    const input = $('.acii-input');
    input.value = '';
    $('.acii-go').hidden = true;
    input.focus();
    renderHome();
  }

  /* ----------------------------- guided flow -------------------------------- */
  const STEPS = ['persona', 'sector', 'goal', 'region', 'details'];

  function renderGuided(step) {
    const g = suggestions?.guided;
    if (!g) return;
    if (step === 0) profile = {};
    const n = STEPS.length;
    const header = (title, hint) => `
      <button class="acii-back">${I.back} ${step === 0 ? 'Back' : 'Previous'}</button>
      <div class="acii-progress">
        ${STEPS.map((_, i) => `<i class="${i < step ? 'acii-done' : ''}${i === step ? 'acii-now' : ''}"></i>`).join('')}
        <span>Step ${step + 1} of ${n}</span>
      </div>
      <div class="acii-steplabel">${title}</div>
      ${hint ? `<div class="acii-stephint">${hint}</div>` : ''}`;
    const pick = (cls, value, next) => (el) => {
      el.classList.add('acii-picked');
      Object.assign(profile, value);
      setTimeout(() => renderGuided(next), 220); // brief feedback, then advance
    };

    let html = '';
    if (step === 0) {
      html = `${header('Step 1 · Who are you?', 'Pick the option closest to you — one tap moves you forward.')}
        <div class="acii-personas">
          ${g.personas.map((p) => `
            <button class="acii-persona" data-id="${esc(p.id)}" data-label="${esc(p.label)}">
              <span class="acii-picon">${I[p.icon] || I.building}</span>
              <span>${esc(p.label)}</span>
            </button>`).join('')}
        </div>`;
    } else if (step === 1) {
      html = `${header('Step 2 · Which sector do you belong to?', 'Choose the sector closest to your business.')}
        <div class="acii-chips acii-chips-tight">
          ${g.sectors.map((s) => `<button class="acii-chip" data-v="${esc(s)}">${esc(s)}</button>`).join('')}
        </div>`;
    } else if (step === 2) {
      html = `${header('Step 3 · What is your goal?', 'What would you most like CII to help you with?')}
        <div class="acii-chips">
          ${g.goals.map((s) => `<button class="acii-chip acii-chip-lg" data-v="${esc(s)}">${esc(s)}</button>`).join('')}
        </div>`;
    } else if (step === 3) {
      html = `${header('Step 4 · Which region are you in?', 'So we can point you to the right offices and events.')}
        <div class="acii-chips">
          ${g.regions.map((s) => `<button class="acii-chip acii-chip-lg" data-v="${esc(s)}">${esc(s)}</button>`).join('')}
        </div>`;
    } else {
      html = `${header('Step 5 · Almost there', 'Both fields are optional — skip straight to your pathway if you like.')}
        <div class="acii-field">
          <label>Company / organisation <span>(optional)</span></label>
          <input type="text" class="acii-text acii-company" placeholder="e.g. Acme Industries Pvt Ltd" />
        </div>
        <div class="acii-field">
          <label>Anything specific you need help with? <span>(optional)</span></label>
          <textarea class="acii-text acii-help" rows="3" placeholder="e.g. finding export partners in the EU, green certification for our plant…"></textarea>
        </div>
        <div class="acii-actions" style="border-top:0;padding-top:6px">
          <button class="acii-btn acii-btn-primary acii-shimmer acii-gosubmit">${I.spark} Show my pathway</button>
        </div>`;
    }

    const body = setBody(html, { roomy: true });
    body.querySelector('.acii-back').addEventListener('click', () => (step === 0 ? renderHome() : renderGuided(step - 1)));
    body.querySelectorAll('.acii-persona').forEach((el) =>
      el.addEventListener('click', () => pick('persona', { persona: el.dataset.label }, 1)(el)));
    body.querySelectorAll('.acii-chip').forEach((el) =>
      el.addEventListener('click', () => {
        const val = el.dataset.v;
        if (step === 1) pick('chip', { sector: val }, 2)(el);
        else if (step === 2) pick('chip', { goal: val }, 3)(el);
        else if (step === 3) pick('chip', { region: val }, 4)(el);
      }));
    body.querySelector('.acii-gosubmit')?.addEventListener('click', () => {
      profile.company = body.querySelector('.acii-company').value.trim();
      profile.help = body.querySelector('.acii-help').value.trim();
      runGuided();
    });
  }

  async function runGuided() {
    if (busy) return;
    busy = true;
    const q =
      `I am a ${profile.persona || 'visitor'} in the ${profile.sector || 'general'} sector, based in ${profile.region || 'India'}. ` +
      `My goal: ${profile.goal || 'engaging with CII'}.` +
      (profile.company ? ` Company: ${profile.company}.` : '') +
      (profile.help ? ` Specific help needed: ${profile.help}.` : '') +
      ` Based on this profile, recommend the most relevant CII services, memberships, events, Centres of Excellence and programmes for me, with concrete next steps.`;
    const input = $('.acii-input');
    input.value = 'My personalised CII pathway';
    renderThinking('Building your personalised pathway…');
    try {
      const res = await fetch(`${ENDPOINT}/api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, guided: true }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
      renderAnswer(q, data, { pathway: true });
    } catch (e) {
      renderError(`Couldn't build your pathway: ${e.message}. Please try again.`);
    } finally {
      busy = false;
    }
  }

  /* --------------------------------- ask ------------------------------------ */
  async function ask(q, { voice = false } = {}) {
    if (busy || !q) return;
    busy = true;
    stopAudio();
    open();
    const input = $('.acii-input');
    input.value = q;
    renderThinking();
    try {
      const res = await fetch(`${ENDPOINT}/api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, voice }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
      history.add(q);
      renderAnswer(q, data, { voice });
    } catch (e) {
      renderError(`Couldn't get an answer: ${e.message}. Please try again.`);
    } finally {
      busy = false;
    }
  }

  /* -------------------------------- voice ----------------------------------- */
  const MAX_RECORD_MS = 45000;
  let recCleanup = null; // stops waveform/timer/audio-context for the session

  /** Toggle the Apple-Intelligence-style glow on the modal while listening. */
  function setListening(on) {
    overlay?.querySelector('.acii-modal')?.classList.toggle('acii-listening', on);
  }

  async function toggleRecording() {
    const micBtn = $('.acii-mic');
    if (recorder && recorder.state === 'recording') {
      recorder.stop(); // header mic acts as "Done" while recording
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
      micBtn.title = 'Ask by voice';
      setListening(false);
      recCleanup?.();
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
      recorder = null;
      input.placeholder = suggestions?.placeholder || 'Ask CII anything — or search sectors, reports, offices, people...';
      if (recCancelled) { recCancelled = false; renderHome(); return; }
      if (blob.size < 2000) { renderHome(); return; } // too short to be speech
      renderThinking('Heard you! Transcribing your question…');
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
    micBtn.title = 'Finish and get the answer';
    const input = $('.acii-input');
    input.value = '';
    input.placeholder = 'Listening…';
    setListening(true);
    showListeningPanel(stream);
  }

  /** Siri-style listening view: gradient orb reacting to your voice. */
  function showListeningPanel(stream) {
    const body = setBody(`
      <div class="acii-voice-panel">
        <div class="acii-orbwrap">
          <span class="acii-orb acii-orb-lg"></span>
          <span class="acii-orb-mic">${I.mic}</span>
        </div>
        <div class="acii-voice-status">Listening — speak your question</div>
        <div class="acii-voice-langs">English &nbsp;·&nbsp; हिंदी &nbsp;·&nbsp; Hinglish &nbsp;·&nbsp; ਪੰਜਾਬੀ</div>
        <canvas class="acii-wave" width="360" height="44" aria-hidden="true"></canvas>
        <div class="acii-voice-timer">0:00</div>
        <div class="acii-voice-btns">
          <button class="acii-btn acii-btn-primary acii-shimmer acii-voice-done">Done — get my answer</button>
          <button class="acii-btn acii-btn-secondary acii-voice-cancel">Cancel</button>
        </div>
      </div>`);
    body.querySelector('.acii-voice-done').addEventListener('click', () => recorder?.state === 'recording' && recorder.stop());
    body.querySelector('.acii-voice-cancel').addEventListener('click', () => {
      if (recorder?.state === 'recording') { recCancelled = true; recorder.stop(); }
    });

    // Drive the orb + gradient waveform from the live mic level.
    const canvas = body.querySelector('.acii-wave');
    const orb = body.querySelector('.acii-orb-lg');
    const cx = canvas.getContext('2d');
    let actx = null, raf = 0;
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = actx.createAnalyser();
      analyser.fftSize = 128;
      actx.createMediaStreamSource(stream).connect(analyser);
      const bins = new Uint8Array(analyser.frequencyBinCount);
      const grad = cx.createLinearGradient(0, 0, canvas.width, 0);
      grad.addColorStop(0, '#ff5f6d'); grad.addColorStop(0.35, '#a18cd1');
      grad.addColorStop(0.7, '#5b9df9'); grad.addColorStop(1, '#43d8c9');
      const draw = () => {
        analyser.getByteFrequencyData(bins);
        let sum = 0;
        cx.clearRect(0, 0, canvas.width, canvas.height);
        const bar = canvas.width / bins.length;
        for (let i = 0; i < bins.length; i++) {
          sum += bins[i];
          const h = Math.max(3, (bins[i] / 255) * canvas.height);
          cx.fillStyle = grad;
          cx.globalAlpha = 0.4 + 0.6 * (bins[i] / 255);
          cx.fillRect(i * bar + 1, (canvas.height - h) / 2, bar - 2, h);
        }
        cx.globalAlpha = 1;
        const level = sum / bins.length / 255; // 0..1 speaking loudness
        if (orb) orb.style.transform = `scale(${1 + level * 0.35})`;
        raf = requestAnimationFrame(draw);
      };
      draw();
    } catch { /* orb + waveform are progressive enhancement */ }

    const t0 = Date.now();
    const timerEl = body.querySelector('.acii-voice-timer');
    const statusEl = body.querySelector('.acii-voice-status');
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      const left = Math.ceil((MAX_RECORD_MS - (Date.now() - t0)) / 1000);
      if (left <= 10) statusEl.textContent = `Finishing in ${left}s — tap Done when ready`;
      if (Date.now() - t0 >= MAX_RECORD_MS && recorder?.state === 'recording') recorder.stop();
    }, 250);

    recCleanup = () => {
      clearInterval(timer);
      if (raf) cancelAnimationFrame(raf);
      actx?.close().catch(() => {});
      recCleanup = null;
    };
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
        btn.classList.remove('acii-speaking');
      };
      // Flip the button before play() — on some devices/policies the promise
      // settles late or rejects, and the label must never stick on "Preparing".
      btn.disabled = false;
      btn.innerHTML = `${I.pause} <span>Stop audio</span>`;
      btn.classList.add('acii-speaking');
      await audioEl.play();
    } catch {
      btn.disabled = false;
      btn.innerHTML = `${I.speaker} <span>Listen to this answer</span>`;
      btn.classList.remove('acii-speaking');
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
    clearInterval(thinkTimer);
    if (recorder?.state === 'recording') { recCancelled = true; recorder.stop(); }
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
  // Emails, URLs (incl. LinkedIn) and phone numbers become tappable links.
  const CONTACT_RE = /([\w.+-]+@[\w-]+\.[\w.]+)|((?:https?:\/\/|www\.)[^\s,)"'<>]+)|(\+?\d[\d\s().-]{8,}\d)/g;

  function hrefFor(match) {
    if (match.includes('@') && !match.startsWith('http')) return `mailto:${match}`;
    if (/^(https?:\/\/|www\.)/i.test(match)) return match.startsWith('www.') ? `https://${match}` : match;
    const digits = match.replace(/[^\d+]/g, '');
    return digits.length >= 10 ? `tel:${digits}` : null;
  }

  /** Stream text in word by word (ChatGPT-style), linkifying contacts. */
  function revealWords(text) {
    let w = 0;
    const span = (part) => `<span class="acii-w" style="--w:${Math.min(w++, 70)}">${esc(part)}</span>`;
    const out = [];
    let last = 0;
    const s = String(text);
    for (const m of s.matchAll(CONTACT_RE)) {
      const before = s.slice(last, m.index);
      out.push(before.split(/(\s+)/).map((p) => (p.trim() ? span(p) : p)).join(''));
      const clean = m[0].replace(/[.,;:]+$/, ''); // don't swallow sentence punctuation
      const trailer = m[0].slice(clean.length);
      const href = hrefFor(clean);
      out.push(href
        ? `<a class="acii-link acii-w" style="--w:${Math.min(w++, 70)}" href="${esc(href)}" target="_blank" rel="noopener">${esc(clean)}</a>${esc(trailer)}`
        : span(clean) + esc(trailer));
      last = m.index + m[0].length;
    }
    const rest = s.slice(last);
    out.push(rest.split(/(\s+)/).map((p) => (p.trim() ? span(p) : p)).join(''));
    return out.join('');
  }

  /** Plain linkify (no reveal) for secondary text like the English version. */
  function linkify(text) {
    let outp = '';
    let last = 0;
    const s = String(text);
    for (const m of s.matchAll(CONTACT_RE)) {
      outp += esc(s.slice(last, m.index));
      const clean = m[0].replace(/[.,;:]+$/, '');
      const href = hrefFor(clean);
      outp += (href ? `<a class="acii-link" href="${esc(href)}" target="_blank" rel="noopener">${esc(clean)}</a>` : esc(clean)) + esc(m[0].slice(clean.length));
      last = m.index + m[0].length;
    }
    return outp + esc(s.slice(last));
  }
  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  window.AskCII = { open, close, ask: (q) => ask(q), guide: () => { open(); renderGuided(0); } };
})();
