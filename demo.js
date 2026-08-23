// ---------------------------------------------------------------------------
// Exhibition show sequence.
//
// Loops over the points of interest defined in config.js:
//   1. SEARCH    beam wanders randomly ("searching") while the smoke machine runs
//   2. FOCUS     smoke stops, the beam converges on the point and locks on
//   3. REVEAL    the beam lights the point up steadily
//   4. BEAMFADE  the beam fades to black...
//   5. STRIPSHOW ...and the point's RGBW strip plays its animation
//   -> next point, back to 1.
//
// Flags:
//   --no-smoke   never drive the smoke machine (indoor testing)
//   --fast       run all phases at ~1/3 duration (quick testing)
//
// On startup all strips flash R/G/B/W once as a patch self-test.
// ---------------------------------------------------------------------------

import { setup, handleExit } from './src/setup.js';
import { hsvToRgb } from './src/color.js';

const args = process.argv.slice(2);
const smokeEnabled = !args.includes('--no-smoke');
const timeScale = args.includes('--fast') ? 0.3 : 1;

const { fixtures, config, shutdown } = await setup();
handleExit(shutdown);

const show = config.show;
const beam = fixtures.beam;
const smoke = smokeEnabled ? fixtures.smoke : null;
const points = show.points;

const dur = (name) => show[name].seconds * timeScale;
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
let pointIndex = 0;
let phase;
let phaseStart;
const pos = { pan: 270, tilt: 55 }; // beam position we are steering (degrees)
let wander = null;                  // current random search target
let wanderAge = 0;
let focusFrom = null;               // position when the focus phase started

function enter(next) {
  phase = next;
  phaseStart = Date.now();
  const n = pointIndex + 1;
  const point = points[pointIndex];
  switch (next) {
    case 'search': {
      beam.shutterOpen();
      beam.setColor(show.reveal.color);
      const smokeSec = Math.min(show.search.smokeSeconds, show.search.seconds) * timeScale;
      if (smoke) smoke.burst(show.search.smokePercent, smokeSec);
      console.log(`[show] point ${n}: searching...` +
        (smoke ? ` (smoke ${show.search.smokePercent}% for ${smokeSec.toFixed(1)} s)` : ''));
      break;
    }
    case 'focus':
      if (smoke) smoke.off();
      focusFrom = { ...pos };
      console.log(`[show] point ${n}: ${smoke ? 'smoke off, ' : ''}locking onto (pan ${point.pan}°, tilt ${point.tilt}°)`);
      break;
    case 'reveal':
      beam.setPosition(point.pan, point.tilt);
      beam.setDimmer(255);
      console.log(`[show] point ${n}: revealed`);
      break;
    case 'beamFade':
      console.log(`[show] point ${n}: beam fading out`);
      break;
    case 'stripShow':
      beam.shutterClose();
      console.log(`[show] point ${n}: RGBW animation on '${point.strip}'`);
      break;
  }
}

function tick() {
  const t = (Date.now() - phaseStart) / 1000;
  const point = points[pointIndex];

  switch (phase) {
    case 'search': {
      const s = show.search;
      const reached = wander && Math.hypot(wander.pan - pos.pan, wander.tilt - pos.tilt) < 5;
      if (!wander || reached || ++wanderAge > config.refreshRate * 1.5) {
        wander = { pan: rand(s.panMin, s.panMax), tilt: rand(s.tiltMin, s.tiltMax) };
        wanderAge = 0;
      }
      // exponential drift toward the target: fast start, organic slowdown
      pos.pan += (wander.pan - pos.pan) * 0.07;
      pos.tilt += (wander.tilt - pos.tilt) * 0.07;
      beam.setPosition(pos.pan, pos.tilt);
      beam.setDimmer(255);
      if (t >= dur('search')) enter('focus');
      break;
    }

    case 'focus': {
      const k = Math.min(1, t / dur('focus'));
      const ease = 1 - (1 - k) ** 3; // cubic ease-out
      const wobble = Math.sin(k * Math.PI * 4) * (1 - k) * 8; // decaying "almost got it" oscillation
      pos.pan = focusFrom.pan + (point.pan - focusFrom.pan) * ease + wobble;
      pos.tilt = focusFrom.tilt + (point.tilt - focusFrom.tilt) * ease + wobble * 0.4;
      beam.setPosition(pos.pan, pos.tilt);
      if (k >= 1) enter('reveal');
      break;
    }

    case 'reveal': {
      if (t >= dur('reveal')) enter('beamFade');
      break;
    }

    case 'beamFade': {
      const k = Math.min(1, t / dur('beamFade'));
      beam.setDimmer(Math.round(255 * (1 - k)));
      if (k >= 1) enter('stripShow');
      break;
    }

    case 'stripShow': {
      const strip = fixtures[point.strip];
      const f = Math.min(1, t / dur('stripShow'));
      if (f < 0.3) {
        // solid primaries: red, green, blue
        const step = Math.min(2, Math.floor((f / 0.3) * 3));
        const [r, g, b] = [[255, 0, 0], [0, 255, 0], [0, 0, 255]][step];
        strip.setColor(r, g, b, 0);
      } else if (f < 0.7) {
        // rainbow sweep, two full hue cycles
        const { r, g, b } = hsvToRgb(((f - 0.3) / 0.4) * 2, 1, 1);
        strip.setColor(r, g, b, 0);
      } else if (f < 0.95) {
        // white channel breathing
        const breathe = 0.5 - 0.5 * Math.cos(((f - 0.7) / 0.25) * Math.PI * 4);
        strip.setColor(0, 0, 0, Math.round(40 + 215 * breathe));
      } else {
        // fade to black
        strip.setColor(0, 0, 0, Math.round(40 * (1 - (f - 0.95) / 0.05)));
      }
      if (f >= 1) {
        strip.off();
        pointIndex = (pointIndex + 1) % points.length;
        enter('search');
      }
      break;
    }
  }
}

console.log(`[show] starting loop over ${points.length} points` +
  (smokeEnabled ? '' : ' (smoke disabled)') + (timeScale !== 1 ? ' (fast mode)' : ''));
enter('search');
setInterval(tick, 1000 / config.refreshRate);
