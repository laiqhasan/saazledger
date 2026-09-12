import sharp from 'sharp';

export interface CleanJewelleryCutoutOptions {
  removeRuler?: boolean;
  rulerBounds?: { x: number; y: number; width: number; height: number };
  minComponentAreaPercent?: number; // legacy option; size alone is never enough to delete jewellery components
  maxAllowedRulerAspect?: number;    // aspect ratio > 3.0 near border -> ruler candidate
}

export interface CleanJewelleryCutoutResult {
  cleanedBuffer: Buffer;
  fullCleanedBuffer: Buffer;
  tightBounds: { x: number; y: number; width: number; height: number };
  hasRuler: boolean;
  rulerBoundingBox?: { x: number; y: number; width: number; height: number };
  removedArtifactsCount: number;
  originalWidth: number;
  originalHeight: number;
  forbiddenObjects?: string[];
}

interface Component {
  id: number;
  pixelCount: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  isRuler: boolean;
  isDust: boolean;
  isBorderArtifact: boolean;
  isProp: boolean;
  isJewelleryComponent: boolean;
  keep: boolean;
}

/**
 * Clean leftover artifacts from an isolated transparent jewellery cutout:
 * - Removes ruler / scale fragments
 * - Removes paper edges, table marks, and cardboard strips
 * - Eliminates only obvious edge dust/ruler artifacts; small disconnected jewellery pieces are preserved
 * - Retains ONLY the main jewellery subject group (necklace, pendant, earrings)
 * - Computes tight bounding box of the clean jewellery and extracts it
 */
