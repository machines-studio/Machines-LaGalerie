// ---------------------------------------------------------------------------
// Generic 4-channel RGBW DMX decoder driving a non-addressable RGBW strip.
//
// Channel layout (relative to the start address, order configurable):
//   +0 red   +1 green   +2 blue   +3 white
// ---------------------------------------------------------------------------

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
