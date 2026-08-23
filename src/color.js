/**
 * HSV -> RGB conversion.
 * @param {number} h hue 0..1 (wraps)
 * @param {number} s saturation 0..1
 * @param {number} v value 0..1
 * @returns {{r: number, g: number, b: number}} components 0..255
 */
export function hsvToRgb(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [
    [v, t, p], [q, v, p], [p, v, t],
    [p, q, v], [t, p, v], [v, p, q],
  ][i % 6];
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}
