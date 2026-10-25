/** HSV values decoded from the RGB triplet published by the Nextion wheel. */
export interface NextionWheelColor {
  hue: number;
  saturation: number;
  red: number;
  green: number;
  blue: number;
  rgb: string;
}


const radians = function (degrees:number) {
    return degrees * Math.PI / 180;
}

const degrees = function (radians:number) {
    return radians * 180 / Math.PI;
}

const mod = function (n:number, m:number) {
    return ((n % m) + m) % m;
}

/**
 * Converts the `r|g|b` string published by `pageColorLight.colorWheel` into
 * HSV. Brightness is intentionally not derived here: the panel's wheel event
 * selects color, while the light plugin retains brightness independently.
 */
export function decodeNextionRgb(value: string): NextionWheelColor | undefined {

  const parts = value.trim().split("|");
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
    hue:Math.round(hue),
    saturation:Math.round(saturation),
    red,
    green,
    blue,
    rgb: `${red},${green},${blue}`
  };
}

const HSVtoRGB = function (h:number, s:number, v:number) {
    let r:number = 0, g:number = 0, b:number = 0, i, f, p, q, t;
    i = Math.floor(h * 6);
    f = h * 6 - i;
    p = v * (1 - s);
    q = v * (1 - f * s);
    t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0: r = v, g = t, b = p; break;
        case 1: r = q, g = v, b = p; break;
        case 2: r = p, g = v, b = t; break;
        case 3: r = p, g = q, b = v; break;
        case 4: r = t, g = p, b = v; break;
        case 5: r = v, g = p, b = q; break;
    }
    return {
        r: Math.round(r * 255),
        g: Math.round(g * 255),
        b: Math.round(b * 255)
    };
}


export function XYToRGB(value:string) {

  let [xStr, yStr] = value.split("|");
  let x = xStr ? parseInt(xStr) : 0;
  let y = yStr ? parseInt(yStr) : 0;

  const wh = 200;
  let r = wh / 2
  x = Math.round((x - r) / r * 100) / 100
  y = Math.round((r - y) / r * 100) / 100
  r = Math.sqrt(x * x + y * y)

  let sat = 0
  if (r > 1) {
        sat = 0
  } else {
        sat = r
  }

    const degr = degrees(Math.atan2(y, x));
    const mdeg = mod(degr, 360);
    const rgb = HSVtoRGB(mdeg / 360, sat, 1);
  return rgb;
}
