// ---------------------------------------------------------------------------
// HPlayer2 video player (RastaOS, Machines expo 2026) — network fixture.
//
// Unlike the other fixtures in this folder, an hplayer is not a DMX device:
// it's a standalone Raspberry Pi reachable over the gallery WiFi, controlled
// with plain HTTP GET requests.
//
//   GET http://<ip>:8080/trig/<n>   play sequence n_*.mp4 once, then loop
//   GET http://<ip>:8080/play/<f>   play a specific file once
//   GET http://<ip>:8080/stop       back to idle loop (0_*.mp4)
//   GET http://<ip>:8080/pause
//   GET http://<ip>:8080/resume
//   GET http://<ip>:8080/volume/<0-100>
//   GET http://<ip>:8080/mute
//   GET http://<ip>:8080/unmute
//   GET http://<ip>:8080/status
//   GET http://<ip>:8080/ping
//
// Reference: https://37m.gr/misc/RastaOS-7.2-Machines26-guide.html
//
// NOT VERIFIED ON HARDWARE YET (written 2026-08-31, no player reachable from
// home). Response shapes/status codes are guessed defensively — re-check
// on site and adjust `_get()` / `status()` if the real player disagrees.
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 8080;
const DEFAULT_TIMEOUT_MS = 2000;

export class HPlayer {
  /**
   * @param {string} host  IP or hostname of the player, e.g. '10.0.0.101'
   * @param {object} [options]
   * @param {number} [options.port=8080]
   * @param {number} [options.timeoutMs=2000] request timeout
   */
  constructor(host, { port = DEFAULT_PORT, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.muted = false; // optimistic local state, mirrors last command sent
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  async _get(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`hplayer ${this.host}${path} -> HTTP ${res.status}`);
      const text = await res.text().catch(() => '');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Play sequence N once (file matching `N_*`), then return to idle loop. */
  trig(n) {
    return this._get(`/trig/${encodeURIComponent(n)}`);
  }

  /** Play a specific file once, then return to idle loop. */
  play(file) {
    return this._get(file ? `/play/${encodeURIComponent(file)}` : '/play');
  }

  /** Stop and return to the idle loop (0_*.mp4). */
  stop() {
    return this._get('/stop');
  }

  pause() {
    return this._get('/pause');
  }

  resume() {
    return this._get('/resume');
  }

  /** Set volume, 0-100 (persisted on the player). */
  volume(percent) {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    return this._get(`/volume/${p}`);
  }

  /** Silence without stopping playback. */
  async mute() {
    await this._get('/mute');
    this.muted = true;
  }

  /** Restore sound. */
  async unmute() {
    await this._get('/unmute');
    this.muted = false;
  }

  toggleMute() {
    return this.muted ? this.unmute() : this.mute();
  }

  /** Player-reported state (raw text/JSON — shape not yet confirmed). */
  status() {
    return this._get('/status');
  }

  /** Liveness check. Resolves on any HTTP response, rejects on timeout/network error. */
  ping() {
    return this._get('/ping');
  }
}
