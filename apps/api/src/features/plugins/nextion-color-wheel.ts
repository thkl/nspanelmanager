/** HSV values decoded from the RGB triplet published by the Nextion wheel. */
export interface NextionWheelColor {
  hue: number;
  saturation: number;
  red: number;
  green: number;
  blue: number;
  rgb: string;
}

/**
 * Converts the `r|g|b` string published by `pageColorLight.colorWheel` into
 * HSV. Brightness is intentionally not derived here: the panel's wheel event
 * selects color, while the light plugin retains brightness independently.
 */
export function decodeNextionRgb(value: string): NextionWheelColor | undefined {
  const parts = value.trim().split("|");
  console.log(parts);
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) return undefined;
  const [red, green, blue] = parts.map(Number);
  if ([red, green, blue].some((channel) => channel < 0 || channel > 255)) return undefined;

  const normalizedRed = red / 255;
  const normalizedGreen = green / 255;
  const normalizedBlue = blue / 255;
  const maximum = Math.max(normalizedRed, normalizedGreen, normalizedBlue);
  const minimum = Math.min(normalizedRed, normalizedGreen, normalizedBlue);
  const difference = maximum - minimum;

  let hue = 0;
  if (difference !== 0) {
    if (maximum === normalizedRed) hue = 60 * (((normalizedGreen - normalizedBlue) / difference) % 6);
    else if (maximum === normalizedGreen) hue = 60 * ((normalizedBlue - normalizedRed) / difference + 2);
    else hue = 60 * ((normalizedRed - normalizedGreen) / difference + 4);
  }
  if (hue < 0) hue += 360;

  const saturation = maximum === 0 ? 0 : difference / maximum;
 
  return {
    hue,
    saturation,
    red,
    green,
    blue,
    rgb: `${red},${green},${blue}`
  };
}
