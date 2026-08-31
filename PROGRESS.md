# Session progress notes — hplayer integration + gallery UI

**Context:** worked from home 2026-08-31, no FTDI USB-DMX dongle available
(`setup.js` throws `No FTDI USB-DMX interface found` when run — expected,
cannot be fixed without hardware). Everything below was verified as far as
possible **without hardware** (see "Offline testing" below) but is
**UNTESTED on the real rig / real hplayers**. Tomorrow at the gallery: plug
in the dongle, join the `Machines` WiFi, get the 3 hplayer IPs, and validate
end-to-end — see the checklist at the bottom.

Not committed to git (per instructions) — review with `git diff` /
`git status` before committing. New untracked files: `PROGRESS.md`,
`gallery.js`, `public/gallery.html`, `src/fixtures/hplayer.js`.

---

## What was built (3 parts asked for)

1. **hplayer fixture support** — `src/fixtures/hplayer.js`, a new
   network-controlled (HTTP, not DMX) fixture type, patched into
   `config.js` `fixtures` (same namespace as strips/beam/smoke) as
   `hplayer1`/`hplayer2`/`hplayer3`, `type: 'hplayer'`, `host: '<ip>'`.
2. **Gallery-facing controls** — new `gallery.js` + `public/gallery.html`:
   per-point "Focus" (hard-cut takeover), one master volume slider for all
   3 hplayers (persisted to disk), fog machine on/off.
3. **Timeline readability** — `config.js` `show.timeline`: an ordered
   array read top-to-bottom as a literal cue sheet, replacing the old
   unordered `show.search` / `show.focus` / ... object. `demo.js` and
   `gallery.js` both walk it generically.

---

## Key design decisions (confirmed with user during the session)

- **HPlayer control: HTTP only** (plain GET, port 8080), no OSC. Uses
  Node's built-in global `fetch` — no new dependency.
- **Addressing:** static IPs, in `config.js` `fixtures` (NOT a separate
  `hplayers:` section — kept in the same namespace/shape as DMX fixtures,
  `type: 'hplayer'` distinguishes them; `src/setup.js` special-cases
  fixtures with no DMX `address`).
- **Each hplayer has exactly one clip on its USB stick** → always
  `trig(1)`, no per-point sequence number needed.
- **Show timeline** (see next section) confirmed in detail with the user,
  including per-point search-phase color preview and sequential
  (non-overlapping) beam-fade → strip/video start.
- **`show.timeline` is an ordered array**, not a bag of named phase
  objects — chronology should be readable top-to-bottom without
  reassembling it mentally. `demo.js`/`gallery.js` walk it by index;
  retiming = change one `seconds` value in `config.js`, no code change.
- **Named colors shared by beam and strip:** point `color` is a single
  name (`'white'|'red'|'green'`, extensible), used for both the beam's
  color wheel (existing `BEAM_COLORS` in hero-beam-100.js, untouched) and
  the strip (new `STRIP_COLORS` + `RgbwStrip.setNamedColor(name, scale)`
  in rgbw-strip.js, `scale` 0-1 for fade in/out).
- **`gallery.js` is a NEW file**, not a panel.js patch. demo.js and
  panel.js each open the serial port exclusively and neither has both a
  live show loop AND an HTTP server — gallery.js combines both. `demo.js`
  stays as the plain reference/testing sequence (`--fast`/`--no-smoke`,
  no UI). `panel.js` stays the full manual-control/calibration tool.
  `gallery.js` is what should actually run in production (systemd unit
  in README updated to point at it).
- **Volume is a single master control**, not per-hplayer — one slider
  in the gallery UI sets the same volume on all 3 players at once.
  Persisted to `gallery-state.json` (gitignored, next to the app) so it
  survives a power cycle, not just a process restart. Re-applied to a
  player right after every `trig`, in case the player itself resets
  volume on its own boot/idle cycle.
- **"Focus" button = hard-cut takeover:** abandon whatever step is
  currently playing (best-effort `stop()` on every hplayer), force beam
  to blackout, jump straight to the requested point's `beamFade` step
  (skips search/focus/reveal — visitor wants to see it now). Normal
  looping resumes from the next point afterwards. Works even if the
  request lands mid-step (checked every tick, not just at step
  boundaries), so it doesn't wait out a 90 s video.