export async function cleanJewelleryCutoutArtifacts(
  transparentBuffer: Buffer,
  options: CleanJewelleryCutoutOptions = {}
): Promise<CleanJewelleryCutoutResult> {
  const meta = await sharp(transparentBuffer).metadata();
  const width = meta.width || 2048;
  const height = meta.height || 2048;

  if (!meta.hasAlpha) {
    // If buffer lacks alpha, wrap it as-is with full dimensions
    return {
      cleanedBuffer: transparentBuffer,
      fullCleanedBuffer: transparentBuffer,
      tightBounds: { x: 0, y: 0, width, height },
      hasRuler: false,
      removedArtifactsCount: 0,
      originalWidth: width,
      originalHeight: height,
    };
  }

  // Work on downsampled grid for fast, instantaneous connected-component analysis
  const maxDim = 800;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const gridW = Math.max(10, Math.round(width * scale));
  const gridH = Math.max(10, Math.round(height * scale));

  const alphaChannel = await sharp(transparentBuffer)
    .resize(gridW, gridH, { fit: 'fill' })
    .extractChannel(3)
    .raw()
    .toBuffer();

  const labels = new Int32Array(gridW * gridH);
  let nextLabel = 1;
  const componentsMap = new Map<number, Component>();

  // Threshold alpha: values > 25 are considered solid foreground pixels
  const ALPHA_THRESH = 25;

  // Connected Component Labeling via Breadth-First Search (BFS)
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const idx = y * gridW + x;
      if (alphaChannel[idx] < ALPHA_THRESH || labels[idx] > 0) continue;

      const currentLabel = nextLabel++;
      let pixelCount = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;

      const queue: number[] = [idx];
      labels[idx] = currentLabel;

      let head = 0;
      while (head < queue.length) {
        const cur = queue[head++];
        pixelCount++;
        const cx = cur % gridW;
        const cy = Math.floor(cur / gridW);

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // 4-neighborhood expansion
        const neighbors = [
          cy > 0 ? cur - gridW : -1,
          cy < gridH - 1 ? cur + gridW : -1,
          cx > 0 ? cur - 1 : -1,
          cx < gridW - 1 ? cur + 1 : -1,
        ];

        for (const n of neighbors) {
          if (n >= 0 && labels[n] === 0 && alphaChannel[n] >= ALPHA_THRESH) {
            labels[n] = currentLabel;
            queue.push(n);
          }
        }
      }

      componentsMap.set(currentLabel, {
        id: currentLabel,
        pixelCount,
        minX,
        minY,
        maxX,
        maxY,
        isRuler: false,
        isDust: false,
        isBorderArtifact: false,
        isProp: false,
        isJewelleryComponent: false,
        keep: true,
      });
    }
  }

  const components = Array.from(componentsMap.values());
  if (components.length === 0) {
    return {
      cleanedBuffer: transparentBuffer,
      fullCleanedBuffer: transparentBuffer,
      tightBounds: { x: 0, y: 0, width, height },
      hasRuler: false,
      removedArtifactsCount: 0,
      originalWidth: width,
      originalHeight: height,
      forbiddenObjects: [],
    };
  }

  // Sort components by pixel area descending
  components.sort((a, b) => b.pixelCount - a.pixelCount);
  const totalPixels = components.reduce((sum, c) => sum + c.pixelCount, 0);

  let detectedRuler = false;
  const rulerBoxes: Array<{ x: number; y: number; width: number; height: number }> = [];
  let removedCount = 0;

  // Ruler detection heuristics on components:
  // 1. If explicit ruler bounds were provided (from AI Vision / Ruler detection)
  // 2. Or if a component has ruler shape: elongated aspect ratio,
  //    positioned close to the frame edge (left, right, bottom, or top).
  const marginW = Math.round(gridW * 0.18);
  const marginH = Math.round(gridH * 0.18);
  const outerBorderMarginX = Math.max(3, Math.round(gridW * 0.05));
  const outerBorderMarginY = Math.max(3, Math.round(gridH * 0.05));
  const canvasCenterX = gridW / 2;
  const canvasCenterY = gridH * 0.48;

  // First pass: identify rulers, border artifacts, and props on all components
  for (const c of components) {
    const compW = c.maxX - c.minX + 1;
    const compH = c.maxY - c.minY + 1;
    const aspect = compW / Math.max(1, compH);

    const touchesEdge =
      c.minX <= marginW ||
      c.maxX >= gridW - marginW ||
      c.minY <= marginH ||
      c.maxY >= gridH - marginH;

    // Check if component matches provided ruler bounds (scaled to grid)
    if (options.rulerBounds) {
      const rb = options.rulerBounds;
      const gx = rb.x * scale;
      const gy = rb.y * scale;
      const gw = rb.width * scale;
      const gh = rb.height * scale;

      const overlapX = Math.max(0, Math.min(c.maxX, gx + gw) - Math.max(c.minX, gx));
      const overlapY = Math.max(0, Math.min(c.maxY, gy + gh) - Math.max(c.minY, gy));
      if (overlapX * overlapY > (compW * compH) * 0.3) {
        c.isRuler = true;
        c.keep = false;
        detectedRuler = true;
        rulerBoxes.push(rb);
        removedCount++;
        continue;
      }
    }

    // Heuristic ruler detection:
    // - Horizontal ruler at bottom or top (aspect >= 2.2, width >= 20% of canvas)
    // - Vertical ruler at left or right (aspect <= 0.45, height >= 20% of canvas)
    // - Dual / L-shaped ruler (left vertical and bottom horizontal merged at corner)
    const isHorizontalRuler =
      aspect >= 2.2 &&
      compW >= gridW * 0.2 &&
      (c.maxY >= gridH - marginH || c.minY <= marginH);

    const isVerticalRuler =
      aspect <= 0.45 &&
      compH >= gridH * 0.2 &&
      (c.maxX >= gridW - outerBorderMarginX || c.minX <= outerBorderMarginX);

    const compFillRatio = c.pixelCount / Math.max(1, compW * compH);
    const isCornerDualRuler =
      (c.minX <= outerBorderMarginX &&
        c.maxY >= gridH - marginH &&
        compW >= gridW * 0.3 &&
        compH >= gridH * 0.3) ||
      (c.minX <= outerBorderMarginX &&
        compW >= gridW * 0.45 &&
        compH >= gridH * 0.25 &&
        compFillRatio < 0.38);

    if (isHorizontalRuler || isVerticalRuler || isCornerDualRuler) {
      c.isRuler = true;
      c.keep = false;
      detectedRuler = true;
      rulerBoxes.push({
        x: Math.round(c.minX / scale),
        y: Math.round(c.minY / scale),
        width: Math.round(compW / scale),
        height: Math.round(compH / scale),
      });
      removedCount++;
      continue;
    }

    // Border artifact / paper edge detection: narrow strip hugging outer border
    const isBorderEdge =
      (compW >= gridW * 0.35 && compH <= Math.round(gridH * 0.08) && touchesEdge) ||
      (compH >= gridH * 0.35 && compW <= Math.round(gridW * 0.08) && touchesEdge);

    if (isBorderEdge) {
      c.isBorderArtifact = true;
      c.keep = false;
      removedCount++;
      continue;
    }
  }

  // Find primary jewellery component among non-ruler, non-border candidates
  const candidateJewellery = components.filter((c) => !c.isRuler && !c.isBorderArtifact);
  let primaryComponent = candidateJewellery[0];
  let highestCentrality = -1;

  for (const c of candidateJewellery) {
    const cX = (c.minX + c.maxX) / 2;
    const cY = (c.minY + c.maxY) / 2;
    const dist = Math.hypot(cX - canvasCenterX, cY - canvasCenterY);
    const score = c.pixelCount * Math.max(0.1, 1 - dist / (Math.max(gridW, gridH) * 0.7));
    if (score > highestCentrality) {
      highestCentrality = score;
      primaryComponent = c;
    }
  }

  if (primaryComponent) {
    primaryComponent.isJewelleryComponent = true;
    primaryComponent.keep = true;
  }

  // Second pass: classify remaining components relative to primary jewellery piece
  for (const c of candidateJewellery) {
    if (c === primaryComponent) continue;

    const compW = c.maxX - c.minX + 1;
    const compH = c.maxY - c.minY + 1;
    const touchesEdge =
      c.minX <= marginW ||
      c.maxX >= gridW - marginW ||
      c.minY <= marginH ||
      c.maxY >= gridH - marginH;

    const distToPrimary = primaryComponent
      ? Math.hypot(
          (c.minX + c.maxX) / 2 - (primaryComponent.minX + primaryComponent.maxX) / 2,
          (c.minY + c.maxY) / 2 - (primaryComponent.minY + primaryComponent.maxY) / 2
        )
      : 0;

    // Dust detection must not use size alone. Tiny disconnected jewellery parts
    // can be earrings, dangles, stones, a clasp, or a pendant drop. Only remove
    // a tiny component when it is also peripheral/edge-adjacent and far from the
    // primary jewellery cluster.
    const minDustArea = Math.max(4, Math.round(totalPixels * 0.0006));
    const edgeDustBandX = Math.round(gridW * 0.08);
    const edgeDustBandY = Math.round(gridH * 0.08);
    const nearOuterEdge =
      c.minX <= edgeDustBandX ||
      c.maxX >= gridW - edgeDustBandX ||
      c.minY <= edgeDustBandY ||
      c.maxY >= gridH - edgeDustBandY;
    if (
      c.pixelCount < minDustArea &&
      nearOuterEdge &&
      distToPrimary > Math.min(gridW, gridH) * 0.28
    ) {
      c.isDust = true;
      c.keep = false;
      removedCount++;
      continue;
    }

    // JEWELLERY PIECES (Necklace dangles, Left earring, Right earring):
    // If not ruler, not border strip, and within reasonable distance of primary jewellery bounding region:
    // MUST BE PRESERVED! Do NOT discard valid disconnected earrings or pendants!
    if (distToPrimary <= Math.max(gridW, gridH) * 0.65) {
      c.isJewelleryComponent = true;
      c.keep = true;
    } else if (touchesEdge && c.pixelCount > totalPixels * 0.08) {
      // Large peripheral component touching edge is likely a prop or flower
      c.isProp = true;
      c.keep = false;
      removedCount++;
    } else {
      c.keep = true;
    }
  }

  // Identify jewellery cluster:
  // Components marked keep=true that are within cluster range of primary component
  const keptComponents = components.filter((c) => c.keep);
  if (keptComponents.length === 0) {
    // Safety fallback: retain primary component
    primaryComponent.keep = true;
    keptComponents.push(primaryComponent);
  }

  // Map kept components to grid mask
  const keepLabelSet = new Set(keptComponents.map((c) => c.id));

  // Compute tight bounds of kept components in full image coordinates
  let minKeepX = gridW;
  let maxKeepX = 0;
  let minKeepY = gridH;
  let maxKeepY = 0;

  for (const c of keptComponents) {
    if (c.minX < minKeepX) minKeepX = c.minX;
    if (c.maxX > maxKeepX) maxKeepX = c.maxX;
    if (c.minY < minKeepY) minKeepY = c.minY;
    if (c.maxY > maxKeepY) maxKeepY = c.maxY;
  }

  const fullTightX = Math.max(0, Math.floor(minKeepX / scale));
  const fullTightY = Math.max(0, Math.floor(minKeepY / scale));
  const fullTightMaxX = Math.min(width - 1, Math.ceil(maxKeepX / scale));
  const fullTightMaxY = Math.min(height - 1, Math.ceil(maxKeepY / scale));

  const tightW = Math.max(10, fullTightMaxX - fullTightX + 1);
  const tightH = Math.max(10, fullTightMaxY - fullTightY + 1);

  // If no artifacts were eliminated and no ruler bounds were masked,
  // do a direct tight extract of the original transparent buffer.
  if (removedCount === 0 && !options.rulerBounds) {
    const cropped = await sharp(transparentBuffer)
      .extract({ left: fullTightX, top: fullTightY, width: tightW, height: tightH })
      .png()
      .toBuffer();

    return {
      cleanedBuffer: cropped,
      fullCleanedBuffer: transparentBuffer,
      tightBounds: { x: fullTightX, y: fullTightY, width: tightW, height: tightH },
      hasRuler: false,
      removedArtifactsCount: 0,
      originalWidth: width,
      originalHeight: height,
    };
  }

  // Otherwise, construct a clean alpha mask at grid resolution, upscale it smoothly,
  // and apply it to the transparent cutout to guarantee zero leftover ruler/dust pixels.
  const cleanAlphaGrid = Buffer.alloc(gridW * gridH);
  for (let i = 0; i < labels.length; i++) {
    const lbl = labels[i];
    if (lbl > 0 && keepLabelSet.has(lbl)) {
      cleanAlphaGrid[i] = alphaChannel[i];
    } else {
      cleanAlphaGrid[i] = 0;
    }
  }

  // If explicit ruler bounds were provided from outside, ensure those pixels are zeroed out
  if (options.rulerBounds) {
    const rb = options.rulerBounds;
    const rx = Math.max(0, Math.floor(rb.x * scale));
    const ry = Math.max(0, Math.floor(rb.y * scale));
    const rw = Math.min(gridW - rx, Math.ceil(rb.width * scale));
    const rh = Math.min(gridH - ry, Math.ceil(rb.height * scale));
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        cleanAlphaGrid[y * gridW + x] = 0;
      }
    }
  }

  // Upscale clean alpha mask to original image resolution (guarantee 1-channel b-w raw bytes)
  const fullCleanAlpha =
    width === gridW && height === gridH
      ? cleanAlphaGrid
      : await sharp(cleanAlphaGrid, {
          raw: { width: gridW, height: gridH, channels: 1 },
        })
          .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
          .toColourspace('b-w')
          .raw()
          .toBuffer();

  // Extract RGB from original transparent buffer and recombine with clean alpha
  const rgbBuffer = await sharp(transparentBuffer)
    .removeAlpha()
    .raw()
    .toBuffer();

  // Combine RGB + Clean Alpha into 4-channel RGBA
  const rgbaBuffer = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgbaBuffer[i * 4] = rgbBuffer[i * 3];
    rgbaBuffer[i * 4 + 1] = rgbBuffer[i * 3 + 1];
    rgbaBuffer[i * 4 + 2] = rgbBuffer[i * 3 + 2];
    rgbaBuffer[i * 4 + 3] = fullCleanAlpha[i];
  }

  // Generate full-resolution cleaned transparent image with artifacts zeroed out
  const fullClean = await sharp(rgbaBuffer, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();

  // Crop tightly around the clean jewellery
  const cleanCutout = await sharp(rgbaBuffer, {
    raw: { width, height, channels: 4 },
  })
    .extract({ left: fullTightX, top: fullTightY, width: tightW, height: tightH })
    .png()
    .toBuffer();

  const forbiddenObjects: string[] = [];
  if (detectedRuler) forbiddenObjects.push('Ruler');
  if (components.some((c) => c.isBorderArtifact)) forbiddenObjects.push('Paper edge');
  if (components.some((c) => c.isDust)) forbiddenObjects.push('Dust');
  if (components.some((c) => c.isProp)) forbiddenObjects.push('Flower/Prop');

  return {
    cleanedBuffer: cleanCutout,
    fullCleanedBuffer: fullClean,
    tightBounds: { x: fullTightX, y: fullTightY, width: tightW, height: tightH },
    hasRuler: detectedRuler,
    rulerBoundingBox: rulerBoxes[0],
    removedArtifactsCount: removedCount,
    originalWidth: width,
    originalHeight: height,
    forbiddenObjects,
  };
}
