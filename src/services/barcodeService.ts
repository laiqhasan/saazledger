/**
 * Zero-dependency standard Code 128 (Subset B) SVG barcode generator
 * Produces crisp, vector-sharp barcodes for thermal tag printers & paper printing.
 */

// Code 128 patterns: each string is 6 digits representing alternating widths of bars and spaces
const CODE128_PATTERNS: string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', // 0-9
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', // 10-19
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', // 20-29
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', // 30-39
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', // 40-49
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', // 50-59
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', // 60-69
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', // 70-79
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', // 80-89
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', // 90-99
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112', // 100-106 (106 is STOP)
];

const START_CODE_B = 104;
const STOP_CODE = 106;

/**
 * Encodes ASCII text into a Code 128B module array (1 for bar, 0 for space)
 */
export function encodeCode128B(text: string): number[] {
  const codes: number[] = [START_CODE_B];
  let checkSum = START_CODE_B;

  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    // Standard ASCII 32 (' ') to 126 ('~') maps to value (charCode - 32)
    const val = charCode >= 32 && charCode <= 126 ? charCode - 32 : 0;
    codes.push(val);
    checkSum += val * (i + 1);
  }

  const checkDigit = checkSum % 103;
  codes.push(checkDigit);
  codes.push(STOP_CODE);

  // Convert pattern codes to array of binary modules (1=bar, 0=space)
  const modules: number[] = [];

  // Quiet zone at start
  for (let q = 0; q < 10; q++) modules.push(0);

  for (const code of codes) {
    const pattern = CODE128_PATTERNS[code];
    if (!pattern) continue;

    let isBar = true;
    for (let p = 0; p < pattern.length; p++) {
      const width = parseInt(pattern[p], 10);
      for (let w = 0; w < width; w++) {
        modules.push(isBar ? 1 : 0);
      }
      isBar = !isBar;
    }
  }

  // Quiet zone at end
  for (let q = 0; q < 10; q++) modules.push(0);

  return modules;
}

/**
 * Generates an SVG string representation of a Code 128 barcode
 */
export function generateBarcodeSvg(
  text: string,
  options?: {
    height?: number;
    moduleWidth?: number;
    color?: string;
    showText?: boolean;
  }
): string {
  const height = options?.height || 42;
  const moduleWidth = options?.moduleWidth || 1.4;
  const color = options?.color || '#000000';
  const showText = options?.showText ?? false;

  const modules = encodeCode128B(text);
  const totalWidth = modules.length * moduleWidth;
  const totalHeight = showText ? height + 14 : height;

  let rects = '';
  let startX = -1;

  for (let i = 0; i < modules.length; i++) {
    if (modules[i] === 1) {
      if (startX === -1) startX = i;
    } else {
      if (startX !== -1) {
        const barW = (i - startX) * moduleWidth;
        const barX = startX * moduleWidth;
        rects += `<rect x="${barX.toFixed(1)}" y="0" width="${barW.toFixed(1)}" height="${height}" fill="${color}" />`;
        startX = -1;
      }
    }
  }
  if (startX !== -1) {
    const barW = (modules.length - startX) * moduleWidth;
    const barX = startX * moduleWidth;
    rects += `<rect x="${barX.toFixed(1)}" y="0" width="${barW.toFixed(1)}" height="${height}" fill="${color}" />`;
  }

  const textElement = showText
    ? `<text x="${(totalWidth / 2).toFixed(1)}" y="${totalHeight - 2}" text-anchor="middle" font-family="monospace" font-size="11" font-weight="600" fill="${color}" letter-spacing="2">${text}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth.toFixed(1)} ${totalHeight}" width="${totalWidth.toFixed(1)}" height="${totalHeight}" shape-rendering="crispEdges">
    ${rects}
    ${textElement}
  </svg>`;
}
