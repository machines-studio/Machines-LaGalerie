// ---------------------------------------------------------------------------
// Cameo Phantom F5 smoke machine.
//
// DMX layout from the official manual:
//   1-channel mode: CH1 output volume  (0-5 = no output, 6-255 = 1-100 %)
//   3-channel mode: CH1 as above
//                   CH2 timer interval (0-5 = permanent on, 6-255 = 0.1-60 s)
//                   CH3 timer duration (0-255 = 0.1-60 s)
//
// The machine only produces fog once its heater is ready; DMX values sent
// during the heat-up phase are simply ignored by the machine.
// ---------------------------------------------------------------------------

export class PhantomF5 {
  /**
   * @param {import('../open-dmx-usb.js').OpenDmxUsb} dmx
   * @param {number} address  DMX start address
   * @param {object} [options]
   * @param {'1ch'|'3ch'} [options.mode='1ch'] must match the 'chnd' setting on the machine
   */
  constructor(dmx, address, { mode = '1ch' } = {}) {
    this.dmx = dmx;
    this.address = address;
    this.mode = mode;
    this._burstTimer = null;
  }

  /** Fog output in percent (0-100). 0 stops the output. */
  setOutput(percent) {
    const p = Math.max(0, Math.min(100, percent));
    this.dmx.set(this.address, p === 0 ? 0 : Math.round(6 + ((p - 1) * (255 - 6)) / 99));
  }

  off() {
    if (this._burstTimer) clearTimeout(this._burstTimer);
    this.setOutput(0);
  }

  /** One-shot burst: run at `percent` for `seconds`, then stop. */
  burst(percent, seconds) {
    if (this._burstTimer) clearTimeout(this._burstTimer);
    this.setOutput(percent);
    this._burstTimer = setTimeout(() => this.setOutput(0), seconds * 1000);
  }

  /**
   * 3-channel mode only: let the machine itself cycle fog.
   * intervalSeconds: 0 = permanent output, 0.1-60 = pause between bursts.
   * durationSeconds: 0.1-60 = length of each burst.
   */
  setTimer(intervalSeconds, durationSeconds) {
    if (this.mode !== '3ch') throw new Error('setTimer() requires the machine in 3ch DMX mode');
    this.dmx.set(this.address + 1, secondsToDmx(intervalSeconds, 6));
    this.dmx.set(this.address + 2, secondsToDmx(durationSeconds, 0));
  }
}

// Map 0.1-60 s onto low..255 (low = DMX value of the shortest time)
function secondsToDmx(seconds, low) {
  if (seconds <= 0) return 0;
  const s = Math.max(0.1, Math.min(60, seconds));
  return Math.round(low + ((s - 0.1) * (255 - low)) / 59.9);
}
