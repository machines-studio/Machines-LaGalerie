// ---------------------------------------------------------------------------
// Gallery show — what actually runs on site during the exhibition.
//
// Combines the autoplay loop (same show.timeline engine as demo.js — see
// that file's header for how the timeline/points work) with a minimal
// gallery-facing HTTP UI for on-duty staff / the artist to use during
// opening hours:
//
//   npm run gallery     then open http://<host>:8080
//
//   - one master volume slider, applied to all 3 hplayers at once
//     (persisted to gallery-state.json, survives a power cycle)
//   - "goto focus" per point: hard-cut takeover, jumps the live show
//     straight to that point's beamFade -> video (video + strip),
//     resumes normal looping afterwards
//   - fog machine master on/off (disables the automatic search-phase bursts;
//     persisted to gallery-state.json, survives a power cycle)
//   - global play/pause: freezes the whole timeline (beam/smoke/strip stop
//     changing) and pauses whichever hplayer is currently playing (sound
//     pre-roll or video); resume un-freezes and resumes that same hplayer.
//     NOT persisted — always starts playing on process restart, so a stale
//     "paused" state can't survive a power cycle unnoticed.
//
// This is intentionally a SMALLER surface than panel.js: no raw channel
// access, no full manual fixture control. Use panel.js for calibration
// before opening; use this file once the show is live.
//
// Flags:
//   --no-smoke            fog starts disabled on the very first run (before
//                         gallery-state.json exists) — once toggled from the
//                         UI the persisted value wins on every future
//                         restart, flag or not
//   --fast                run every timeline step at ~1/3 duration (quick
//                         testing)
//   --skip-hplayer-wait   don't wait for hplayers to boot on startup (indoor
//                         testing without the players reachable at all)
// ---------------------------------------------------------------------------

import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setup, handleExit, waitForHplayers } from './src/setup.js';

const args = process.argv.slice(2);
const timeScale = args.includes('--fast') ? 0.3 : 1;

const { fixtures, config, shutdown } = await setup();
handleExit(shutdown);

if (!args.includes('--skip-hplayer-wait')) await waitForHplayers(fixtures);

const show = config.show;
const beam = fixtures.beam;
const smokeFixture = fixtures.smoke;
const points = show.points;
const timeline = show.timeline;
const allHplayers = points
  .map((p) => p.hplayer)
  .filter(Boolean)
  .map((name) => fixtures[name]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min, max) => min + Math.random() * (max - min);

// --- persistent gallery state (survives power loss, not just process restart) --
// Master volume (applies to every hplayer at once — there is no per-player
// volume in the gallery UI) and the fog on/off toggle. Stored on disk (not
// config.js: this is runtime state the gallery UI writes, config.js is
// hand-edited/versioned).
const STATE_PATH = fileURLToPath(new URL('./gallery-state.json', import.meta.url));
const DEFAULT_STATE = { volume: 80, smokeEnabled: !args.includes('--no-smoke') };

