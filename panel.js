// ---------------------------------------------------------------------------
// Web control panel — manual testing & on-site calibration.
//
//   npm run panel     then open http://<host>:8080
//
// Lets you drive every fixture by hand (strip colors, beam pan/tilt/dimmer/
// color/gobo, smoke bursts) and set raw DMX channels. Use the beam sliders to
// find the pan/tilt values of the points of interest, then copy them into
// config.js (show.points).
//
// Dependency-free: plain node:http + one static HTML page.
// ---------------------------------------------------------------------------

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setup, handleExit } from './src/setup.js';

const { dmx, fixtures, config, shutdown } = await setup();
handleExit(shutdown);

const indexHtml = await readFile(
  fileURLToPath(new URL('./public/index.html', import.meta.url)),
);

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (err) { reject(err); }
    });
  });

const server = http.createServer(async (req, res) => {
  const sendJson = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(indexHtml);
    }

    if (req.method === 'GET' && req.url === '/api/state') {
      return sendJson(200, {
        channels: dmx.snapshot(),
        fixtures: config.fixtures,
        show: config.show,
      });
    }

    if (req.method !== 'POST') return sendJson(404, { error: 'not found' });
    const body = await readBody(req);

    // POST /api/strip/<name>  { r?, g?, b?, w? }
    const stripMatch = req.url.match(/^\/api\/strip\/(\w+)$/);
    if (stripMatch) {
      const strip = fixtures[stripMatch[1]];
      if (!strip) return sendJson(404, { error: `unknown fixture ${stripMatch[1]}` });
      strip.set(body);
      return sendJson(200, { ok: true });
    }

    // POST /api/beam  any of: pan, tilt (degrees), dimmer, focus (0-255),
    // shutter ('open'|'close'), strobeHz, color (name), gobo {index, shake},
    // prismCircular, prismLinear, frost (booleans), home (true)
    if (req.url === '/api/beam') {
      const beam = fixtures.beam;
      if (body.home) beam.home();
      if (body.pan !== undefined || body.tilt !== undefined) {
        beam.setPosition(
          body.pan ?? currentDegrees().pan,
          body.tilt ?? currentDegrees().tilt,
        );
      }
      if (body.dimmer !== undefined) beam.setDimmer(body.dimmer);
      if (body.focus !== undefined) beam.setFocus(body.focus);
      if (body.shutter === 'open') beam.shutterOpen();
      if (body.shutter === 'close') beam.shutterClose();
      if (body.strobeHz !== undefined) beam.strobe(body.strobeHz);
      if (body.color !== undefined) beam.setColor(body.color);
      if (body.gobo !== undefined) beam.setGobo(body.gobo.index, { shake: body.gobo.shake });
      if (body.prismCircular !== undefined || body.prismLinear !== undefined) {
        beam.setPrism({ circular: !!body.prismCircular, linear: !!body.prismLinear });
      }
      if (body.frost !== undefined) beam.setFrost(body.frost);
      return sendJson(200, { ok: true });
    }

    // POST /api/smoke  { output } or { burst: { percent, seconds } }
    if (req.url === '/api/smoke') {
      if (body.burst) fixtures.smoke.burst(body.burst.percent, body.burst.seconds);
      else if (body.output !== undefined) fixtures.smoke.setOutput(body.output);
      else fixtures.smoke.off();
      return sendJson(200, { ok: true });
    }

    // POST /api/channels  { "10": 255, "11": 128 }
    if (req.url === '/api/channels') {
      dmx.setMany(body);
      return sendJson(200, { ok: true });
    }

    if (req.url === '/api/blackout') {
      dmx.blackout();
      return sendJson(200, { ok: true });
    }

    return sendJson(404, { error: 'not found' });
  } catch (err) {
    return sendJson(500, { error: err.message });
  }
});

// Degrees currently on the wire, derived back from the beam's DMX channels
function currentDegrees() {
  const base = config.fixtures.beam.address;
  const pan16 = (dmx.get(base) << 8) | dmx.get(base + 1);
  const tilt16 = (dmx.get(base + 2) << 8) | dmx.get(base + 3);
  return { pan: (pan16 / 65535) * 540, tilt: (tilt16 / 65535) * 250 };
}

server.listen(config.panelPort, () => {
  console.log(`[panel] control panel on http://localhost:${config.panelPort}`);
});
