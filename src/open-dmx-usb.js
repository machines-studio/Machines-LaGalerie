import { SerialPort } from 'serialport';

// ---------------------------------------------------------------------------
// Minimal "Open DMX USB" driver.
//
// Low-cost USB->DMX dongles (Enttec Open DMX USB and its many FTDI FT232R
// clones) contain no microcontroller: the host must generate the DMX frames
// itself. A DMX frame is:
//
//   BREAK (>= 88 us low)  ->  MARK AFTER BREAK (>= 8 us)  ->
//   513 bytes at 250 kbaud, 8N2: start code 0x00 + 512 channel values
//
// We approximate the break/MAB with 1 ms timers (far above the spec minimums,
// which every receiver accepts) and keep re-sending the frame continuously —
// DMX is a repetitive protocol, receivers expect a permanent stream.
// ---------------------------------------------------------------------------

export class OpenDmxUsb {
  /**
   * @param {string} path      serial port, e.g. '/dev/ttyUSB0'
   * @param {object} [options]
   * @param {number} [options.refreshRate=30] frames per second (~30 max for a full universe)
   * @param {number} [options.breakMs=1] break duration (spec minimum is 88 us)
   * @param {number} [options.mabMs=1]   mark-after-break duration (spec minimum is 8 us)
   * @param {boolean} [options.rts=true] RTS line state while transmitting — some
   *   dongles gate their RS-485 output driver with RTS or DTR, so if the DMX
   *   receivers see no signal at all, try the other combinations (node linetest.js).
   * @param {boolean} [options.dtr=true] DTR line state while transmitting
   */
  constructor(path, { refreshRate = 30, breakMs = 1, mabMs = 1, rts = true, dtr = true } = {}) {
    this.path = path;
    this.frameInterval = Math.max(25, Math.round(1000 / refreshRate));
    this.breakMs = breakMs;
    this.mabMs = mabMs;
    this.rts = rts;
    this.dtr = dtr;
    // frame[0] is the DMX start code (always 0), frame[1..512] are channels 1..512
    this.frame = Buffer.alloc(513);
    this.port = null;
    this.running = false;
  }

  /** Returns the path of the first FTDI serial device found, or null. */
  static async findFtdiPort() {
    const ports = await SerialPort.list();
    const ftdi = ports.find((p) => (p.vendorId ?? '').toLowerCase() === '0403');
    return ftdi?.path ?? null;
  }

  async open() {
    this.port = new SerialPort({
      path: this.path,
      baudRate: 250000,
      dataBits: 8,
      stopBits: 2,
      parity: 'none',
      autoOpen: false,
    });
    await new Promise((resolve, reject) =>
      this.port.open((err) => (err ? reject(err) : resolve())),
    );
    this.port.on('error', (err) => console.error('[dmx] serial error:', err.message));
    this.running = true;
    this._sendLoop();
  }

  /** Set one channel (1-512) to a value (0-255). Takes effect on the next frame. */
  set(channel, value) {
    if (channel < 1 || channel > 512) throw new RangeError(`DMX channel out of range: ${channel}`);
    this.frame[channel] = Math.max(0, Math.min(255, Math.round(value)));
  }

  /** Set several channels at once: setMany({ 10: 255, 11: 128 }) */
  setMany(channels) {
    for (const [channel, value] of Object.entries(channels)) this.set(Number(channel), value);
  }

  /** Current value of a channel (1-512). */
  get(channel) {
    return this.frame[channel];
  }

  /** All 512 channel values as a plain array (index 0 = channel 1). */
  snapshot() {
    return Array.from(this.frame.subarray(1));
  }

  /** Set every channel to 0. */
  blackout() {
    this.frame.fill(0, 1);
  }

  /** Stop transmitting and close the port. */
  async close() {
    this.running = false;
    if (this.port?.isOpen) {
      await new Promise((resolve) => this.port.close(() => resolve()));
    }
  }

  // Continuously send frames: BREAK -> MAB -> data, then schedule the next
  // frame so we approach the requested refresh rate.
  _sendLoop() {
    if (!this.running || !this.port?.isOpen) return;
    const started = Date.now();
    const line = { rts: this.rts, dtr: this.dtr };
    this.port.set({ ...line, brk: true }, () => {
      setTimeout(() => {
        if (!this.running || !this.port?.isOpen) return;
        this.port.set({ ...line, brk: false }, () => {
          setTimeout(() => {
            if (!this.running || !this.port?.isOpen) return;
            this.port.write(this.frame);
            this.port.drain(() => {
              const elapsed = Date.now() - started;
              setTimeout(() => this._sendLoop(), Math.max(0, this.frameInterval - elapsed));
            });
          }, this.mabMs);
        });
      }, this.breakMs);
    });
  }
}