- **Fog toggle = master enable/disable** of the automatic search-phase
  smoke bursts (equivalent to demo.js's `--no-smoke`, but live). No
  separate manual "puff now" button in the gallery UI. **Also persisted**
  to `gallery-state.json` (same file/mechanism as volume, added after
  initial review) — survives a power cycle. `--no-smoke` only seeds the
  very first run, before the state file exists; once toggled once from
  the UI, the persisted value wins on every future restart regardless of
  the flag.

---

## The confirmed show timeline (config.js `show.timeline`)

One pass, per point, top to bottom, then loop to the next point (last
point loops back to the first):

1. **search** — beam wanders inside a pan/tilt window, colored for the
   **upcoming** point (preview — e.g. searching before point 2 shows a red
   beam). Smoke fires briefly at the very start (`smokeSeconds`, capped by
   the step's own `seconds`), not for the whole step.
2. **focus** — beam converges onto the current point's pan/tilt, same
   point's color.
3. **reveal** — beam holds steady on the point.
4. **beamFade** — beam fades to black. Strip/hplayer do NOT start until
   this completes (sequential, no overlap, per user decision).
5. **stripShow** — strip fades in to the point's color AND that point's
   hplayer fires `trig(1)`, together, right after beamFade. Holds for
   `points[].seconds` (the video's own runtime — keep matched to the
   actual clip length) **plus** `stripShow.extraSeconds` (one shared
   artist-tunable buffer, not per-point). Then strip fades out.
6. **gap** — everything off for a beat (`gap.seconds`).
7. → next point.

Points as configured: point1 = strip1/hplayer1/white, point2 =
strip2/hplayer2/red, point3 = strip3/hplayer3/green. All placeholder
`seconds: 90` for video length — **replace with real clip durations**.

---

## HPlayer2 / RastaOS reference
(from https://37m.gr/misc/RastaOS-7.2-Machines26-guide.html)

- 3 standalone Raspberry Pi video players, idle-loop + triggered sequences.
- **HTTP API, port 8080**: plain GET, e.g. `GET http://<ip>:8080/trig/1`
  plays sequence `1_*`.
- OSC also exists (UDP 4000) but **not used** here per decision above.
- Commands implemented in `src/fixtures/hplayer.js`: `trig N`, `play
  [file]`, `stop`, `pause`, `resume`, `volume 0-100`, `mute`, `unmute`,
  `status`, `ping`. (`mute`/`unmute` exist on the class for completeness/
  the guide's documented API, but the gallery UI only uses `volume`.)
- Media naming: `0_xxxx.mp4` = idle loop, `1_xxxx.mp4` = the one triggered
  clip on each of these players, back to idle after playing.
- Network: joins WiFi SSID `Machines` psk `*Machines26*`, DHCP. Ethernet
  fallback exists. **We don't know the 3 players' real IPs yet** — get
  them on-site.

---

## Offline testing done tonight (no hardware, no gallery network)

Verified without touching real hardware:
- `node --check` on every new/changed file — all parse cleanly.
- Ran `gallery.js`/`demo.js` for real with `serialport`'s built-in
  `SerialPortMock` (via a temporary Node ESM loader hook, not committed)
  standing in for the FTDI dongle, and a mocked `global.fetch` standing in
  for the hplayers' HTTP endpoints. Confirmed via logs:
  - Full startup sequence (strip self-test, fixture patching incl. the 3
    hplayers, master volume 80 applied to all 3 on boot).
  - Timeline walks search → focus → reveal → beamFade → stripShow → gap
    correctly, search phase previews the upcoming point's color, loops to
    the next point.
  - `POST /api/volume` updates all 3 hplayers' volume live and is
    reflected in `GET /api/state`.
  - `POST /api/focus` hard-cuts mid-step: stopped all hplayers, jumped
    straight to the requested point's `beamFade`→`stripShow`, correct
    point/phase in `/api/state` afterwards.
  - Restarting the process picks **both persisted volume AND fog
    enabled/disabled** back up from `gallery-state.json` (simulates
    surviving a power cycle) instead of resetting to the defaults —
    re-verified after moving `smokeEnabled` into the same persisted
    `state` object as volume (`{"volume":42,"smokeEnabled":false}` on
    disk, correctly reflected in `/api/state` after a fresh process start).
  - `POST /api/fog` toggles `smokeEnabled` live and persists it.
- Unit-checked `config.js` shape (every point's color valid in both
  `STRIP_COLORS` and `BEAM_COLORS`, every point references a real strip/
  hplayer fixture, timeline has the expected steps) and
  `RgbwStrip.setNamedColor()` (correct channel values, scale, throws on
  unknown color) and `HPlayer`'s HTTP call shapes/clamping/error handling.

**Not tested and can't be from home:** the real FTDI dongle, the real DMX
fixtures reacting to signal, the real hplayers' actual HTTP responses
(status codes/body shapes are assumed from the guide, not observed), WiFi
reliability for "live" control, and the systemd unit.

---

## Status: code complete, offline-verified — real-hardware validation pending

Everything below was written and works as far as it's possible to check
without the dongle/hplayers/gallery network (see "Offline testing" above,
all of which passed). None of it has touched real hardware yet — that's
tomorrow's job, not tonight's, so this checklist is still all open:

- [x] `src/fixtures/hplayer.js` written + offline-verified (HTTP call
      shapes, clamping, error handling on mocked `fetch`).
- [x] `config.js` — hplayers patched into `fixtures`, points wired to
      strip/hplayer/color, `show.timeline` restructured as an ordered
      cue sheet. Shape-checked (colors valid in both color tables, every
      point references a real fixture).
- [x] `demo.js` rewritten to walk `show.timeline` generically; offline
      run confirms the full search→focus→reveal→beamFade→stripShow→gap
      sequence and point-to-point looping.
- [x] `gallery.js` + `public/gallery.html` built: Focus (hard-cut
      takeover), master Volume, Fog toggle, both Volume and Fog persisted
      to `gallery-state.json`. Offline-verified end-to-end, including
      surviving a simulated process restart with persisted state intact.
- [x] `README.md` updated (rig table, hplayer section, show timeline,
      Gallery UI section, code layout, systemd unit pointing at
      `gallery.js`).
- [ ] Plug in the FTDI USB-DMX dongle, confirm `setup.js` finds it
      (`npm run demo` or `npm run gallery` should get past the "No FTDI
      USB-DMX interface found" error immediately). **Cannot be done from
      home — needs the dongle.**
- [ ] Join the gallery WiFi (`Machines`), find the 3 hplayers' real IPs
      (router DHCP leases, or each player's own display/status), replace
      the placeholder `10.0.0.10x` addresses in `config.js` `fixtures`
      (`hplayer1`/`hplayer2`/`hplayer3` → `host`). **Needs on-site
      network access.**
- [ ] Confirm hplayer HTTP behavior matches what `hplayer.js` assumes:
      response codes/bodies on success and failure, and that `/mute`,
      `/unmute`, `/volume/<n>` are the literal correct paths (the guide's
      command table doesn't give explicit URL examples for these the way
      it does for `/trig/<n>`). **Needs a real hplayer to probe.**
- [ ] Replace each point's placeholder `seconds: 90` in `config.js` with
      the real video clip duration. **Needs the actual clip files.**
- [ ] Calibrate pan/tilt: `npm run panel`, aim the beam at each point,
      copy pan/tilt degrees into `config.js` `show.points`. **Needs the
      physical rig.**
- [ ] Run the full show end-to-end (`npm run demo --fast` first, then a
      real-speed pass) against real fixtures, confirm the sequence
      matches what's described above (search preview color, sequential
      beam-fade before strip/video, hplayer trig timing, gap).
- [ ] Run `npm run gallery`, test Focus/Volume/Fog controls from
      `public/gallery.html` against the real players.
- [ ] Check WiFi latency/reliability is acceptable for "live" hplayer
      control (retries/timeouts in `hplayer.js` are currently a flat
      2000 ms `AbortController` timeout — may need tuning).
- [ ] If all good: install as the systemd unit in the README, pointing at
      `gallery.js`.
