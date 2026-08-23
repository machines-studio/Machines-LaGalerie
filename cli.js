// ---------------------------------------------------------------------------
// Raw channel CLI — the most direct way to test a DMX device.
//
//   node cli.js 10=255 11=128 13=40    set channels, keeps transmitting (Ctrl+C to quit)
//   node cli.js blackout               everything to 0
//
// Open DMX needs a continuous frame stream, so the process keeps running
// until you stop it. On Ctrl+C everything is blacked out before exit.
// ---------------------------------------------------------------------------

import { setup, handleExit } from './src/setup.js';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('usage: node cli.js <channel>=<value> [...]   |   node cli.js blackout');
  process.exit(1);
}

const { dmx, shutdown } = await setup();
handleExit(shutdown);

if (args[0] === 'blackout') {
  dmx.blackout();
  console.log('[cli] all channels set to 0 — Ctrl+C to quit');
} else {
  for (const arg of args) {
    const match = arg.match(/^(\d+)=(\d+)$/);
    if (!match) {
      console.error(`[cli] cannot parse '${arg}' (expected channel=value)`);
      process.exit(1);
    }
    dmx.set(Number(match[1]), Number(match[2]));
    console.log(`[cli] channel ${match[1]} = ${match[2]}`);
  }
  console.log('[cli] transmitting — Ctrl+C to quit (blacks out on exit)');
}
