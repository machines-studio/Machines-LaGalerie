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
//   - "goto focus" per point: takeover that cuts whatever is currently
//     playing and jumps the live show to that point's disco step, so it
//     wanders/locks/reveals the requested point the normal way; resumes
//     normal looping afterwards
//   - fog machine master on/off (disables the automatic disco-phase bursts;
//     persisted to gallery-state.json, survives a power cycle)
//   - global play/pause: freezes the whole timeline (beam/smoke/strip stop
//     changing) and pauses whichever hplayer is currently playing (sound
//     pre-roll or video); resume un-freezes and resumes that same hplayer.
//     NOT persisted — always starts playing on process restart, so a stale
//     "paused" state can't survive a power cycle unnoticed.
//   - "disco speedup": caps the 'disco' step (search wander + smoke + sound
//     pre-roll) at an operator-entered X seconds instead of each point's
//     own sound.seconds — the sound is stopped at that same X. Takes effect
//     on the next 'disco' step; persisted to gallery-state.json.
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
import { setup, handleExit, waitForHplayers, stopAllHplayers } from './src/setup.js';

const args = process.argv.slice(2);
const timeScale = args.includes('--fast') ? 0.3 : 1;

const { fixtures, config, shutdown } = await setup();
handleExit(shutdown);

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

// --- blink each point's strip while its hplayer(s) are still booting --------
// So whoever's on site can walk the room and see, strip by strip, which
// hplayer(s) haven't come up yet — rather than only a host name in a
// terminal log. A point's strip depends on its own `hplayer` (video) and,
// if set, `sound.hplayer` (may be a different player, e.g. a shared sound
// player) — it blinks as long as either one is still pending, and goes dark
// as soon as both have answered, even before the others finish booting.
if (!args.includes('--skip-hplayer-wait')) {
  const stripHplayerNames = points.map((p) => [
    fixtures[p.strip],
    new Set([p.hplayer, p.sound?.hplayer].filter(Boolean)),
  ]);
  let pending = new Set();
  let blinkOn = false;
  const blinkTimer = setInterval(() => {
    blinkOn = !blinkOn;
    for (const [strip, names] of stripHplayerNames) {
      const waiting = [...names].some((name) => pending.has(name));
      strip.setColor(0, 0, 0, waiting && blinkOn ? 180 : 0);
    }
  }, 400);

  await waitForHplayers(fixtures, { onUpdate: (p) => { pending = p; } });

  clearInterval(blinkTimer);
  for (const [strip] of stripHplayerNames) strip.off();
}

// A previous session may have left a player mid-clip (crash, power cut) —
// reset every hplayer to idle before the show starts driving them again.
await stopAllHplayers(fixtures);

// How long to keep the shutter closed while the color wheel physically
// rotates to its new band. Real hardware travel time, not part of the show
// timing — stays constant even under --fast.
const COLOR_CHANGE_BLINK_MS = 600;

// --- persistent gallery state (survives power loss, not just process restart) --
// Master volume (applies to every hplayer at once — there is no per-player
// volume in the gallery UI) and the fog on/off toggle. Stored on disk (not
// config.js: this is runtime state the gallery UI writes, config.js is
// hand-edited/versioned).
const STATE_PATH = fileURLToPath(new URL('./gallery-state.json', import.meta.url));
// discoSpeedupSeconds: null (default) = 'disco' runs for the point's own
// sound.seconds, same as demo.js. A number caps it at that many seconds
// instead — the sound is stopped at the same X, not just the beam/smoke.
const DEFAULT_STATE = { volume: 80, smokeEnabled: !args.includes('--no-smoke'), discoSpeedupSeconds: null };

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
let videoStarted = false; // one-shot: has the current 'video' step's hplayer been trig'd yet
let videoStopped = false; // one-shot: has the current 'video' step's hplayer been stopped yet
let soundStopped = false; // one-shot: has the current 'disco' step's sound hplayer been stopped yet

// Index of the timeline's 'disco' step — resolved once so a "goto focus"
// request can jump straight to it, for the requested point.
const discoIndex = timeline.findIndex((s) => s.phase === 'disco');
if (discoIndex === -1) throw new Error("show.timeline needs a 'disco' step");