async function loadState() {
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(await readFile(STATE_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

async function saveState() {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2)).catch((err) =>
    console.error(`[gallery] failed to save ${STATE_PATH}: ${err.message}`));
}

const state = await loadState();

async function applyVolume() {
  await Promise.all(allHplayers.map((h) => h.volume(state.volume).catch((err) =>
    console.error(`[gallery] volume on ${h.host} failed: ${err.message}`))));
}
await applyVolume();

// --- startup self-test: quick R/G/B/W wipe on every strip -------------------
console.log('[gallery] startup strip check: red / green / blue / white');
const allStrips = points.map((p) => fixtures[p.strip]);
for (const [r, g, b, w] of [[255, 0, 0, 0], [0, 255, 0, 0], [0, 0, 255, 0], [0, 0, 0, 255]]) {
  for (const strip of allStrips) strip.setColor(r, g, b, w);
  await sleep(1000);
}
for (const strip of allStrips) strip.off();

beam.home();
beam.setDimmer(0);

// --- show state machine ------------------------------------------------
// Same timeline-walking shape as demo.js. The one addition is `focusRequest`:
// set by the HTTP API, consumed by the tick loop to hard-cut into a point.
let pointIndex = 0;
let stepIndex = 0;
let stepStart;
const pos = { pan: 270, tilt: 55 };
let wander = null;
let wanderAge = 0;
let focusFrom = null;
let focusRequest = null; // point index requested via the gallery UI, or null
let paused = false; // global play/pause, set via the gallery UI, not persisted
let pausedAt = null; // Date.now() when paused; used to shift stepStart on resume
let videoStopped = false; // one-shot: has the current 'video' step's hplayer been stopped yet

// Index of the timeline's 'beamFade' and 'video' steps — resolved once
// so a "goto focus" hard-cut can jump straight to beamFade.
const beamFadeIndex = timeline.findIndex((s) => s.phase === 'beamFade');
if (beamFadeIndex === -1) throw new Error("show.timeline needs a 'beamFade' step");

// Every step in a pass — including 'search' — targets the same current
// point: the beam searches in that point's color, then locks onto and
// reveals that same point right after.
function targetPoint(step) {
  return points[pointIndex];
}

function stepSeconds(step) {
  if (step.phase === 'video') return points[pointIndex].video.seconds + step.extraSeconds;
  if (step.phase === 'sound') return points[pointIndex].sound?.seconds ?? 0;
  return step.seconds;
}

// The hplayer actually producing sound/picture right now, if any — the
// current point's sound hplayer during 'sound', its own hplayer during
// 'video'. Used by play/pause to pause/resume the right player.
function activeHplayer() {
  const step = timeline[stepIndex];
  const point = points[pointIndex];
  if (step.phase === 'sound' && point.sound) return fixtures[point.sound.hplayer];
  if (step.phase === 'video' && point.hplayer) return fixtures[point.hplayer];
  return null;
}

function enter(index) {
  stepIndex = index;
  stepStart = Date.now();
  const step = timeline[stepIndex];
  const point = targetPoint(step);
  const n = pointIndex + 1;

  switch (step.phase) {
    case 'search': {
      beam.shutterOpen();
      beam.setColor(point.color);
      const smokeSec = Math.min(step.smokeSeconds, step.seconds) * timeScale;
      if (state.smokeEnabled) smokeFixture.burst(step.smokePercent, smokeSec);
      console.log(`[gallery] point ${n}: searching (${point.color})...` +
        (state.smokeEnabled ? ` (smoke ${step.smokePercent}% for ${smokeSec.toFixed(1)} s)` : ''));
      break;
    }
    case 'focus':
      smokeFixture.off();
      focusFrom = { ...pos };
      console.log(`[gallery] point ${n}: locking onto (pan ${point.pan}°, tilt ${point.tilt}°)`);
      break;
    case 'reveal':
      beam.setPosition(point.pan, point.tilt);
      beam.setDimmer(255);
      console.log(`[gallery] point ${n}: revealed (${point.color})`);
      break;
    case 'beamFade':
      smokeFixture.off();
      console.log(`[gallery] point ${n}: beam fading out`);
      break;
    case 'sound': {
      const sound = point.sound;
      if (sound) {
        const hplayer = fixtures[sound.hplayer];
        hplayer.trig(sound.file)
          .then(() => hplayer.volume(state.volume)) // in case the player reset its own volume
          .catch((err) => console.error(`[gallery] ${sound.hplayer} sound trig failed: ${err.message}`));
        console.log(`[gallery] point ${n}: sound ${sound.file} on ${sound.hplayer}`);
      }
      break;
    }
    case 'video': {
      beam.shutterClose();
      beam.setDimmer(0);
      // Sound pre-roll is done holding its 'sound' step — stop it explicitly
      // rather than letting it keep playing under the video (it may live on
      // a different hplayer than the point's own).
      const soundHplayer = point.sound ? fixtures[point.sound.hplayer] : null;
      if (soundHplayer) soundHplayer.stop().catch(() => {});
      videoStopped = false;
      const hplayer = point.hplayer ? fixtures[point.hplayer] : null;
      if (hplayer) {
        hplayer.trig(point.video.file ?? 1)
          .then(() => hplayer.volume(state.volume)) // in case the player reset its own volume
          .catch((err) => console.error(`[gallery] ${point.hplayer} trig failed: ${err.message}`));
      }
      console.log(`[gallery] point ${n}: strip '${point.strip}' fading in (${point.color})` +
        (hplayer ? ` + ${point.hplayer} trig ${point.video.file ?? 1}` : ''));
      break;
    }
    case 'gap':
      fixtures[point.strip].off();
      console.log(`[gallery] point ${n}: gap`);
      break;
    default:
      console.warn(`[gallery] unknown timeline phase '${step.phase}', skipping`);
      enter((stepIndex + 1) % timeline.length);
  }
}

function advance() {
  // A focus request takes priority over the normal timeline order: hard-cut
  // into the requested point's beamFade step, from wherever we are.
  if (focusRequest !== null) {
    const requested = focusRequest;
    focusRequest = null;
    for (const p of points) {
      const hplayer = p.hplayer ? fixtures[p.hplayer] : null;
      if (hplayer) hplayer.stop().catch(() => {});
      const soundHplayer = p.sound ? fixtures[p.sound.hplayer] : null;
      if (soundHplayer) soundHplayer.stop().catch(() => {});
    }
    beam.setDimmer(0);
    pointIndex = requested;
    enter(beamFadeIndex);
    return;
  }

  const nextStep = stepIndex + 1;
  if (nextStep < timeline.length) {
    enter(nextStep);
  } else {
    pointIndex = (pointIndex + 1) % points.length;
    enter(0);
  }
}

// Global play/pause. Pausing freezes the timeline (tick() becomes a no-op)
// and pauses whichever hplayer is currently playing; resuming shifts
// `stepStart` forward by the paused duration — so the in-progress step picks
// up exactly where it left off — and resumes that same hplayer.
async function setPaused(next) {
  if (next === paused) return;
  const hplayer = activeHplayer();
  if (next) {
    paused = true;
    pausedAt = Date.now();
    if (hplayer) await hplayer.pause().catch((err) =>
      console.error(`[gallery] pause on ${hplayer.host} failed: ${err.message}`));
    console.log('[gallery] paused');
  } else {
    stepStart += Date.now() - pausedAt;
    paused = false;
    if (hplayer) await hplayer.resume().catch((err) =>
      console.error(`[gallery] resume on ${hplayer.host} failed: ${err.message}`));
    console.log('[gallery] resumed');
  }
}

function tick() {
  if (paused) return; // frozen — beam/smoke/strip hold, hplayer already paused via /api/pause

  const step = timeline[stepIndex];
  const t = (Date.now() - stepStart) / 1000;
  const dur = stepSeconds(step) * timeScale;
  const point = targetPoint(step);

  // A focus request can also interrupt mid-step, not just at step
  // boundaries — otherwise a 90 s video step would ignore the button for
  // up to 90 s. Only skip if we're not already exactly where it wants us.
  if (focusRequest !== null && !(stepIndex === beamFadeIndex && pointIndex === focusRequest)) {
    advance();
    return;
  }

  switch (step.phase) {
    case 'search': {
      const reached = wander && Math.hypot(wander.pan - pos.pan, wander.tilt - pos.tilt) < 5;
      if (!wander || reached || ++wanderAge > config.refreshRate * 1.5) {
        wander = { pan: rand(step.panMin, step.panMax), tilt: rand(step.tiltMin, step.tiltMax) };
        wanderAge = 0;
      }
      pos.pan += (wander.pan - pos.pan) * 0.07;
      pos.tilt += (wander.tilt - pos.tilt) * 0.07;
      beam.setPosition(pos.pan, pos.tilt);
      beam.setDimmer(255);
      if (t >= dur) advance();
      break;
    }

    case 'focus': {
      const k = Math.min(1, t / dur);
      const ease = 1 - (1 - k) ** 3;
      const wobble = Math.sin(k * Math.PI * 4) * (1 - k) * 8;
      pos.pan = focusFrom.pan + (point.pan - focusFrom.pan) * ease + wobble;
      pos.tilt = focusFrom.tilt + (point.tilt - focusFrom.tilt) * ease + wobble * 0.4;
      beam.setPosition(pos.pan, pos.tilt);
      if (k >= 1) advance();
      break;
    }

    case 'reveal': {
      if (t >= dur) advance();
      break;
    }

    case 'beamFade': {
      const k = Math.min(1, t / dur);
      beam.setDimmer(Math.round(255 * (1 - k)));
      if (k >= 1) advance();
      break;
    }

    case 'sound': {
      if (t >= dur) advance();
      break;
    }

    case 'video': {
      const strip = fixtures[point.strip];
      const fadeSeconds = 1.5 * timeScale;
      const k = Math.min(1, t / dur);
      let scale;
      if (t < fadeSeconds) scale = t / fadeSeconds;
      else if (dur - t < fadeSeconds) scale = (dur - t) / fadeSeconds;
      else scale = 1;
      strip.setNamedColor(point.color, Math.max(0, Math.min(1, scale)));
      // The clip itself only runs for video.seconds — extraSeconds is just
      // how much longer the strip stays lit after. Stop the hplayer once the
      // clip's own runtime is up rather than leaving it playing/looping for
      // the rest of this step's (longer) hold.
      const videoDur = point.video.seconds * timeScale;
      if (!videoStopped && t >= videoDur) {
        videoStopped = true;
        const hplayer = point.hplayer ? fixtures[point.hplayer] : null;
        if (hplayer) hplayer.stop().catch(() => {});
      }
      if (k >= 1) {
        strip.off();
        advance();
      }
      break;
    }

    case 'gap': {
      if (t >= dur) advance();
      break;
    }

    default:
      advance();
  }
}

console.log(`[gallery] starting loop over ${points.length} points, ${timeline.length} steps each` +
  (timeScale !== 1 ? ' (fast mode)' : ''));
enter(0);
setInterval(tick, 1000 / config.refreshRate);

// --- gallery HTTP UI ---------------------------------------------------
const indexHtml = await readFile(
  fileURLToPath(new URL('./public/gallery.html', import.meta.url)),
);

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (err) { reject(err); }
    });
  });

