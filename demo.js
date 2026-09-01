// ---------------------------------------------------------------------------
// Exhibition show sequence.
//
// Walks config.js `show.timeline` — an ordered cue sheet — once per point in
// `show.points`, looping back to the first point after the last. The
// timeline itself is generic: to retime or reorder the show, edit
// config.js; this file only needs to know what each *phase name* means.
//
// Flags:
//   --no-smoke   never drive the smoke machine (indoor testing)
//   --fast       run every step at ~1/3 duration (quick testing)
//
// Does NOT wait for hplayers to be reachable on startup (unlike gallery.js)
// — this is the offline/indoor reference sequence, hplayer calls are already
// best-effort (caught + logged) so a missing player just skips its cue.
//
// On startup all strips flash R/G/B/W once as a patch self-test.
// ---------------------------------------------------------------------------

import { setup, handleExit, stopAllHplayers } from './src/setup.js';

const args = process.argv.slice(2);
const smokeEnabled = !args.includes('--no-smoke');
const timeScale = args.includes('--fast') ? 0.3 : 1;

const { fixtures, config, shutdown } = await setup();
handleExit(shutdown);

// A previous session may have left a player mid-clip (crash, power cut) —
// reset every hplayer to idle before the show starts driving them again.
// Best-effort: a missing player here is caught/logged, same as every other
// hplayer call in this file.
await stopAllHplayers(fixtures);

const show = config.show;
const beam = fixtures.beam;
const smoke = smokeEnabled ? fixtures.smoke : null;
const points = show.points;
const timeline = show.timeline;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min, max) => min + Math.random() * (max - min);

// How long to keep the shutter closed while the color wheel physically
// rotates to its new band. Real hardware travel time, not part of the show
// timing — stays constant even under --fast.
const COLOR_CHANGE_BLINK_MS = 150;

// --- startup self-test: quick R/G/B/W wipe on every strip -------------------
console.log('[show] startup strip check: red / green / blue / white');
const allStrips = points.map((p) => fixtures[p.strip]);
for (const [r, g, b, w] of [[255, 0, 0, 0], [0, 255, 0, 0], [0, 0, 255, 0], [0, 0, 0, 255]]) {
  for (const strip of allStrips) strip.setColor(r, g, b, w);
  await sleep(1000);
}
for (const strip of allStrips) strip.off();

beam.home();
beam.setDimmer(0);

// --- show state machine -----------------------------------------------------
// Walks `timeline` for the current point; `pointIndex`/`stepIndex` are the
// only state needed to know "where" the show is.
let pointIndex = 0;
let stepIndex = 0;
let stepStart;
const pos = { pan: 270, tilt: 55 }; // beam position we are steering (degrees)
let wander = null;                  // current random search target
let wanderAge = 0;
let focusFrom = null;               // position when the focus step started
let videoStopped = false;           // one-shot: has the current 'video' step's hplayer been stopped yet
let soundStopped = false;           // one-shot: has the current 'disco' step's sound hplayer been stopped yet

// The point whose color/hplayer/strip is "active" for a given step. Every
// step in a pass — including 'disco' — targets the same current point:
// the beam searches in that point's color, then locks onto and reveals
// that same point right after.
function targetPoint(step) {
  return points[pointIndex];
}

