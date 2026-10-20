/** A locally simulated color selected from the Nextion color wheel image. */
export interface PanelWheelColor {
  x: number;
  y: number;
  hue: number;
  saturation: number;
  red: number;
  green: number;
  blue: number;
  rgb: string;
}

/**
 * Matches the manager's Nextion wheel decoder and the supplied Node-RED HSV
 * conversion. The displayed image is 220 pixels, while the calculation uses
 * the profile's diameter (200 by default to preserve the existing behavior).
 */
export function colorFromWheelTouch(x: number, y: number, diameter: number): PanelWheelColor {
  const radius = diameter / 2;
  const normalizedX = Math.round(((x - radius) / radius) * 100) / 100;
  const normalizedY = Math.round(((radius - y) / radius) * 100) / 100;
  const distance = Math.hypot(normalizedX, normalizedY);
  const saturation = distance > 1 ? 0 : distance;
  const hue = ((Math.atan2(normalizedY, normalizedX) * 180 / Math.PI) % 360 + 360) % 360;
  const sector = Math.floor((hue / 360) * 6);
  const fraction = (hue / 360) * 6 - sector;
  const p = 1 - saturation;
  const q = 1 - fraction * saturation;
  const t = 1 - (1 - fraction) * saturation;
  let channels: [number, number, number];
  switch (sector % 6) {
    case 0: channels = [1, t, p]; break;
    case 1: channels = [q, 1, p]; break;
    case 2: channels = [p, 1, t]; break;
    case 3: channels = [p, q, 1]; break;
    case 4: channels = [t, p, 1]; break;
    default: channels = [1, p, q];
  }
  const [red, green, blue] = channels.map((channel) => Math.round(channel * 255));
  return { x, y, hue, saturation, red, green, blue, rgb: `${red},${green},${blue}` };
}
