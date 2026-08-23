# La Galerie — DMX demo / test app

Node.js demo app driving the exhibition rig over a low-cost USB→DMX dongle
(Enttec **Open DMX USB** protocol — any FTDI FT232R-based clone). It is meant
as a working example to test the rig and to build the final installation upon.

## Quick start

```sh
git clone git@github.com:Hemisphere-Project/Machines-LaGalerie.git
cd Machines-LaGalerie
npm install                  # single dependency (serialport), RPi-ready

# plug the USB-DMX dongle, then:
npm run demo                 # the show — all strips flash R/G/B/W at startup
npm run panel                # manual faders on http://<host>:8080
node cli.js 10=255           # or drive raw channels directly
```

If the decoders show "no DMX signal", jump to [Troubleshooting](#troubleshooting).

## The rig

| Fixture                       | DMX address | Channels | Notes                              |
|-------------------------------|-------------|----------|------------------------------------|
| RGBW strip controller 1       | 10          | 10–13    | generic 4-ch decoder, R G B W      |
| RGBW strip controller 2       | 20          | 20–23    | generic 4-ch decoder, R G B W      |
| RGBW strip controller 3       | 30          | 30–33    | generic 4-ch decoder, R G B W      |
| Cameo Phantom F5 (smoke)      | 50          | 50       | 1-ch DMX mode (`3ch` supported)    |
| Varytec Hero Beam 100         | 100         | 100–118  | **19-ch DMX mode required**        |

Everything above lives in [`config.js`](config.js) — addresses, channel order
of the strip decoders, smoke mode, show timings and the three points of
interest. That file is the only place to touch when the rig changes.

### Fixture-side settings (on each device's own menu)

- **Strip decoders**: DMX address 10 / 20 / 30, 4-channel RGBW mode.
- **Phantom F5**: address 50, `chnd` (channel mode) = `1ch`.
  In 1-ch mode CH1 is fog output: 0–5 = off, 6–255 = 1–100 %. The machine
  ignores DMX while its heater is warming up.
- **Hero Beam 100**: `DMX Address` = 100, `DMX mode` = `DMX 19CH mode`.
  The 6-channel mode has no direct color/gobo control, so this app uses the
  19-channel layout (pan/tilt 16-bit, dimmer, shutter/strobe, color wheel,
  gobos, focus, prisms — see `src/fixtures/hero-beam-100.js`).

## Install & run

```sh
npm install          # only dependency: serialport (prebuilt binaries, incl. Raspberry Pi)

npm run demo         # the exhibition show sequence (see below)
npm run panel        # web control panel on http://<host>:8080
node cli.js 10=255   # set raw channels directly (Ctrl+C to quit)
```

The dongle is auto-detected (first FTDI device). With several FTDI devices
plugged in, set `port: '/dev/ttyUSB0'` explicitly in `config.js`.

## The show (`npm run demo`)

Loops over the three points of interest:

1. **search** — the beam wanders randomly like it is looking for something,
   while the smoke machine runs (`smokeSeconds` of smoke at `smokePercent`,
   at the start of the phase).
2. **focus / reveal** — smoke stops, the beam converges on the point
   (with a little decaying "almost found it" wobble) and lights it up.
3. **beam fade + strip show** — the beam fades to black and the point's RGBW
   strip plays an animation (primaries → rainbow → white breathing → fade).
4. Next point, back to 1.

Flags:

```sh
npm run demo -- --no-smoke   # never drive the smoke machine (indoor testing)
npm run demo -- --fast       # ~1/3 phase durations, for quick testing
```

On startup all three strips flash red / green / blue / white once — a quick
visual check that the strip decoders are patched correctly.

Ctrl+C blacks out everything before exiting.

### Aiming the beam at the points of interest

The pan/tilt of each point is in `config.js` (`show.points`) in degrees.
To calibrate on site: `npm run panel`, open the panel, aim the beam with the
pan/tilt sliders, then copy the degree values into `config.js`.

## Web panel (`npm run panel`)

Manual control of everything: RGBW sliders + presets per strip, beam
pan/tilt/dimmer/focus/color/gobo/prism, smoke output + timed bursts, a raw
channel fader for unpatched gear, and a global blackout. Reachable from any
device on the network — handy when the Pi is headless.

Note: demo, panel and cli each open the serial port exclusively — run one at
a time.

## Code layout

```
config.js                    the DMX patch + show parameters (edit this)
src/open-dmx-usb.js          Open DMX USB driver (break + 250 kbaud frames, ~30 fps)
src/fixtures/rgbw-strip.js   generic 4-ch RGBW decoder
src/fixtures/hero-beam-100.js  Varytec Hero Beam 100, 19-ch mode, from the official manual
src/fixtures/phantom-f5.js   Cameo Phantom F5, 1-ch / 3-ch modes, from the official manual
src/setup.js                 opens the port, builds fixtures from config, clean shutdown
demo.js                      the exhibition show sequence (state machine)
panel.js + public/index.html web control panel (dependency-free, node:http)
cli.js                       raw channel setter
```

To build the final installation: keep `src/` as-is, copy `demo.js` and adapt
the state machine — all fixture APIs are documented in their source files.

A minimal custom program looks like this:

```js
import { setup, handleExit } from './src/setup.js';

const { dmx, fixtures, shutdown } = await setup(); // opens the dongle, patches config.js
handleExit(shutdown);                              // Ctrl+C -> blackout -> exit

fixtures.strip1.setColor(255, 0, 80, 0);           // r, g, b, w (0-255)
fixtures.beam.setPosition(270, 40);                // pan, tilt in degrees
fixtures.beam.setDimmer(255);
fixtures.beam.setColor('blue');                    // color wheel by name
fixtures.smoke.burst(60, 2);                       // 60 % fog for 2 s
dmx.set(400, 128);                                 // any raw channel too

// the driver keeps transmitting the current frame ~30x/s until the process exits
```

## Raspberry Pi 3B+ notes

- Works as-is on Raspberry Pi OS: `serialport` ships prebuilt ARM binaries,
  and the pi user is in the `dialout` group by default (needed for
  `/dev/ttyUSB0`; otherwise `sudo usermod -aG dialout $USER` + re-login).
- Install a recent Node (e.g. Node 20 from nodesource) — the OS packages can
  be very old.
- To start the show on boot, a minimal systemd unit works well:

  ```ini
  # /etc/systemd/system/lagalerie-dmx.service
  [Unit]
  Description=La Galerie DMX show
  After=multi-user.target

  [Service]
  WorkingDirectory=/home/pi/Machines-LaGalerie
  ExecStart=/usr/bin/node demo.js
  Restart=on-failure
  User=pi

  [Install]
  WantedBy=multi-user.target
  ```

## Troubleshooting

- **Decoder shows "no DMX signal"** (e.g. the D5-E display blinking between
  the address and `---`): run `node linetest.js`. It cycles through the
  plausible RTS/DTR/break-timing combinations, each with a different solid
  color on the strips — when the decoder wakes up, note the color and copy
  that phase's settings into `config.js` → `driver`. If no phase ever works
  the problem is in the wiring: check the XLR→RJ45 adapter
  (D5-E RJ45 pin 1 = Data+, pin 2 = Data−, pins 7/8 = GND; XLR pin 3 = Data+,
  pin 2 = Data−) and try swapping Data+/Data−. `node wiretest.js` holds the
  line idle and cycles RTS/DTR so you can chase the signal with a multimeter
  (instructions in the file header) — cheap dongles are also known for
  swapped XLR pins 2/3 or a dead RS-485 stage.
- **D5-E strip decoders**: 5-channel devices (R,G,B,W1,W2 — this app drives
  the first four). Keep them in 8-bit mode (`b08`); in 16-bit mode every
  color occupies two channels and the mapping shifts.
- **Nothing lights up (signal OK)**: check the decoder's address/mode, and
  that only one of demo/panel/cli is running.
- **`Permission denied /dev/ttyUSB0`**: user not in `dialout` (see above).
- **Flicker**: keep the DMX line terminated (120 Ω across pins 2–3 on the
  last device) and avoid very long unterminated stubs. Open DMX timing is
  host-driven, so a heavily loaded CPU can also cause jitter.
- **Output freezes at the last frame after quitting**: that is DMX — most
  receivers hold the last received values. The apps black out before exiting
  for that reason (Ctrl+C, not `kill -9`).

## License

GPL-3.0 — © Hemisphere-Project
