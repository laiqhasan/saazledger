import sharp from 'sharp';
import { expandRect, findRulerBands, minGapToRect } from './jewelleryForegroundService';

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
  /** non-fatal notes: uncertain straight structures that were KEPT instead of deleted */
  warnings?: string[];
  /** true when something ruler-like could not be safely separated from jewellery: nothing was removed */
  needsReview?: boolean;
  /** number of straight/thin strands (chains, posts) that old heuristics would have deleted */
  keptStraightStructures?: number;
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
  const warnings: string[] = [];
  let needsReview = false;
  let keptStraightStructures = 0;

  const marginW = Math.round(gridW * 0.18);
  const marginH = Math.round(gridH * 0.18);
  const canvasCenterX = gridW / 2;
  const canvasCenterY = gridH * 0.48;
  const maxGrid = Math.max(gridW, gridH);
  const nearPx = Math.max(3, Math.round(maxGrid * 0.015));

  // ---- Straight-structure policy (see docs/straight-chain-root-cause.md) ---------------------
  // A long, thin, straight component is NOT evidence of a ruler: a chain laid straight, a chain
  // hanging from a hook and an earring post all look like that. A structure may only be removed when
  //   (1) it is POSITIVELY identified as a ruler/scale (thick band + regular tick marks, or a long
  //       uniform solid bar - findRulerBands), AND
  //   (2) it is not connected to / near any jewellery.
  // Anything uncertain is KEPT and reported through `warnings` / `needsReview`.
  const alphaMask = new Uint8Array(gridW * gridH);
  for (let i = 0; i < alphaMask.length; i++) alphaMask[i] = alphaChannel[i] >= ALPHA_THRESH ? 1 : 0;
  const rgbGrid = await sharp(transparentBuffer).resize(gridW, gridH, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const grayGrid = new Uint8Array(gridW * gridH);
  const distGrid = new Uint8Array(gridW * gridH);
  for (let i = 0; i < grayGrid.length; i++) {
    grayGrid[i] = Math.round(0.299 * rgbGrid[i * 3] + 0.587 * rgbGrid[i * 3 + 1] + 0.114 * rgbGrid[i * 3 + 2]);
    distGrid[i] = alphaMask[i] ? 255 : 0;
  }
  const byId = new Map(components.map((c) => [c.id, c]));
  type Rect = { x0: number; y0: number; x1: number; y1: number };
  // `rects` is the union of the ruler bands (an L-shaped pair of rulers is one connected component).
  const markRulerComponents = (
    rects: Rect[],
    evidence: string,
    boxes: Array<{ x: number; y: number; width: number; height: number }>
  ) => {
    const inside = new Map<number, number>();
    const counted = new Uint8Array(gridW * gridH);
    for (const rect of rects) {
      for (let y = rect.y0; y < rect.y1; y++) {
        for (let x = rect.x0; x < rect.x1; x++) {
          const k = y * gridW + x;
          const lbl = labels[k];
          if (lbl > 0 && !counted[k]) {
            counted[k] = 1;
            inside.set(lbl, (inside.get(lbl) || 0) + 1);
          }
        }
      }
    }
    const rulerComps: Component[] = [];
    const mergedComps: Component[] = [];
    for (const [lbl, cnt] of inside) {
      const c = byId.get(lbl)!;
      // A ruler component lies inside the band. Real jewellery sticking out of it (an earring touching
      // the ruler, a chain crossing it) means ruler and jewellery are one connected piece. Only a speck
      // of dust (<= the dust area) may hang off the band.
      const specArea = Math.max(4, Math.round(totalPixels * 0.0006));
      const outside = c.pixelCount - cnt;
      if (outside <= Math.max(specArea, c.pixelCount * 0.005)) rulerComps.push(c);
      else mergedComps.push(c);
    }
    if (rulerComps.length === 0 && mergedComps.length === 0) return;
    const rulerSet = new Set(rulerComps.map((c) => c.id));
    const others = new Uint8Array(gridW * gridH);
    // Specks far smaller than any jewellery part are ignored for the proximity test.
    const specArea = Math.max(4, Math.round(totalPixels * 0.0006));
    for (let i = 0; i < others.length; i++) {
      const lbl = labels[i];
      if (lbl > 0 && !rulerSet.has(lbl) && byId.get(lbl)!.pixelCount >= specArea) others[i] = 1;
    }
    const gap = Math.min(...rects.map((rect) => minGapToRect(others, gridW, gridH, rect)));
    if (mergedComps.length > 0 || gap <= nearPx) {
      needsReview = true;
      warnings.push(
        `needs_review: ruler/scale (${evidence}) ${mergedComps.length > 0 ? 'is connected to' : 'is near'} the jewellery; nothing was removed so no jewellery can be lost.`
      );
      return;
    }
    for (const c of rulerComps) {
      c.isRuler = true;
      c.keep = false;
      removedCount++;
    }
    detectedRuler = true;
    rulerBoxes.push(...boxes);
  };

  const bands = findRulerBands({ width: gridW, height: gridH, looseMask: alphaMask, gray: grayGrid, dist: distGrid });
  if (bands.length > 0) {
    markRulerComponents(
      bands.map((band) => expandRect(band.box, Math.max(2, Math.round(band.thickness * 0.06)), gridW, gridH)),
      bands.map((b) => b.reasons[0]).join('; '),
      bands.map((band) => ({
        x: Math.round(band.box.x0 / scale),
        y: Math.round(band.box.y0 / scale),
        width: Math.round((band.box.x1 - band.box.x0) / scale),
        height: Math.round((band.box.y1 - band.box.y0) / scale),
      }))
    );
  }

  // Caller-supplied ruler bounds (e.g. from vision) count as identification only if the component is
  // thicker than chain scale and not near/connected to jewellery.
  if (options.rulerBounds) {
    const rb = options.rulerBounds;
    const gx = rb.x * scale;
    const gy = rb.y * scale;
    const gw = rb.width * scale;
    const gh = rb.height * scale;
    const rect = {
      x0: Math.max(0, Math.floor(gx)), y0: Math.max(0, Math.floor(gy)),
      x1: Math.min(gridW, Math.ceil(gx + gw)), y1: Math.min(gridH, Math.ceil(gy + gh)),
    };
    const thinInRect = components.some((c) => {
      const overlapX = Math.max(0, Math.min(c.maxX, gx + gw) - Math.max(c.minX, gx));
      const overlapY = Math.max(0, Math.min(c.maxY, gy + gh) - Math.max(c.minY, gy));
      return overlapX * overlapY > (c.maxX - c.minX + 1) * (c.maxY - c.minY + 1) * 0.3 && isChainScale(c, maxGrid);
    });
    if (thinInRect) {
      keptStraightStructures++;
      needsReview = true;
      warnings.push('needs_review: supplied ruler bounds cover a thin chain-scale strand; it was kept.');
    } else {
      markRulerComponents([rect], 'supplied ruler bounds', [rb]);
    }
  }

  // Straight/thin components that the old shape heuristics would have deleted are kept; report them.
  for (const c of components) {
    if (c.isRuler) continue;
    const compW = c.maxX - c.minX + 1;
    const compH = c.maxY - c.minY + 1;
    const elongated = Math.max(compW, compH) / Math.max(1, Math.min(compW, compH)) >= 2.2;
    const touchesEdge = c.minX <= marginW || c.maxX >= gridW - marginW || c.minY <= marginH || c.maxY >= gridH - marginH;
    if (elongated && Math.max(compW, compH) >= maxGrid * 0.2 && touchesEdge && isChainScale(c, maxGrid)) {
      keptStraightStructures++;
      warnings.push('Straight thin strand near the frame edge kept (chain/post-like, no ruler evidence).');
    }
  }

  // Find primary jewellery component among non-ruler, non-border candidates
  const candidateJewellery = components.filter((c) => !c.isRuler);
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
    } else if (touchesEdge && c.pixelCount > totalPixels * 0.08 && !isChainScale(c, maxGrid)) {
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

  const keepLabelSet = new Set(keptComponents.map((c) => c.id));

  // REMOVE-ONLY reconstruction: the output alpha is the ORIGINAL full-resolution alpha everywhere,
  // except inside removed components (dilated by one grid cell), where it is zeroed. Nothing that is
  // kept is resampled, thinned or fattened, and faint/thin strands that were too fine to form a grid
  // component are never touched. (The previous version rebuilt alpha from the 800px grid and
  // re-upscaled it, which also altered thin chains.)
  const origRgba = await sharp(transparentBuffer).ensureAlpha().raw().toBuffer();
  let fullClean = transparentBuffer;
  if (removedCount > 0) {
    const removeGrid = new Uint8Array(gridW * gridH);
    const removedIds = new Set(components.filter((c) => !c.keep).map((c) => c.id));
    for (let i = 0; i < labels.length; i++) if (labels[i] > 0 && removedIds.has(labels[i])) removeGrid[i] = 255;
    const gridRemoved = new Uint8Array(gridW * gridH);
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        if (!removeGrid[y * gridW + x]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < gridW && ny < gridH) gridRemoved[ny * gridW + nx] = 255;
          }
        }
      }
    }
    // pixels of KEPT components stay even if they sit inside the dilated halo of a removed one
    for (let i = 0; i < labels.length; i++) if (labels[i] > 0 && keepLabelSet.has(labels[i])) gridRemoved[i] = 0;
    const fullRemoved =
      width === gridW && height === gridH
        ? Buffer.from(gridRemoved)
        : await sharp(Buffer.from(gridRemoved), { raw: { width: gridW, height: gridH, channels: 1 } })
            .resize(width, height, { fit: 'fill', kernel: 'nearest' })
            .toColourspace('b-w')
            .raw()
            .toBuffer();
    for (let i = 0; i < width * height; i++) if (fullRemoved[i]) origRgba[i * 4 + 3] = 0;
    fullClean = await sharp(origRgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  }

  // Tight bounds from the real full-resolution alpha (not from coarse grid components).
  let tx0 = width, ty0 = height, tx1 = -1, ty1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (origRgba[(y * width + x) * 4 + 3] >= 8) {
        if (x < tx0) tx0 = x;
        if (x > tx1) tx1 = x;
        if (y < ty0) ty0 = y;
        if (y > ty1) ty1 = y;
      }
    }
  }
  if (tx1 < 0) { tx0 = 0; ty0 = 0; tx1 = width - 1; ty1 = height - 1; }
  const fullTightX = tx0;
  const fullTightY = ty0;
  const tightW = Math.max(1, tx1 - tx0 + 1);
  const tightH = Math.max(1, ty1 - ty0 + 1);
  const cleanCutout = await sharp(origRgba, { raw: { width, height, channels: 4 } })
    .extract({ left: fullTightX, top: fullTightY, width: tightW, height: tightH })
    .png()
    .toBuffer();

  if (removedCount === 0) {
    return {
      cleanedBuffer: cleanCutout,
      fullCleanedBuffer: transparentBuffer,
      tightBounds: { x: fullTightX, y: fullTightY, width: tightW, height: tightH },
      hasRuler: false,
      removedArtifactsCount: 0,
      originalWidth: width,
      originalHeight: height,
      warnings,
      needsReview,
      keptStraightStructures,
    };
  }

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
    warnings,
    needsReview,
    keptStraightStructures,
  };
}

/** Thin, strand-like component (chain, hook, post): mean thickness <= ~1.2% of the longest frame side. */
function isChainScale(c: Component, maxGrid: number): boolean {
  const len = Math.max(c.maxX - c.minX + 1, c.maxY - c.minY + 1);
  return c.pixelCount / Math.max(1, len) <= Math.max(3, maxGrid * 0.012);
}
