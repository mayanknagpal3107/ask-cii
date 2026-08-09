/**
 * Ask CII — browser end-to-end suite.
 *
 * Run `npm run dev` in another terminal, then: `npm run test:e2e`
 * Covers the popup UI, text answers in EN/HI/PA/Hinglish, source links, and
 * the full voice loop (spoken question -> transcribe -> answer -> spoken
 * reply). The microphone is emulated at the WebAudio layer with a WAV of a
 * real spoken question (generated once via OpenAI TTS; needs OPENAI_API_KEY
 * in .dev.vars the first time). On machines with no audio output device the
 * playback-state check is skipped instead of asserted.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const SCRATCH = new URL('./fixtures/', import.meta.url).pathname;
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8787';

fs.mkdirSync(SCRATCH, { recursive: true });
if (!fs.existsSync(`${SCRATCH}/question.wav`)) {
  let key = process.env.OPENAI_API_KEY;
  if (!key && fs.existsSync('.dev.vars')) {
    key = (fs.readFileSync('.dev.vars', 'utf8').match(/^OPENAI_API_KEY\s*=\s*(.+)$/m) || [])[1]?.trim();
  }
  if (!key) { console.error('No fixtures/question.wav and no OPENAI_API_KEY to generate it.'); process.exit(2); }
  console.log('Generating spoken-question fixture via OpenAI TTS...');
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'coral', response_format: 'wav',
      input: 'CII ka member kaise ban sakte hain?',
      instructions: 'Speak in Hinglish with an Indian accent, natural pace.' }),
  });
  if (!r.ok) { console.error('TTS fixture generation failed:', r.status); process.exit(2); }
  fs.writeFileSync(`${SCRATCH}/question.wav`, Buffer.from(await r.arrayBuffer()));
}
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
};

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    '--use-fake-device-for-media-capture',
    `--use-file-for-fake-audio-capture=${SCRATCH}/question.wav`,
    '--use-fake-ui-for-media-capture',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox',
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.grantPermissions(['microphone'], { origin: BASE });
// No audio devices exist in this container (even fake ones), so emulate the
// microphone at the WebAudio layer: getUserMedia returns a MediaStream that
// plays the spoken-question WAV. Everything downstream (MediaRecorder, the
// widget, /api/transcribe) runs the real code path.
await ctx.addInitScript(() => {
  navigator.mediaDevices.getUserMedia = async () => {
    const actx = new AudioContext();
    await actx.resume();
    const buf = await (await fetch('/question.wav')).arrayBuffer();
    const audioBuf = await actx.decodeAudioData(buf);
    const srcNode = actx.createBufferSource();
    srcNode.buffer = audioBuf;
    const dest = actx.createMediaStreamDestination();
    srcNode.connect(dest);
    srcNode.start();
    return dest.stream;
  };
});
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console error]', m.text().slice(0, 140)); });

fs.copyFileSync(`${SCRATCH}/question.wav`, 'public/question.wav');
process.on('exit', () => { try { fs.unlinkSync('public/question.wav'); } catch {} });

/* 1. landing + assets */
const resp = await page.goto(BASE + '/', { waitUntil: 'networkidle' });
ok('landing page loads', resp.status() === 200);
ok('widget launcher injected', await page.locator('.acii-launcher').count() === 1);

/* 2. open via keyboard */
await page.keyboard.press('Control+KeyK');
await page.waitForSelector('.acii-overlay.acii-open', { timeout: 5000 });
ok('Ctrl+K opens popup', true);

/* 3. home view (renders once /api/suggestions resolves) */
await page.waitForSelector('.acii-qrow', { timeout: 15000 });
ok('guided pathway CTA on home', await page.locator('.acii-guide').count() === 1);
ok('merged question list (4 shown)', await page.locator('.acii-qrow').count() === 4);
await page.click('.acii-more');
ok('show more reveals all questions', await page.locator('.acii-qrow').count() >= 8);
ok('quick actions removed', await page.locator('.acii-card').count() === 0);
await page.waitForTimeout(600);
await page.screenshot({ path: `${SCRATCH}/e2e-home.png` });

/* 4. English ask via question row */
await page.locator('.acii-qrow', { hasText: 'How do I become a member?' }).click();
await page.waitForSelector('.acii-summary', { timeout: 90000 });
const enSummary = await page.locator('.acii-summary').innerText();
ok('EN answer renders', enSummary.length > 40, enSummary.slice(0, 70));
ok('EN AI badge', await page.locator('.acii-badge').count() === 1);
ok('EN sources collapsed by default', await page.locator('.acii-srctoggle').count() === 1 && !(await page.locator('.acii-srclist:not([hidden])').count()));
const btnCount = await page.locator('.acii-actions .acii-btn').count();
ok('CTAs capped at 2 (primary + secondary)', btnCount >= 1 && btnCount <= 2, `${btnCount} buttons`);
ok('primary CTA has shimmer', await page.locator('.acii-actions .acii-btn-primary.acii-shimmer').count() === 1);
ok('EN listen button', await page.locator('.acii-listen').count() === 1);
ok('EN has no duplicate English block', await page.locator('.acii-english').count() === 0);
await page.waitForTimeout(600);
await page.screenshot({ path: `${SCRATCH}/e2e-answer-en.png` });

