// ---------------------------------------------------------------------------
// Generic 4-channel RGBW DMX decoder driving a non-addressable RGBW strip.
//
// Channel layout (relative to the start address, order configurable):
//   +0 red   +1 green   +2 blue   +3 white
// ---------------------------------------------------------------------------

// Named colors shared by the show sequence (config.js `show.points[].color`)
// and this fixture's setNamedColor(). Kept RGBW, not the beam's color-wheel
// names (see hero-beam-100.js BEAM_COLORS) — the two fixtures pick color in
// fundamentally different ways (mixed LEDs vs. a physical wheel).
export const STRIP_COLORS = {
  white: { r: 0, g: 0, b: 0, w: 255 },
  red: { r: 255, g: 0, b: 0, w: 0 },
  green: { r: 0, g: 255, b: 0, w: 0 },
  blue: { r: 0, g: 0, b: 255, w: 0 },
  yellow: { r: 255, g: 255, b: 0, w: 0 },
  purple: { r: 255, g: 0, b: 255, w: 0 },
  cyan: { r: 0, g: 255, b: 255, w: 0 },
};

export class RgbwStrip {
  /**
   * @param {import('../open-dmx-usb.js').OpenDmxUsb} dmx
   * @param {number} address  DMX start address (1-509)
   * @param {object} [options]
   * @param {string} [options.order='RGBW'] wiring order of the decoder outputs
   */
  constructor(dmx, address, { order = 'RGBW' } = {}) {
    this.dmx = dmx;
    this.address = address;
    // Map each color letter to its channel offset, e.g. RGBW -> r:0 g:1 b:2 w:3
    this.offsets = {};
    [...order.toLowerCase()].forEach((letter, index) => {
      this.offsets[letter] = index;
    });
  }

  /** Set the color; each component 0-255. Omitted components are left unchanged. */
  set({ r, g, b, w }) {
    if (r !== undefined) this.dmx.set(this.address + this.offsets.r, r);
    if (g !== undefined) this.dmx.set(this.address + this.offsets.g, g);
    if (b !== undefined) this.dmx.set(this.address + this.offsets.b, b);
    if (w !== undefined) this.dmx.set(this.address + this.offsets.w, w);
  }

  setColor(r, g, b, w = 0) {
    this.set({ r, g, b, w });
  }

  /**
   * Set the color by name (see STRIP_COLORS), optionally scaled — handy for
   * fade in/out: setNamedColor('red', 0.5) is red at half intensity.
   * @param {string} name  key of STRIP_COLORS, e.g. 'white', 'red', 'green'
   * @param {number} [scale=1] intensity multiplier, 0-1
   */
  setNamedColor(name, scale = 1) {
    const color = STRIP_COLORS[String(name).toLowerCase()];
    if (!color) throw new Error(`Unknown strip color: ${name}`);
    const k = Math.max(0, Math.min(1, scale));
    this.setColor(
      Math.round(color.r * k),
      Math.round(color.g * k),
      Math.round(color.b * k),
      Math.round(color.w * k),
    );
  }

  off() {
    this.setColor(0, 0, 0, 0);
  }

  /** Current values as { r, g, b, w }. */
  get() {
    return {
      r: this.dmx.get(this.address + this.offsets.r),
      g: this.dmx.get(this.address + this.offsets.g),
      b: this.dmx.get(this.address + this.offsets.b),
      w: this.dmx.get(this.address + this.offsets.w),
    };
  }
}