// Every step in a pass — including 'disco' — targets the same current
// point: the beam searches in that point's color, then locks onto and
// reveals that same point right after.
function targetPoint(step) {
  return points[pointIndex];
}

function stepSeconds(step) {
  // Strip lights up at t=0; the hplayer only trigs after startDelaySeconds
  // (defaults to 0 if omitted) — total hold is that delay + the video's own
  // runtime + the artist-tunable buffer after it ends.
  if (step.phase === 'video') {
    return (step.startDelaySeconds ?? 0) + points[pointIndex].video.seconds + step.extraSeconds;
  }
  // 'disco' runs for as long as the point's sound pre-roll does, not a
  // fixed duration — so the search wander/smoke/sound all naturally end
  // together. Points with no `sound` field fall back to this step's own
  // `seconds` (there's no clip length to follow). The gallery UI's disco
  // speedup (state.discoSpeedupSeconds), when set, overrides that with a
  // fixed X instead — see POST /api/disco-speedup below.
  if (step.phase === 'disco') {
    if (state.discoSpeedupSeconds != null) return state.discoSpeedupSeconds;
    return points[pointIndex].sound?.seconds ?? step.seconds;
  }
  return step.seconds;
}

// The hplayer actually producing sound/picture right now, if any — the
// current point's sound hplayer during 'disco' (if it has a sound
// pre-roll), its own hplayer during 'video'. Used by play/pause to
// pause/resume the right player.
function activeHplayer() {
  const step = timeline[stepIndex];
  const point = points[pointIndex];
  if (step.phase === 'disco' && point.sound) return fixtures[point.sound.hplayer];
  // Only once the hplayer has actually been trig'd (see tick()'s 'video'
  // case) — during the pre-video startDelaySeconds window it's still idle,
  // nothing to pause/resume yet.
  if (step.phase === 'video' && videoStarted && point.hplayer) return fixtures[point.hplayer];
  return null;
}

