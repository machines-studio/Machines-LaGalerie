// ---------------------------------------------------------------------------
// Varytec Hero Beam 100 moving head — 19-channel DMX mode.
//
// Channel layout and value ranges taken from the official manual
// (Thomann doc c_477540_v2_en, chapter 7.9). The fixture itself must be set
// to 'DMX 19CH mode' on its display.
//
//   1 pan (0..540°)          8 color wheel          15 frost filter on/off
//   2 pan fine               9 static gobo wheel    16 7-colors effect wheel
//   3 tilt (0..250°)        10 focus far->close     17 auto show
//   4 tilt fine             11 circular prism       18 pan/tilt auto program
//   5 pan/tilt speed        12 circular prism rot.  19 reset
//   6 dimmer                13 linear prism
//   7 shutter/strobe        14 linear prism rot.
// ---------------------------------------------------------------------------

const CH = {
  pan: 0, panFine: 1, tilt: 2, tiltFine: 3, speed: 4, dimmer: 5, shutter: 6,
  color: 7, gobo: 8, focus: 9, prismCircular: 10, prismCircularRot: 11,
  prismLinear: 12, prismLinearRot: 13, frost: 14, effectWheel: 15,
  autoShow: 16, panTiltAuto: 17, reset: 18,
};

// Center value of each color-wheel band (channel 8)
export const BEAM_COLORS = {
  white: 0, red: 12, orange: 22, lightblue: 32, green: 42, yellow: 52,
  pink: 62, blue: 72, congo: 92, cto7000: 102, cto3000: 112,
  salmon: 122, purple: 132,
};

const PAN_RANGE_DEG = 540;
const TILT_RANGE_DEG = 250;

export class HeroBeam100 {
  /**
   * @param {import('../open-dmx-usb.js').OpenDmxUsb} dmx
   * @param {number} address  DMX start address (1-494)
   */
  constructor(dmx, address) {
    this.dmx = dmx;
    this.address = address;
  }

  _set(channel, value) {
    this.dmx.set(this.address + CH[channel], value);
  }

  /** Pan in degrees (0..540) and tilt in degrees (0..250), 16-bit resolution. */
  setPosition(panDeg, tiltDeg) {
    const pan16 = Math.round((clamp(panDeg, 0, PAN_RANGE_DEG) / PAN_RANGE_DEG) * 65535);
    const tilt16 = Math.round((clamp(tiltDeg, 0, TILT_RANGE_DEG) / TILT_RANGE_DEG) * 65535);
    this._set('pan', pan16 >> 8);
    this._set('panFine', pan16 & 0xff);
    this._set('tilt', tilt16 >> 8);
    this._set('tiltFine', tilt16 & 0xff);
  }

  /** Pan/tilt movement speed: 0 = fastest, 255 = slowest. */
  setSpeed(value) {
    this._set('speed', value);
  }

  /** Dimmer 0-255. */
  setDimmer(value) {
    this._set('dimmer', value);
  }

  /** Shutter fully open (LEDs on). */
  shutterOpen() {
    this._set('shutter', 255);
  }

  /** Shutter closed (LEDs off). */
  shutterClose() {
    this._set('shutter', 0);
  }

  /** Constant strobe, 0.5..20 Hz (DMX 201..250). */
  strobe(hz) {
    const t = (clamp(hz, 0.5, 20) - 0.5) / 19.5;
    this._set('shutter', Math.round(201 + t * 49));
  }

  /** Color by name (see BEAM_COLORS) or raw wheel value (0-255). */
  setColor(color) {
    const value = typeof color === 'number' ? color : BEAM_COLORS[String(color).toLowerCase()];
    if (value === undefined) throw new Error(`Unknown beam color: ${color}`);
    this._set('color', value);
  }

  /** Continuous color wheel rotation, speed 0..1 (0 stops it). */
  colorRotate(speed) {
    if (speed <= 0) this._set('color', 0);
    else this._set('color', Math.round(199 - clamp(speed, 0, 1) * 49)); // 150..199, faster = lower
  }

  /** Static gobo 0 (open) .. 11, or shake with { shake: true }. */
  setGobo(index, { shake = false } = {}) {
    const n = clamp(Math.round(index), 0, 11);
    if (n === 0) this._set('gobo', 0);
    else if (shake) this._set('gobo', 120 + (n - 1) * 8 + 4); // shake bands: 120-127, 128-135, ...
    else this._set('gobo', n * 10 + 5); // static bands: 10-19, 20-29, ...
  }

  /** Focus 0 (far) .. 255 (close). */
  setFocus(value) {
    this._set('focus', value);
  }

  setPrism({ circular = false, linear = false } = {}) {
    this._set('prismCircular', circular ? 255 : 0);
    this._set('prismLinear', linear ? 255 : 0);
  }

  setFrost(on) {
    this._set('frost', on ? 255 : 0);
  }

  /** Neutral state: centered, shutter open, dimmer 0, no effect. */
  home() {
    this.setPosition(PAN_RANGE_DEG / 2, TILT_RANGE_DEG / 2);
    this.setSpeed(0);
    this.setDimmer(0);
    this.shutterOpen();
    this.setColor('white');
    this.setGobo(0);
    this.setFocus(128);
    this.setPrism({});
    this.setFrost(false);
    this._set('effectWheel', 0);
    this._set('autoShow', 0);
    this._set('panTiltAuto', 0);
    this._set('reset', 0);
  }

  /** Full fixture reset (channel 19 must stay high >= 3 s per the manual). */
  async reset() {
    this._set('reset', 200);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    this._set('reset', 0);
  }

  blackout() {
    this.setDimmer(0);
    this.shutterClose();
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
