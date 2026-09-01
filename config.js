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

    // HPlayer2 video players (RastaOS, Machines expo 2026). Not DMX: each
    // is a standalone Raspberry Pi on the gallery WiFi (SSID 'Machines'),
    // controlled over plain HTTP (no `address` — networked, not patched).
    // See https://37m.gr/misc/RastaOS-7.2-Machines26-guide.html
    //
    // *** PLACEHOLDER IPs — replace with the real addresses once on site
    // *** (check the WiFi router's DHCP leases, or each player's own display).
    hplayer1: { type: 'hplayer', host: '10.0.0.101' },
    hplayer2: { type: 'hplayer', host: '10.0.0.102' },
    hplayer3: { type: 'hplayer', host: '10.0.0.103' },
  },

  // -------------------------------------------------------------------------
  // Exhibition show sequence (demo.js and gallery.js both run this).
  //
  // `show.timeline` is the sequence of phases run for ONE point, top to
  // bottom, in the exact order they play — read it like a cue sheet. Once
  // the last step finishes, the runner moves to the next point in
  // `show.points` and replays the same timeline from the top; after the
  // last point it loops back to the first.
  //
  // Each step is `{ phase, seconds, ...params }`. `seconds` is that step's
  // own duration — change one number to retime one step, nothing else
  // needs touching. A step with no `seconds` (video) instead derives
  // its hold time from the current point (see below).
  // `--fast` (both demo.js and gallery.js) scales every `seconds` by 0.3
  // for quick tests.
  // -------------------------------------------------------------------------
  show: {
    // The three points of interest: which strip/hplayer live there, the
    // color used for the search/focus/reveal beam AND the strip fade-in
    // (see STRIP_COLORS in src/fixtures/rgbw-strip.js and BEAM_COLORS in
    // src/fixtures/hero-beam-100.js — must be a name valid in both), where
    // the beam must aim (degrees: pan 0-540, tilt 0-250), and its video.
    //   video    { file, seconds } for the timeline's 'video' step.
    //            `file` is passed straight to hplayer.trig(file) — matches
    //            the N in that player's N_*.mp4; defaults to 1 if omitted,
    //            so only needs setting when a player has more than one clip
    //            (e.g. its video AND a sound file living on the same
    //            hplayer). `seconds` is that clip's own runtime — keep it
    //            matched to the actual length of the triggered file, it's
    //            the single source of truth for "how long is the video" and
    //            drives the 'video' step's hold time.
    //   sound    optional pre-roll played on the timeline's 'sound' step,
    //            right after the beam fades and before the video starts:
    //            { hplayer, file, seconds }, same shape as `video` above
    //            plus its own `hplayer` (may differ from the point's own,
    //            e.g. routed to a center speaker). `seconds` is how long the
    //            sound step holds (should match that clip's length). Omit
    //            the whole field to skip the sound step for that point (it
    //            becomes an instant no-op).
    // Calibrate pan/tilt on site with the web panel (npm run panel) — aim
    // with the sliders, copy the values here.
    points: [
      {
        strip: 'strip1',
        hplayer: 'hplayer1',
        color: 'white',
        pan: 200,
        tilt: 60,
        video: { file: 1, seconds: 90 },
        sound: { hplayer: 'hplayer2', file: 1, seconds: 8 },
      },
      {
        strip: 'strip2',
        hplayer: 'hplayer2',
        color: 'red',
        pan: 270,
        tilt: 45,
        video: { file: 1, seconds: 90 },
        sound: { hplayer: 'hplayer2', file: 2, seconds: 8 },
      },
      {
        strip: 'strip3',
        hplayer: 'hplayer3',
        color: 'green',
        pan: 340,
        tilt: 65,
        video: { file: 1, seconds: 90 },
        sound: { hplayer: 'hplayer2', file: 3, seconds: 8 },
      },
    ],

    // The cue sheet — one full pass, per point, in order:
    timeline: [
      // 1. beam wanders inside the pan/tilt window below, colored for the
      //    point about to be found, while the smoke machine runs briefly:
      //    smoke fires for smokeSeconds then stops on its own (capped by
      //    this step's `seconds`) — it does not run for the whole step.
      {
        phase: 'search', seconds: 12,
        smokePercent: 50, smokeSeconds: 6,
        panMin: 160, panMax: 380, tiltMin: 20, tiltMax: 90,
      },

      // 2. smoke stops (if still running), beam converges onto the point's
      //    pan/tilt (still that point's color).
      { phase: 'focus', seconds: 3 },

      // 3. beam holds steady on the point before fading out.
      { phase: 'reveal', seconds: 3 },

      // 4. beam fades to black. Only once this completes do the strip and
      //    hplayer start (sequential, no overlap).
      { phase: 'beamFade', seconds: 2 },

      // 4b. sound pre-roll: if the current point has a `sound` field, trig
      //     that clip on its hplayer and hold for `sound.seconds` before the
      //     video starts. Points with no `sound` field skip this step
      //     instantly (seconds 0).
      { phase: 'sound' },

      // 5. strip fades in (point color) + hplayer trigs points[].video.file,
      //    together. Holds for the point's video length (points[].video.seconds)
      //    plus this artist-tunable buffer, then the strip fades out. No
      //    `seconds` here on purpose — total hold time is
      //    points[].video.seconds + extraSeconds.
      { phase: 'video', extraSeconds: 5 },

      // 6. everything off for a beat before the next point begins.
      { phase: 'gap', seconds: 5 },
    ],
  },
};
