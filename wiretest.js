// ---------------------------------------------------------------------------
// Physical line debugging with a multimeter.
//
// Holds the DMX line IDLE (steady mark, no data) so a multimeter shows a
// stable DC voltage, while cycling the four RTS/DTR combinations (10 s each)
// in case the dongle gates its RS-485 driver with one of them.
//
// Measure DC voltage:
//   red probe  -> Data+  (XLR pin 3, or RJ45 pin 1)
//   black probe-> Data-  (XLR pin 2, or RJ45 pin 2)
//
//   +2 to +5 V steady  -> output OK in this combo; note the combo, measure
//                         further down the chain (adapter, cable, decoder in)
//   -2 to -5 V steady  -> Data+/Data- swapped at the point you measure
//   ~0 V in all combos -> no RS-485 output (dead dongle) or wrong pins
//
// Also useful (idle line, vs XLR pin 1 / RJ45 pin 7-8 ground):
//   Data+ to GND ~ 3-5 V and Data- to GND ~ 0-1.5 V when everything is fine.
// ---------------------------------------------------------------------------

import { SerialPort } from 'serialport';
import config from './config.js';
import { OpenDmxUsb } from './src/open-dmx-usb.js';

const path = config.port === 'auto' ? await OpenDmxUsb.findFtdiPort() : config.port;
if (!path) throw new Error('No FTDI USB-DMX interface found');

const port = new SerialPort({
  path, baudRate: 250000, dataBits: 8, stopBits: 2, parity: 'none', autoOpen: false,
});
await new Promise((resolve, reject) => port.open((e) => (e ? reject(e) : resolve())));

const COMBOS = [
  { rts: true, dtr: true },
  { rts: true, dtr: false },
  { rts: false, dtr: true },
  { rts: false, dtr: false },
];

console.log(`[wiretest] line held IDLE on ${path} — no data, stable voltages`);
console.log('[wiretest] measure DC: red probe on Data+ (XLR 3 / RJ45 1), black on Data- (XLR 2 / RJ45 2)');
console.log('[wiretest] expect +2..+5 V | negative = polarity swapped | ~0 V everywhere = no output\n');

let stop = false;
process.on('SIGINT', () => { stop = true; });

while (!stop) {
  for (const combo of COMBOS) {
    if (stop) break;
    await new Promise((resolve) => port.set({ ...combo, brk: false }, resolve));
    console.log(`[wiretest] RTS=${combo.rts ? 'ON ' : 'off'}  DTR=${combo.dtr ? 'ON ' : 'off'}  — measure now (10 s)`);
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}

console.log('\n[wiretest] done. If a combo showed voltage, put it into config.js -> driver.');
await new Promise((resolve) => port.close(resolve));
process.exit(0);