const server = http.createServer(async (req, res) => {
  const sendJson = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(indexHtml);
    }

    // GET /api/state — current point/step, master volume, fog state
    if (req.method === 'GET' && req.url === '/api/state') {
      return sendJson(200, {
        points: points.map((p, i) => ({
          index: i,
          strip: p.strip,
          hplayer: p.hplayer,
          color: p.color,
        })),
        current: { pointIndex, phase: timeline[stepIndex].phase },
        volume: state.volume,
        smokeEnabled: state.smokeEnabled,
        paused,
      });
    }

    if (req.method !== 'POST') return sendJson(404, { error: 'not found' });
    const body = await readBody(req);

    // POST /api/volume  { volume: 0-100 } — master volume, applies to every
    // hplayer at once, persisted to disk (gallery-state.json).
    if (req.url === '/api/volume') {
      const v = Math.max(0, Math.min(100, Math.round(Number(body.volume))));
      if (!Number.isFinite(v)) return sendJson(400, { error: 'invalid volume' });
      state.volume = v;
      await saveState();
      await applyVolume();
      return sendJson(200, { ok: true });
    }

    // POST /api/pause  { paused: boolean } — freezes/resumes the whole
    // timeline and pauses/resumes whichever hplayer is currently playing.
    // Not persisted: always starts playing on process restart.
    if (req.url === '/api/pause') {
      await setPaused(!!body.paused);
      return sendJson(200, { ok: true });
    }

    // POST /api/focus  { point: 0-based index }
    if (req.url === '/api/focus') {
      if (!Number.isInteger(body.point) || !points[body.point]) {
        return sendJson(400, { error: 'invalid point index' });
      }
      focusRequest = body.point;
      return sendJson(200, { ok: true });
    }

    // POST /api/fog  { enabled: boolean } — persisted to disk (gallery-state.json).
    if (req.url === '/api/fog') {
      state.smokeEnabled = !!body.enabled;
      if (!state.smokeEnabled) smokeFixture.off();
      await saveState();
      return sendJson(200, { ok: true });
    }

    return sendJson(404, { error: 'not found' });
  } catch (err) {
    return sendJson(500, { error: err.message });
  }
});

server.listen(config.panelPort, () => {
  console.log(`[gallery] UI on http://localhost:${config.panelPort}`);
});
