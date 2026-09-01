import config from '../config.js';
import { OpenDmxUsb } from './open-dmx-usb.js';
import { RgbwStrip } from './fixtures/rgbw-strip.js';
import { HeroBeam100 } from './fixtures/hero-beam-100.js';
import { PhantomF5 } from './fixtures/phantom-f5.js';
import { HPlayer } from './fixtures/hplayer.js';

// Each factory takes { dmx, def } (`dmx` unused by network fixtures) and
// returns the fixture instance. `def` is the fixture's own config.js entry.
const FIXTURE_TYPES = {
  'rgbw-strip': ({ dmx, def }) => new RgbwStrip(dmx, def.address, { order: def.order }),
  'hero-beam-100': ({ dmx, def }) => new HeroBeam100(dmx, def.address),
  'phantom-f5': ({ dmx, def }) => new PhantomF5(dmx, def.address, { mode: def.mode }),
  hplayer: ({ def }) => new HPlayer(def.host, { port: def.port }),
};

/**
 * Opens the DMX interface and instantiates every fixture from config.js.
 * Returns { dmx, fixtures, config, shutdown }.
 */
export async function setup() {
  const path = config.port === 'auto' ? await OpenDmxUsb.findFtdiPort() : config.port;
  if (!path) {
    throw new Error(
      'No FTDI USB-DMX interface found. Plug in the dongle or set an explicit port in config.js',
    );
  }

  const dmx = new OpenDmxUsb(path, { refreshRate: config.refreshRate, ...config.driver });
  await dmx.open();
  console.log(`[dmx] transmitting on ${path} at ~${config.refreshRate} fps`);

  const fixtures = {};
  for (const [name, def] of Object.entries(config.fixtures)) {
    const factory = FIXTURE_TYPES[def.type];
    if (!factory) throw new Error(`Unknown fixture type '${def.type}' for '${name}'`);
    fixtures[name] = factory({ dmx, def });
    console.log(def.address !== undefined
      ? `[dmx] patched ${name} (${def.type}) at channel ${def.address}`
      : `[net] ${name} (${def.type}) at http://${def.host}:${def.port ?? 8080}`);
  }

  // Blackout, give the last frame time to go out on the wire, then close.
  const shutdown = async () => {
    dmx.blackout();
    await new Promise((resolve) => setTimeout(resolve, 3 * dmx.frameInterval));
    await dmx.close();
  };

  return { dmx, fixtures, config, shutdown };
}

/**
 * Block until every hplayer fixture answers `ping()`. The hplayers are
 * separate Raspberry Pis on the gallery WiFi (see src/fixtures/hplayer.js)
 * — on a cold power-on they boot RastaOS independently of (and generally
 * slower than) the DMX Pi running this app, so without this gate the show
 * can reach a point's `sound`/`video` step before that point's hplayer is
 * listening: the HTTP call fails, gets caught, and the cue is silently
 * skipped for that lap of the timeline.
 *
 * No timeout: waits indefinitely, retrying forever, until every hplayer has
 * responded at least once. Logs which ones are still missing every so often
 * so it's obvious what the process is waiting on.
 *
 * @param {object} fixtures  the `fixtures` map returned by setup()
 * @param {object} [options]
 * @param {number} [options.intervalMs=2000] delay between retry rounds
 */
export async function waitForHplayers(fixtures, { intervalMs = 2000 } = {}) {
  const players = Object.entries(fixtures).filter(([, f]) => f instanceof HPlayer);
  if (players.length === 0) return;

  const pending = new Map(players); // name -> fixture, shrinks as players come up
  console.log(`[boot] waiting for ${pending.size} hplayer(s) to come online...`);

  let round = 0;
  while (pending.size > 0) {
    await Promise.all([...pending].map(([name, hplayer]) =>
      hplayer.ping().then(() => {
        console.log(`[boot] ${name} (${hplayer.host}) is up`);
        pending.delete(name);
      }).catch(() => {}), // still not up — stays in `pending`, retried next round
    ));
    if (pending.size === 0) break;
    round += 1;
    if (round % 15 === 0) { // ~every 30s at the default interval
      console.log(`[boot] still waiting on ${pending.size} hplayer(s): ` +
        `${[...pending.keys()].join(', ')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  console.log('[boot] all hplayers online');
}

/** Install a Ctrl+C / SIGTERM handler that blacks out before exiting. */
export function handleExit(shutdown) {
  let closing = false;
  const onSignal = async () => {
    if (closing) return;
    closing = true;
    console.log('\n[dmx] blackout & exit');
    await shutdown();
    process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}