function enter(index) {
  stepIndex = index;
  stepStart = Date.now();
  const step = timeline[stepIndex];
  const point = targetPoint(step);
  const n = pointIndex + 1;

  switch (step.phase) {
    case 'disco': {
      // Close the shutter for the color change: the wheel has to physically
      // rotate to the new band, and with the shutter open that rotation
      // sweeps visibly through every color in between. Closing first turns
      // it into a quick blink instead.
      beam.shutterClose();
      beam.setColor(point.color);
      setTimeout(() => beam.shutterOpen(), COLOR_CHANGE_BLINK_MS);
      beam.setFocus(point.beam.focus ?? 128);
      const smokeSec = Math.min(step.smokeSeconds, stepSeconds(step)) * timeScale;
      if (state.smokeEnabled) smokeFixture.burst(step.smokePercent, smokeSec);
      // Sound pre-roll starts right alongside the search wander and smoke —
      // all three run together for this step. Points with no `sound` field
      // just skip this part.
      soundStopped = false;
      const sound = point.sound;
      if (sound) {
        const hplayer = fixtures[sound.hplayer];
        hplayer.trig(sound.file)
          .then(() => hplayer.volume(state.volume)) // in case the player reset its own volume
          .catch((err) => console.error(`[gallery] ${sound.hplayer} sound trig failed: ${err.message}`));
      }
      console.log(`[gallery] point ${n}: searching (${point.color})...` +
        (state.smokeEnabled ? ` (smoke ${step.smokePercent}% for ${smokeSec.toFixed(1)} s)` : '') +
        (sound ? ` (sound ${sound.file} on ${sound.hplayer})` : ''));
      break;
    }
    case 'focus':
      smokeFixture.off();
      // In case the sound clip is still going (disco.seconds < sound.seconds,
      // or it just hasn't hit its own stop-check yet) — don't let it bleed
      // into focus/reveal.
      if (point.sound && !soundStopped) {
        soundStopped = true;
        fixtures[point.sound.hplayer].stop().catch(() => {});
      }
      // Frost only kicks in once the beam is locking onto the point, not
      // during the open search wander.
      beam.setFrost(point.beam.frost ?? false);
      focusFrom = { ...pos };
      console.log(`[gallery] point ${n}: locking onto (pan ${point.beam.pan}°, tilt ${point.beam.tilt}°)`);
      break;
    case 'reveal':
      beam.setPosition(point.beam.pan, point.beam.tilt);
      beam.setDimmer(point.beam.dimmer ?? 255);
      beam.setFocus(point.beam.focus ?? 128);
      beam.setFrost(point.beam.frost ?? false);
      console.log(`[gallery] point ${n}: revealed (${point.color})`);
      break;
    case 'beamFade':
      smokeFixture.off();
      console.log(`[gallery] point ${n}: beam fading out`);
      break;
    case 'video': {
      beam.shutterClose();
      beam.setDimmer(0);
      videoStarted = false;
      videoStopped = false;
      // hplayer.trig() itself is deferred to tick() until startDelaySeconds
      // has passed — the strip fades in right away here, on its own.
      console.log(`[gallery] point ${n}: strip '${point.strip}' fading in (${point.color})` +
        (point.hplayer ? ` + ${point.hplayer} trig ${point.video.file ?? 1} in ${step.startDelaySeconds ?? 0}s` : ''));
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
  // A focus request takes priority over the normal timeline order: jump
  // into the requested point's disco step, from wherever we are, so the
  // beam wanders/locks/reveals it the normal way instead of hard-cutting
  // straight to a black fade-in.
  if (focusRequest !== null) {
    const requested = focusRequest;
    focusRequest = null;
    for (const p of points) {
      const hplayer = p.hplayer ? fixtures[p.hplayer] : null;
      if (hplayer) hplayer.stop().catch(() => {});
      const soundHplayer = p.sound ? fixtures[p.sound.hplayer] : null;
      if (soundHplayer) soundHplayer.stop().catch(() => {});
      // Only 'gap' ever turns a strip off — if this cut interrupts whatever
      // point was mid-'video' (or anywhere before its own 'gap'), that
      // strip would otherwise stay lit indefinitely once the show jumps
      // away from it.
      fixtures[p.strip].off();
    }
    pointIndex = requested;
    wander = null; // start the wander fresh toward the new point's window
    enter(discoIndex);
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

// Global play/pause. Pausing freezes the timeline (tick() becomes a no-op,
// checked first thing every tick — nothing below it runs, including the
// video/sound timers and the video.seconds stop-check, so a step's own
// clock genuinely stops advancing, not just visually) and pauses whichever
// hplayer is currently playing; resuming shifts `stepStart` forward by the
// paused duration — so the in-progress step picks up exactly where it left
// off (verified: pausing mid-video and resuming minutes later does not
// make the 'video' step's video.seconds stop-check or its advance() fire
// early) — and resumes that same hplayer.
//
// hplayer.pause()/.resume() are best-effort network calls to hardware this
// app doesn't otherwise poll — if one fails, our own timeline still freezes
// correctly, but the physical player may keep playing (or stay paused)
// out of sync with what the UI shows. Surfaced back to the caller as
// `hplayerOk: false` so /api/pause can flag it rather than stay silent.
async function setPaused(next) {
  if (next === paused) return true;
  const hplayer = activeHplayer();
  let hplayerOk = true;
  if (next) {
    paused = true;
    pausedAt = Date.now();
    if (hplayer) await hplayer.pause().catch((err) => {
      hplayerOk = false;
      console.error(`[gallery] pause on ${hplayer.host} failed: ${err.message} ` +
        `— timeline is frozen but the player itself may keep playing`);
    });
    console.log('[gallery] paused');
  } else {
    stepStart += Date.now() - pausedAt;
    paused = false;
    if (hplayer) await hplayer.resume().catch((err) => {
      hplayerOk = false;
      console.error(`[gallery] resume on ${hplayer.host} failed: ${err.message} ` +
        `— timeline resumed but the player itself may still be paused`);
    });
    console.log('[gallery] resumed');
  }
  return hplayerOk;
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
  if (focusRequest !== null && !(stepIndex === discoIndex && pointIndex === focusRequest)) {
    advance();
    return;
  }

  switch (step.phase) {
    case 'disco': {
      const reached = wander && Math.hypot(wander.pan - pos.pan, wander.tilt - pos.tilt) < 5;
      if (!wander || reached || ++wanderAge > config.refreshRate * 1.5) {
        wander = { pan: rand(step.panMin, step.panMax), tilt: rand(step.tiltMin, step.tiltMax) };
        wanderAge = 0;
      }
      pos.pan += (wander.pan - pos.pan) * 0.07;
      pos.tilt += (wander.tilt - pos.tilt) * 0.07;
      beam.setPosition(pos.pan, pos.tilt);
      beam.setDimmer(point.beam.dimmer ?? 255);
      // This step's own duration (dur) IS the sound's stop point — either
      // point.sound.seconds normally, or the gallery UI's disco speedup
      // when set (see stepSeconds()) — so this fires right as the step
      // ends. A safety net in case a tick lands slightly late, not a
      // separate shorter cutoff.
      if (point.sound && !soundStopped && t >= dur) {
        soundStopped = true;
        fixtures[point.sound.hplayer].stop().catch(() => {});
      }
      if (t >= dur) advance();
      break;
    }

    case 'focus': {
      const k = Math.min(1, t / dur);
      const ease = 1 - (1 - k) ** 3;
      const wobble = Math.sin(k * Math.PI * 4) * (1 - k) * 8;
      pos.pan = focusFrom.pan + (point.beam.pan - focusFrom.pan) * ease + wobble;
      pos.tilt = focusFrom.tilt + (point.beam.tilt - focusFrom.tilt) * ease + wobble * 0.4;
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

    case 'video': {
      const strip = fixtures[point.strip];
      const fadeSeconds = 1.5 * timeScale;
      const k = Math.min(1, t / dur);
      let scale;
      if (t < fadeSeconds) scale = t / fadeSeconds;
      else if (dur - t < fadeSeconds) scale = (dur - t) / fadeSeconds;
      else scale = 1;
      strip.setNamedColor(point.color, Math.max(0, Math.min(1, scale)));
      const hplayer = point.hplayer ? fixtures[point.hplayer] : null;
      const startDelay = (step.startDelaySeconds ?? 0) * timeScale;
      // Strip fades in right away (above); the hplayer only trigs once the
      // strip has had startDelaySeconds to itself.
      if (!videoStarted && t >= startDelay) {
        videoStarted = true;
        if (hplayer) {
          hplayer.trig(point.video.file ?? 1)
            .then(() => hplayer.volume(state.volume)) // in case the player reset its own volume
            .catch((err) => console.error(`[gallery] ${point.hplayer} trig failed: ${err.message}`));
        }
      }
      // The clip itself only runs for video.seconds, starting at startDelay
      // — extraSeconds is just how much longer the strip stays lit after.
      // Stop the hplayer once the clip's own runtime is up rather than
      // leaving it playing/looping for the rest of this step's (longer)
      // hold.
      const videoEnd = startDelay + point.video.seconds * timeScale;
      if (!videoStopped && t >= videoEnd) {
        videoStopped = true;
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
        discoSpeedupSeconds: state.discoSpeedupSeconds,
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
    // Not persisted: always starts playing on process restart. `hplayerOk:
    // false` in the response means the timeline froze/resumed fine but the
    // network call to the hplayer itself failed — it may be out of sync.
    if (req.url === '/api/pause') {
      const hplayerOk = await setPaused(!!body.paused);
      return sendJson(200, { ok: true, hplayerOk });
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

    // POST /api/disco-speedup  { seconds: number | null } — caps the 'disco'
    // step (search wander + smoke + sound pre-roll) at this many seconds
    // instead of the point's own sound.seconds; the sound is stopped at the
    // same point, not just the beam/smoke. null/omitted disables the cap,
    // back to each point's own sound length. Takes effect on the next
    // 'disco' step entered — persisted to disk (gallery-state.json).
    if (req.url === '/api/disco-speedup') {
      if (body.seconds === null || body.seconds === undefined) {
        state.discoSpeedupSeconds = null;
      } else {
        const s = Number(body.seconds);
        if (!Number.isFinite(s) || s < 1 || s > 600) {
          return sendJson(400, { error: 'seconds must be between 1 and 600, or null' });
        }
        state.discoSpeedupSeconds = s;
      }
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
