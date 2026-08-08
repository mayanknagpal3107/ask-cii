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

/* 3. home view */
ok('try-asking chips', await page.locator('.acii-chip').count() >= 4);
ok('common questions (3 shown)', await page.locator('.acii-qrow').count() === 3);
await page.click('.acii-more');
ok('load more reveals all', await page.locator('.acii-qrow').count() === 6);
ok('quick action cards', await page.locator('.acii-card').count() === 3);
await page.screenshot({ path: `${SCRATCH}/e2e-home.png` });

/* 4. English ask via chip */
await page.locator('.acii-chip', { hasText: 'How do I become a member?' }).click();
await page.waitForSelector('.acii-summary', { timeout: 90000 });
const enSummary = await page.locator('.acii-summary').innerText();
ok('EN answer renders', enSummary.length > 40, enSummary.slice(0, 70));
ok('EN AI badge', await page.locator('.acii-badge').count() === 1);
ok('EN sources listed', await page.locator('.acii-src').count() >= 1);
ok('EN action buttons', await page.locator('.acii-btn').count() >= 1);
ok('EN listen button', await page.locator('.acii-listen').count() === 1);
await page.screenshot({ path: `${SCRATCH}/e2e-answer-en.png` });

/* 5. source click targets cii.in (window.open stubbed — no egress in sandbox) */
await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
await page.locator('.acii-src').first().click();
const opened = await page.evaluate(() => window.__opened);
ok('source click opens cii.in URL', opened.length === 1 && opened[0].includes('cii.in'), opened[0] || 'none');

/* 6. back to home */
await page.click('.acii-back');
ok('back returns home', await page.locator('.acii-chip').count() >= 4);

/* 7. Hindi */
await page.fill('.acii-input', 'CII की सदस्यता कैसे लें?');
await page.press('.acii-input', 'Enter');
await page.waitForSelector('.acii-summary', { timeout: 90000 });
const hiSummary = await page.locator('.acii-summary').innerText();
ok('HI answer in Devanagari', /[ऀ-ॿ]/.test(hiSummary), hiSummary.slice(0, 60));
await page.screenshot({ path: `${SCRATCH}/e2e-answer-hi.png` });

/* 8. Punjabi */
await page.click('.acii-back');
await page.fill('.acii-input', 'CII ਦੇ ਦਫ਼ਤਰ ਕਿੱਥੇ ਹਨ?');
await page.press('.acii-input', 'Enter');
await page.waitForSelector('.acii-summary', { timeout: 90000 });
const paSummary = await page.locator('.acii-summary').innerText();
ok('PA answer in Gurmukhi', /[਀-੿]/.test(paSummary), paSummary.slice(0, 60));
await page.screenshot({ path: `${SCRATCH}/e2e-answer-pa.png` });

/* 9. Hinglish stays Latin */
await page.click('.acii-back');
await page.fill('.acii-input', 'CII ke upcoming events kya hain?');
await page.press('.acii-input', 'Enter');
await page.waitForSelector('.acii-summary', { timeout: 90000 });
const hinSummary = await page.locator('.acii-summary').innerText();
ok('Hinglish answer stays Latin', !/[ऀ-ॿ]/.test(hinSummary) && hinSummary.length > 30, hinSummary.slice(0, 70));

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
ok('recording state shown', true);
await page.screenshot({ path: `${SCRATCH}/e2e-recording.png` });
await page.waitForTimeout(9000); // capture the ~5s spoken question
await page.click('.acii-mic'); // stop
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

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
