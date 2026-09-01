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

import { setup, handleExit } from './src/setup.js';

const args = process.argv.slice(2);
const smokeEnabled = !args.includes('--no-smoke');
const timeScale = args.includes('--fast') ? 0.3 : 1;

const { fixtures, config, shutdown } = await setup();
handleExit(shutdown);

const show = config.show;
const beam = fixtures.beam;
const smoke = smokeEnabled ? fixtures.smoke : null;
const points = show.points;
const timeline = show.timeline;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (min, max) => min + Math.random() * (max - min);

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

// The point whose color/hplayer/strip is "active" for a given step. During
// 'search' the beam previews the UPCOMING point's color, so that step looks
// one point ahead; every other step targets the current point.
function targetPoint(step) {
  if (step.phase === 'search') return points[(pointIndex + 1) % points.length];
  return points[pointIndex];
}

function stepSeconds(step) {
  if (step.phase === 'video') return points[pointIndex].video.seconds + step.extraSeconds;
  if (step.phase === 'sound') return points[pointIndex].sound?.seconds ?? 0;
  return step.seconds;
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
      if (smoke) smoke.burst(step.smokePercent, smokeSec);
      const nextN = (pointIndex + 1) % points.length + 1;
      console.log(`[show] point ${n}: searching for point ${nextN} (${point.color})...` +
        (smoke ? ` (smoke ${step.smokePercent}% for ${smokeSec.toFixed(1)} s)` : ''));
      break;
    }
    case 'focus':
      if (smoke) smoke.off();
      focusFrom = { ...pos };
      console.log(`[show] point ${n}: locking onto (pan ${point.pan}°, tilt ${point.tilt}°)`);
      break;
    case 'reveal':
      beam.setPosition(point.pan, point.tilt);
      beam.setDimmer(255);
      console.log(`[show] point ${n}: revealed (${point.color})`);
      break;
    case 'beamFade':
      console.log(`[show] point ${n}: beam fading out`);
      break;
    case 'sound': {
      const sound = point.sound;
      if (sound) {
        const hplayer = fixtures[sound.hplayer];
        hplayer.trig(sound.file).catch((err) =>
          console.error(`[show] ${sound.hplayer} sound trig failed: ${err.message}`));
        console.log(`[show] point ${n}: sound ${sound.file} on ${sound.hplayer}`);
      }
      break;
    }
    case 'video': {
      beam.shutterClose();
      beam.setDimmer(0);
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
    case 'search': {
      const reached = wander && Math.hypot(wander.pan - pos.pan, wander.tilt - pos.tilt) < 5;
      if (!wander || reached || ++wanderAge > config.refreshRate * 1.5) {
        wander = { pan: rand(step.panMin, step.panMax), tilt: rand(step.tiltMin, step.tiltMax) };
        wanderAge = 0;
      }
      // exponential drift toward the target: fast start, organic slowdown
      pos.pan += (wander.pan - pos.pan) * 0.07;
      pos.tilt += (wander.tilt - pos.tilt) * 0.07;
      beam.setPosition(pos.pan, pos.tilt);
      beam.setDimmer(255);
      if (t >= dur) advance();
      break;
    }

    case 'focus': {
      const k = Math.min(1, t / dur);
      const ease = 1 - (1 - k) ** 3; // cubic ease-out
      const wobble = Math.sin(k * Math.PI * 4) * (1 - k) * 8; // decaying "almost got it" oscillation
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
      const fadeSeconds = 1.5 * timeScale; // fade in/out edges of the hold
      const k = Math.min(1, t / dur);
      let scale;
      if (t < fadeSeconds) scale = t / fadeSeconds;               // fade in
      else if (dur - t < fadeSeconds) scale = (dur - t) / fadeSeconds; // fade out
      else scale = 1;                                             // steady hold
      strip.setNamedColor(point.color, Math.max(0, Math.min(1, scale)));
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
