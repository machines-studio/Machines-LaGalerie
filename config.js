// ---------------------------------------------------------------------------
// DMX patch & app configuration
//
// This is the single place to adapt when the rig changes: move a fixture to
// another address, add a 4th strip controller, switch the smoke machine to
// 3-channel mode, etc.
// ---------------------------------------------------------------------------

export default {
  // Serial port of the USB->DMX dongle.
  // 'auto' picks the first FTDI device found (vendor id 0403), which is what
  // the common low-cost "Open DMX USB" clones use. Set an explicit path such
  // as '/dev/ttyUSB0' if you have several FTDI devices plugged in.
  port: 'auto',

  // Frames per second sent on the DMX line. An Open DMX frame takes ~25 ms
  // on the wire, so ~30 fps is the practical maximum for a full universe.
  refreshRate: 30,

  // Serial line tuning for the dongle. Some low-cost dongles gate their
  // RS-485 output driver with the RTS or DTR line — if the receivers show
  // "no DMX signal", run `node linetest.js` to find the working combination
  // and put it here.
  // This dongle (FT232R clone) transmits with any RTS/DTR state
  // (linetest.js phases red/green/blue all lit, 2026-08-23) — the initial
  // "no DMX signal" turned out to be the XLR->RJ45 adapter wiring.
  driver: { rts: true, dtr: false, breakMs: 1, mabMs: 1 },

  // HTTP port of the web control panel (panel.js)
  panelPort: 8080,

  fixtures: {
    // Generic 4-channel RGBW decoders driving non-addressable RGBW strips.
    // 'order' describes which output channel is wired to which color.
    // The D5-E units of this rig have red/green swapped vs. their nominal
    // layout, hence GRBW (verified on strip1, 2026-08-23).
    strip1: { type: 'rgbw-strip', address: 10, order: 'GRBW' },
    strip2: { type: 'rgbw-strip', address: 20, order: 'GRBW' },
    strip3: { type: 'rgbw-strip', address: 30, order: 'GRBW' },

    // Cameo Phantom F5 smoke machine.
    // mode '1ch': CH1 = fog output (0-5 off, 6-255 = 1-100 %)
    // mode '3ch': adds CH2 timer interval / CH3 timer duration.
    // The mode must match the 'chnd' setting on the machine's own display.
    smoke: { type: 'phantom-f5', address: 50, mode: '1ch' },

    // Varytec Hero Beam 100 moving head.
    // The fixture must be set to 'DMX 19CH mode' on its display
    // (MODE -> DMX mode -> 19CH); the 6-channel mode has no direct
    // color/gobo control so this app uses the 19-channel layout.
    beam: { type: 'hero-beam-100', address: 100 },
  },

  // -------------------------------------------------------------------------
  // Exhibition show sequence (demo.js):
  //   search -> beam finds point N -> beam fades out -> strip N animates -> next point
  // -------------------------------------------------------------------------
  show: {
    // The three points of interest: which strip lights up there, and where the
    // beam must aim (degrees: pan 0-540, tilt 0-250). Calibrate on site with
    // the web panel (npm run panel) — aim with the sliders, copy the values.
    points: [
      { strip: 'strip1', pan: 200, tilt: 60 },
      { strip: 'strip2', pan: 270, tilt: 45 },
      { strip: 'strip3', pan: 340, tilt: 65 },
    ],

    // Phase 1 — beam wanders "searching" inside this pan/tilt window while
    // the smoke machine runs. Smoke runs for smokeSeconds at the start of the
    // phase (capped by the phase itself), so the cloud can settle before the
    // reveal.
    search: {
      seconds: 12,
      smokePercent: 50,
      smokeSeconds: 6,
      panMin: 160, panMax: 380, tiltMin: 20, tiltMax: 90,
    },

    // Phase 2 — smoke stops, beam locks onto the point...
    focus: { seconds: 3 },

    // ...and lights it up steadily.
    reveal: { seconds: 5, color: 'white' },

    // Phase 3 — beam fades to black, then the point's strip animates.
    beamFade: { seconds: 2 },
    stripShow: { seconds: 20 },
  },
};