function stepSeconds(step) {
  if (step.phase === 'video') return points[pointIndex].video.seconds + step.extraSeconds;
  // 'disco' runs for as long as the point's sound pre-roll does, not a
  // fixed duration — so the search wander/smoke/sound all naturally end
  // together. Points with no `sound` field fall back to this step's own
  // `seconds` (there's no clip length to follow).
  if (step.phase === 'disco') return points[pointIndex].sound?.seconds ?? step.seconds;
  return step.seconds;
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
      if (smoke) smoke.burst(step.smokePercent, smokeSec);
      // Sound pre-roll starts right alongside the search wander and smoke —
      // all three run together for this step. Points with no `sound` field
      // just skip this part.
      soundStopped = false;
      const sound = point.sound;
      if (sound) {
        const hplayer = fixtures[sound.hplayer];
        hplayer.trig(sound.file).catch((err) =>
          console.error(`[show] ${sound.hplayer} sound trig failed: ${err.message}`));
      }
      console.log(`[show] point ${n}: searching (${point.color})...` +
        (smoke ? ` (smoke ${step.smokePercent}% for ${smokeSec.toFixed(1)} s)` : '') +
        (sound ? ` (sound ${sound.file} on ${sound.hplayer})` : ''));
      break;
    }
    case 'focus':
      if (smoke) smoke.off();
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
      console.log(`[show] point ${n}: locking onto (pan ${point.beam.pan}°, tilt ${point.beam.tilt}°)`);
      break;
    case 'reveal':
      beam.setPosition(point.beam.pan, point.beam.tilt);
      beam.setDimmer(point.beam.dimmer ?? 255);
      beam.setFocus(point.beam.focus ?? 128);
      beam.setFrost(point.beam.frost ?? false);
      console.log(`[show] point ${n}: revealed (${point.color})`);
      break;
    case 'beamFade':
      console.log(`[show] point ${n}: beam fading out`);
      break;
    case 'video': {
      beam.shutterClose();
      beam.setDimmer(0);
      videoStopped = false;
      const hplayer = point.hplayer ? fixtures[point.hplayer] : null;
      if (hplayer) {
        hplayer.trig(point.video.file ?? 1).catch((err) =>
          console.error(`[show] ${point.hplayer} trig failed: ${err.message}`));
      }
      console.log(`[show] point ${n}: strip '${point.strip}' fading in (${point.color})` +
        (hplayer ? ` + ${point.hplayer} trig ${point.video.file ?? 1}` : ''));
      break;
    }
    case 'gap':
      fixtures[point.strip].off();
      console.log(`[show] point ${n}: gap`);
      break;
    default:
      console.warn(`[show] unknown timeline phase '${step.phase}', skipping`);
      enter((stepIndex + 1) % timeline.length);
  }
}

function advance() {
  const nextStep = stepIndex + 1;
  if (nextStep < timeline.length) {
    enter(nextStep);
  } else {
    pointIndex = (pointIndex + 1) % points.length;
    enter(0);
  }
}

function tick() {
  const step = timeline[stepIndex];
  const t = (Date.now() - stepStart) / 1000;
  const dur = stepSeconds(step) * timeScale;
  const point = targetPoint(step);

  switch (step.phase) {
    case 'disco': {
      const reached = wander && Math.hypot(wander.pan - pos.pan, wander.tilt - pos.tilt) < 5;
      if (!wander || reached || ++wanderAge > config.refreshRate * 1.5) {
        wander = { pan: rand(step.panMin, step.panMax), tilt: rand(step.tiltMin, step.tiltMax) };
        wanderAge = 0;
      }
      // exponential drift toward the target: fast start, organic slowdown
      pos.pan += (wander.pan - pos.pan) * 0.07;
      pos.tilt += (wander.tilt - pos.tilt) * 0.07;
      beam.setPosition(pos.pan, pos.tilt);
      beam.setDimmer(point.beam.dimmer ?? 255);
      // This step's own duration IS point.sound.seconds (see stepSeconds()),
      // so this fires right as the step ends — a safety net in case a tick
      // lands slightly late, not a separate shorter cutoff.
      if (point.sound && !soundStopped) {
        const soundDur = point.sound.seconds * timeScale;
        if (t >= soundDur) {
          soundStopped = true;
          fixtures[point.sound.hplayer].stop().catch(() => {});
        }
      }
      if (t >= dur) advance();
      break;
    }

    case 'focus': {
      const k = Math.min(1, t / dur);
      const ease = 1 - (1 - k) ** 3; // cubic ease-out
      const wobble = Math.sin(k * Math.PI * 4) * (1 - k) * 8; // decaying "almost got it" oscillation
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
      const fadeSeconds = 1.5 * timeScale; // fade in/out edges of the hold
      const k = Math.min(1, t / dur);
      let scale;
      if (t < fadeSeconds) scale = t / fadeSeconds;               // fade in
      else if (dur - t < fadeSeconds) scale = (dur - t) / fadeSeconds; // fade out
      else scale = 1;                                             // steady hold
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

console.log(`[show] starting loop over ${points.length} points, ${timeline.length} steps each` +
  (smokeEnabled ? '' : ' (smoke disabled)') + (timeScale !== 1 ? ' (fast mode)' : ''));
enter(0);
setInterval(tick, 1000 / config.refreshRate);
