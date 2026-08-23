// ---------------------------------------------------------------------------
// Serial line configuration finder.
//
// Cycles through the plausible RTS/DTR/timing combinations for Open DMX
// clone dongles, ~15 s each, sending a DIFFERENT solid color to the strip
// decoders in each phase.
//
// Watch the decoder: when its display stops blinking (steady address, DMX
// detected) and the strip lights up, note the COLOR shown, Ctrl+C, and put
// that phase's settings into config.js -> driver.
//
// If NO phase ever works, the problem is not software: check the XLR/RJ45
// adapter wiring (D5-E RJ45: pin 1 = Data+, pin 2 = Data-, 7/8 = GND;
// XLR: pin 3 = Data+, pin 2 = Data-) and try swapping Data+/Data-.
// ---------------------------------------------------------------------------

import config from './config.js';
import { OpenDmxUsb } from './src/open-dmx-usb.js';

const PHASE_SECONDS = 15;

const PHASES = [
  { color: 'RED',    rgbw: [255, 0, 0, 0],   options: { rts: true,  dtr: true,  breakMs: 1,  mabMs: 1 } },
  { color: 'GREEN',  rgbw: [0, 255, 0, 0],   options: { rts: true,  dtr: false, breakMs: 1,  mabMs: 1 } },
  { color: 'BLUE',   rgbw: [0, 0, 255, 0],   options: { rts: false, dtr: false, breakMs: 1,  mabMs: 1 } },
  { color: 'YELLOW', rgbw: [255, 255, 0, 0], options: { rts: true,  dtr: true,  breakMs: 10, mabMs: 3, refreshRate: 20 } },
  { color: 'WHITE',  rgbw: [0, 0, 0, 255],   options: { rts: false, dtr: true,  breakMs: 10, mabMs: 3, refreshRate: 20 } },
];

const stripAddresses = Object.values(config.fixtures)
  .filter((f) => f.type === 'rgbw-strip')
  .map((f) => f.address);

const path = config.port === 'auto' ? await OpenDmxUsb.findFtdiPort() : config.port;
if (!path) throw new Error('No FTDI USB-DMX interface found');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`[linetest] dongle on ${path} — strips at ${stripAddresses.join(', ')}`);
console.log('[linetest] watch the decoder: when the display stops blinking and the strip');
console.log('[linetest] lights up, note the COLOR and press Ctrl+C. Cycling forever...\n');

let stop = false;
process.on('SIGINT', () => { stop = true; });

while (!stop) {
  for (const [i, phase] of PHASES.entries()) {
    if (stop) break;
    const o = { refreshRate: 30, ...phase.options };
    console.log(
      `[linetest] phase ${i + 1}/${PHASES.length} — ${phase.color.padEnd(6)} ` +
      `(rts=${o.rts}, dtr=${o.dtr}, break=${o.breakMs}ms, mab=${o.mabMs}ms, ${o.refreshRate}fps) ` +
      `for ${PHASE_SECONDS}s`,
    );
    const dmx = new OpenDmxUsb(path, o);
    await dmx.open();
    for (const address of stripAddresses) {
      phase.rgbw.forEach((value, offset) => dmx.set(address + offset, value));
    }
    await sleep(PHASE_SECONDS * 1000);
    await dmx.close();
    await sleep(300); // let the port settle before reopening
  }
}

console.log('\n[linetest] stopped. Put the working phase settings into config.js -> driver.');
process.exit(0);