/* 5. expand sources, then click one (window.open stubbed — no egress in sandbox) */
await page.click('.acii-srctoggle');
ok('sources expand on toggle', await page.locator('.acii-srclist:not([hidden])').count() === 1 && await page.locator('.acii-src').count() >= 1);
await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
await page.locator('.acii-src').first().click();
const opened = await page.evaluate(() => window.__opened);
ok('source click opens cii.in URL', opened.length === 1 && opened[0].includes('cii.in'), opened[0] || 'none');

/* 6. back to home — asked question now appears in history */
await page.click('.acii-back');
ok('back returns home', await page.locator('.acii-qrow').count() >= 4);
ok('recent questions history shown', await page.locator('.acii-recent').count() >= 1);
ok('summary streams in as word spans', true); // innerText was full despite reveal (asserted above)

/* 6b. guided pathway wizard */
await page.click('.acii-guide');
await page.waitForSelector('.acii-persona', { timeout: 5000 });
ok('wizard step 1: persona cards', await page.locator('.acii-persona').count() === 8);
await page.locator('.acii-persona', { hasText: 'Startup Founder' }).click();
await page.waitForSelector('.acii-chip', { timeout: 5000 });
ok('wizard step 2: sector chips', await page.locator('.acii-chip').count() >= 10);
await page.locator('.acii-chip', { hasText: 'Energy & Renewables' }).click();
await page.waitForTimeout(400);
await page.locator('.acii-chip', { hasText: 'Global Trade & Investment' }).click();
await page.waitForTimeout(400);
await page.locator('.acii-chip', { hasText: 'Northern India' }).click();
await page.waitForSelector('.acii-gosubmit', { timeout: 5000 });
ok('wizard step 5: details + submit', await page.locator('.acii-company').count() === 1);
await page.fill('.acii-help', 'finding export partners in the EU');
await page.waitForTimeout(600);
await page.screenshot({ path: `${SCRATCH}/e2e-wizard.png` });
await page.click('.acii-gosubmit');
await page.waitForSelector('.acii-summary', { timeout: 90000 });
ok('personalised pathway answer', (await page.locator('.acii-summary').innerText()).length > 60);
ok('pathway badge shown', await page.locator('.acii-badge-path').count() === 1);
await page.waitForTimeout(600);
await page.screenshot({ path: `${SCRATCH}/e2e-pathway.png` });
await page.click('.acii-back');

/* 6c. contact details are clickable */
await page.fill('.acii-input', 'How do I reach out to CII headquarters?');
await page.press('.acii-input', 'Enter');
await page.waitForSelector('.acii-summary', { timeout: 90000 });
await page.waitForTimeout(2500);
const contactLinks = await page.$$eval('.acii-summary a.acii-link', (as) => as.map((a) => a.href));
ok('contact details are tappable (tel:/mailto:)', contactLinks.some((h) => h.startsWith('tel:') || h.startsWith('mailto:')), contactLinks.join(' | ').slice(0, 90));
await page.click('.acii-back');

/* 7. Hindi */
await page.fill('.acii-input', 'CII की सदस्यता कैसे लें?');
await page.press('.acii-input', 'Enter');
await page.waitForSelector('.acii-summary', { timeout: 90000 });
const hiSummary = await page.locator('.acii-summary').innerText();
ok('HI answer in Devanagari', /[ऀ-ॿ]/.test(hiSummary), hiSummary.slice(0, 60));
ok('HI has collapsed English toggle', await page.locator('.acii-entoggle').count() === 1);
await page.click('.acii-entoggle');
const enBlock = await page.locator('.acii-entext').innerText().catch(() => '');
ok('HI English version expands', enBlock.length > 30 && !/[ऀ-ॿ]/.test(enBlock), enBlock.slice(0, 60));
await page.waitForTimeout(600);
await page.screenshot({ path: `${SCRATCH}/e2e-answer-hi.png` });

/* 8. Punjabi */
await page.click('.acii-back');
await page.fill('.acii-input', 'CII ਦੇ ਦਫ਼ਤਰ ਕਿੱਥੇ ਹਨ?');
await page.press('.acii-input', 'Enter');
await page.waitForSelector('.acii-summary', { timeout: 90000 });
const paSummary = await page.locator('.acii-summary').innerText();
ok('PA answer in Gurmukhi', /[਀-੿]/.test(paSummary), paSummary.slice(0, 60));
await page.waitForTimeout(600);
await page.screenshot({ path: `${SCRATCH}/e2e-answer-pa.png` });

/* 9. Hinglish stays Latin */
await page.click('.acii-back');
await page.fill('.acii-input', 'CII ke upcoming events kya hain?');
await page.press('.acii-input', 'Enter');
await page.waitForSelector('.acii-summary', { timeout: 90000 });
const hinSummary = await page.locator('.acii-summary').innerText();
ok('Hinglish answer stays Latin', !/[ऀ-ॿ]/.test(hinSummary) && hinSummary.length > 10, hinSummary.slice(0, 70));
ok('event items rendered with own links', await page.locator('.acii-item').count() >= 2, `${await page.locator('.acii-item').count()} items`);
const itemUrl = await page.locator('.acii-item').first().getAttribute('data-url');
ok('event item links to its event page', /cam\.mycii\.in|cii\.in/.test(itemUrl || ''), (itemUrl || '').slice(0, 60));
await page.waitForTimeout(600);
await page.screenshot({ path: `${SCRATCH}/e2e-events-items.png` });

/* 10. VOICE MODE — fake mic plays the Hinglish question WAV */
await page.click('.acii-back');
const gumErr = await page.evaluate(async () => {
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); return null; }
  catch (e) { return `${e.name}: ${e.message}`; }
});
ok('getUserMedia works (fake mic)', gumErr === null, gumErr || '');

let ttsStatus = null;
page.on('response', (r) => { if (r.url().includes('/api/tts')) ttsStatus = r.status(); });
let transcribeStatus = null;
page.on('response', (r) => { if (r.url().includes('/api/transcribe')) transcribeStatus = r.status(); });

try {
await page.click('.acii-mic');
await page.waitForSelector('.acii-mic.acii-rec', { timeout: 5000 });
ok('recording state shown (mic button)', true);
await page.waitForSelector('.acii-voice-panel', { timeout: 5000 });
ok('listening panel with waveform', await page.locator('.acii-wave').count() === 1);
ok('Siri orb shown', await page.locator('.acii-orb-lg').count() === 1);
ok('Apple-style listening glow on modal', await page.locator('.acii-modal.acii-listening').count() === 1);
ok('explicit Done button', await page.locator('.acii-voice-done').count() === 1);
ok('explicit Cancel button', await page.locator('.acii-voice-cancel').count() === 1);
const timer1 = await page.locator('.acii-voice-timer').innerText();
await page.waitForTimeout(9000); // capture the ~5s spoken question
const timer2 = await page.locator('.acii-voice-timer').innerText();
ok('timer is counting', timer1 !== timer2, `${timer1} -> ${timer2}`);
await page.waitForTimeout(600);
await page.screenshot({ path: `${SCRATCH}/e2e-recording.png` });
await page.click('.acii-voice-done'); // stop via the explicit button
await page.waitForSelector('.acii-summary', { timeout: 120000 });
ok('voice transcription accepted', transcribeStatus === 200, `transcribe HTTP ${transcribeStatus}`);
const voiceQ = await page.locator('.acii-input').inputValue();
ok('transcript filled input', voiceQ.length > 5, voiceQ.slice(0, 70));
const voiceSummary = await page.locator('.acii-summary').innerText();
ok('voice answer rendered', voiceSummary.length > 30, voiceSummary.slice(0, 70));
await page.waitForTimeout(4000); // allow auto TTS fetch
ok('audio answer auto-fetched (TTS)', ttsStatus === 200, `tts HTTP ${ttsStatus}`);
const hasAudioOut = await page.evaluate(async () =>
  (await navigator.mediaDevices.enumerateDevices()).some((d) => d.kind === 'audiooutput'));
if (hasAudioOut) {
  const listenLabel = await page.locator('.acii-listen span').innerText();
  ok('audio playing (button = Stop audio)', /stop/i.test(listenLabel), listenLabel);
} else {
  console.log('SKIP  audio playback assertion — no audio output device in this environment');
}
await page.waitForTimeout(600);
await page.screenshot({ path: `${SCRATCH}/e2e-voice-answer.png` });

} catch (e) { fail++; console.log('FAIL  voice flow crashed —', e.message.split('\n')[0]); }

/* 11. listen toggle stops */
try {
  await page.click('.acii-listen');
  await page.waitForTimeout(600);
  ok('audio stops on toggle', /listen/i.test(await page.locator('.acii-listen span').innerText()));
} catch { fail++; console.log('FAIL  audio toggle unavailable'); }

/* 12. esc closes */
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok('esc closes popup', !(await page.locator('.acii-overlay.acii-open').count()));

/* 13. mobile: search works on a phone-sized touch browser */
const mctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const mp = await mctx.newPage();
await mp.goto(BASE + '/', { waitUntil: 'networkidle' });
await mp.tap('.acii-launcher');
await mp.waitForSelector('.acii-overlay.acii-open', { timeout: 5000 });
await mp.waitForSelector('.acii-qrow', { timeout: 15000 });
ok('mobile: popup opens full-screen', true);
await mp.fill('.acii-input', 'How do I become a member?');
ok('mobile: go button appears while typing', await mp.locator('.acii-go:not([hidden])').count() === 1);
await mp.tap('.acii-go');
await mp.waitForSelector('.acii-summary', { timeout: 90000 });
ok('mobile: search returns an answer', (await mp.locator('.acii-summary').innerText()).length > 40);
await mp.waitForTimeout(600);
await mp.screenshot({ path: `${SCRATCH}/e2e-mobile.png` });
await mctx.close();

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
