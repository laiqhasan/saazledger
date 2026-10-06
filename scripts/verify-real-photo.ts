/**
 * Offline "real photo verification" tool.
 *
 *   npx tsx scripts/verify-real-photo.ts <path-to-photo.jpg> [--out <dir>] [--label "<text>"] [--require-original-dims 2276x4048]
 *
 * What it does (100% local and deterministic):
 *  - uses a TEMP data dir (never ./data, never ./uploads, never a Railway volume)
 *  - stores your photo there as the immutable original (sha256 + EXIF-oriented size recorded)
 *  - runs the same deterministic Product Accuracy / exact-cutout white-background code the app uses
 *    (generateWhiteProductImage in exact_cutout mode, the code behind POST /api/media/white-cover)
 *  - checks: ruler/forbidden object, complete jewellery inside the white canvas (padding, no clipping),
 *    crop recovery after a bad 2048x2048 derivative really starts from the TRUE original,
 *    your original file is byte-for-byte unchanged, and the jewellery is complete inside the ORIGINAL frame
 *  - F2 COMPLETENESS: every jewellery component found in the original photo (chain segments, pendant,
 *    earrings) must still be in the white output (>= 97% of the jewellery foreground, no component lost);
 *    a per-component retention table is printed and lost regions are highlighted on the contact sheet
 *  - --require-original-dims WxH: FAIL unless the photo's EXIF-oriented size is exactly WxH (proves the run
 *    used the genuine file); the sha256 of the photo is always printed
 *  - writes everything to the --out dir (default ./photo-verification-output/)
 *
 * NO AI / image-generation provider is called: provider API keys are removed from the environment,
 * mode is forced to exact_cutout, and global fetch is replaced with a function that throws and counts
 * any attempt. Background isolation uses the local deterministic path.
 * Exit code is non-zero when any check fails.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------------------------
// Environment hardening MUST happen before any server module is imported (they read env at load).
// ---------------------------------------------------------------------------------------------
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'saaz-verify-photo-'));
process.env.DATA_DIR = path.join(TEMP_ROOT, 'data');
process.env.LEGACY_UPLOADS_DIR = path.join(TEMP_ROOT, 'legacy-uploads', 'photos');
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
for (const k of [
  'PHOTOROOM_API_KEY', 'PHOTOROOM_KEY', 'PHOTOROOM_TOKEN', 'PHOTO_ROOM_API_KEY',
  'REMOVEBG_API_KEY', 'REMOVE_BG_API_KEY', 'CLIPDROP_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_GEMINI_API_KEY', 'VITE_GEMINI_API_KEY',
  'OPENAI_API_KEY', 'VITE_OPENAI_API_KEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_DRIVE_REFRESH_TOKEN',
]) delete process.env[k];
process.env.BG_REMOVAL_PROVIDER = 'local';

const networkAttempts: string[] = [];
(globalThis as any).fetch = async (input: any) => {
  networkAttempts.push(String(input?.url || input));
  throw new Error('Network access is disabled in verify-real-photo (offline tool).');
};

const pipelineLog: string[] = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  (console as any)[level] = (...args: any[]) => {
    pipelineLog.push(`[${level}] ${args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ')}`);
  };
}
function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
const out = (s = '') => process.stdout.write(s + '\n');

// ---------------------------------------------------------------------------------------------

type CheckStatus = 'PASS' | 'FAIL' | 'INFO';
interface Check { id: string; name: string; status: CheckStatus; detail: string }

interface Args { photo: string; outDir: string; label: string | null; requireDims: { width: number; height: number } | null }

function parseArgs(argv: string[]): Args {
  let photo = '';
  let outDir = './photo-verification-output';
  let label: string | null = null;
  let requireDims: { width: number; height: number } | null = null;
  const parseDims = (v: string | undefined) => {
    const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec((v || '').trim());
    if (!m) { out(`ERROR: --require-original-dims expects WIDTHxHEIGHT, e.g. 2276x4048 (got "${v ?? ''}")`); process.exit(2); }
    return { width: Number(m[1]), height: Number(m[2]) };
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') outDir = argv[++i] || outDir;
    else if (a.startsWith('--out=')) outDir = a.slice(6);
    else if (a === '--label') label = argv[++i] ?? null;
    else if (a.startsWith('--label=')) label = a.slice(8);
    else if (a === '--require-original-dims') requireDims = parseDims(argv[++i]);
    else if (a.startsWith('--require-original-dims=')) requireDims = parseDims(a.slice(24));
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if (!photo) photo = a;
  }
  if (!photo) { usage(); process.exit(2); }
  return { photo, outDir, label, requireDims };
}
function usage() {
  out('Usage: npx tsx scripts/verify-real-photo.ts <path-to-photo.jpg> [--out <dir>] [--label "<text>"] [--require-original-dims 2276x4048]');
}

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const pct = (f: number) => `${(f * 100).toFixed(2)}%`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const photoPath = path.resolve(args.photo);
  if (!fs.existsSync(photoPath) || !fs.statSync(photoPath).isFile()) {
    out(`ERROR: photo not found: ${photoPath}`);
    process.exit(2);
  }
  const outDir = path.resolve(args.outDir);
  fs.mkdirSync(outDir, { recursive: true });

  const sharp = (await import('sharp')).default;
  const integritySvc = await import('../server/services/media/outputIntegrityService');
  const det = await import('../server/services/media/deterministicImageService');
  const pipeline = await import('../server/services/media/mediaPipelineService');
  const photoSvc = await import('../server/services/photoService');
  const gallery = await import('../server/services/media/galleryPackService');
  const gate = await import('../server/services/media/jewelleryForegroundService');
  const { DATA_DIR } = await import('../server/db/database');

  // Safety: the data dir the server code resolved MUST be our temp dir.
  if (!path.resolve(DATA_DIR).startsWith(TEMP_ROOT) || !path.resolve(photoSvc.UPLOADS_DIR).startsWith(TEMP_ROOT)) {
    out(`ERROR: refusing to run, data dir is not the temp dir (${DATA_DIR}).`);
    process.exit(3);
  }

  const checks: Check[] = [];
  const add = (id: string, name: string, ok: boolean | null, detail: string) =>
    checks.push({ id, name, status: ok === null ? 'INFO' : ok ? 'PASS' : 'FAIL', detail });

  const warnings: string[] = [];
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const rel = path.relative(repoRoot, photoPath);
  if (!args.label && (rel.startsWith(path.join('data', 'uploads')) || rel.startsWith('uploads'))) {
    warnings.push('The photo is inside this repo\'s data/uploads folder. Files there may be synthetic test fixtures. Pass --label to mark what this is.');
  }

  // ----- the immutable original ------------------------------------------------------------
  const fileBytes = fs.readFileSync(photoPath);
  const statBefore = fs.statSync(photoPath);
  const shaBefore = sha256(fileBytes);
  const filename = path.basename(photoPath);
  const mediaId = path.basename(filename, path.extname(filename)).replace(/[^A-Za-z0-9_-]/g, '_');

  const saved = photoSvc.savePhotoBuffer(fileBytes, filename);
  const originalRef = await integritySvc.describeOriginalAsset(fileBytes, { mediaId, url: saved.url, filename });
  const storedPath = path.join(photoSvc.UPLOADS_DIR, saved.filename);
  const storedMatches = fs.existsSync(storedPath) && sha256(fs.readFileSync(storedPath)) === shaBefore;
  const rawMeta = await sharp(fileBytes).metadata();
  out(`Photo   : ${filename}`);
  out(`SHA-256 : ${shaBefore}`);
  out(`Size    : ${fileBytes.length} bytes; EXIF-oriented ${originalRef.width}x${originalRef.height}`);
  if (args.requireDims) {
    const okDims = originalRef.width === args.requireDims.width && originalRef.height === args.requireDims.height;
    add('O1', `Photo is the required ${args.requireDims.width}x${args.requireDims.height} (EXIF-oriented) - proves this is the genuine file`, okDims,
      `EXIF-oriented ${originalRef.width}x${originalRef.height} (raw ${rawMeta.width}x${rawMeta.height}, orientation ${rawMeta.orientation ?? 1}); required ${args.requireDims.width}x${args.requireDims.height}; sha256=${shaBefore}`);
    if (!okDims) out(`DIMENSION MISMATCH: required ${args.requireDims.width}x${args.requireDims.height}, got ${originalRef.width}x${originalRef.height}. This is NOT the expected photo.`);
  }

  const copyName = `original_copy${path.extname(filename).toLowerCase() || '.jpg'}`;
  const copyPath = path.join(outDir, copyName);
  if (path.resolve(copyPath) === photoPath) throw new Error('Refusing to overwrite the original photo.');
  fs.writeFileSync(copyPath, fileBytes);

  // ----- (a) forbidden object (ruler) ---------------------------------------------------------
  const rulerDetection = await integritySvc.detectRulerStructure(fileBytes);
  const galleryVal = await det.validateGalleryAsset(fileBytes, 'REAL_PHOTO');
  const rulerFired = rulerDetection.detected || galleryVal.forbiddenObjects.includes('ruler');
  add('A1', 'Forbidden-object (ruler) check did NOT fire on the original photo', !rulerFired,
    `detectRulerStructure.detected=${rulerDetection.detected}; validateGalleryAsset.forbiddenObjects=[${galleryVal.forbiddenObjects.join(', ')}]`);

  // source subject complete inside original frame
  const srcSubject = await integritySvc.analyzeSourceSubject(fileBytes);
  let sourceEdges: string[] = [];
  if (srcSubject) {
    const b = srcSubject.bbox;
    const tol = 0.0035;
    if (b.x <= tol) sourceEdges.push('left');
    if (b.x + b.width >= 1 - tol) sourceEdges.push('right');
    if (b.y <= tol) sourceEdges.push('top');
    if (b.y + b.height >= 1 - tol) sourceEdges.push('bottom');
  }
  add('F1', 'Jewellery is complete inside the ORIGINAL photo frame (not already cut off)', srcSubject !== null && sourceEdges.length === 0,
    srcSubject
      ? `subject bbox in original: x=${pct(srcSubject.bbox.x)} y=${pct(srcSubject.bbox.y)} w=${pct(srcSubject.bbox.width)} h=${pct(srcSubject.bbox.height)}; touches frame edge: [${sourceEdges.join(', ') || 'none'}]`
      : 'no subject could be detected in the original photo');

  // ----- (b) white-background output ------------------------------------------------------------
  let whiteBuf: Buffer | null = null;
  let whiteInfo: any = null;
  let whiteError: string | null = null;
  const expectedDims = pipeline.resolveWhiteProductDimensions('1:1');
  let segmentation = 'not run';
  try {
    // Offline stand-in for PhotoRoom: seed the isolated-master cache (the same cache the app reuses) with a
    // local colour-key cutout, so the REAL framing / cleanup / quality / integrity code runs on it.
    const bgSvc = await import('../server/services/media/backgroundRemovalService');
    const { localColourKeyCutout } = await import('./local-cutout');
    const cut = await localColourKeyCutout(fileBytes);
    const master = bgSvc.getIsolatedMasterPath(bgSvc.getSourceHash(fileBytes));
    fs.mkdirSync(path.dirname(master.filepath), { recursive: true });
    fs.writeFileSync(master.filepath, cut.png);
    segmentation = `LOCAL colour-key cutout (offline stand-in for PhotoRoom); background rgb(${cut.backgroundRgb.join(',')}); foreground ${pct(cut.foregroundRatio)} of the photo`;
  } catch (e: any) {
    segmentation = `local cutout failed: ${e?.message || e}`;
  }
  try {
    // Same call (and same occupancy default) as POST /api/media/white-cover with Product Accuracy.
    const result = await pipeline.generateWhiteProductImage(fileBytes, `white_${mediaId}`, {
      mode: 'exact_cutout',
      outputRatio: '1:1',
      occupancyPercent: 80,
    });
    const diskFile = path.join(photoSvc.DERIVATIVES_DIR, path.basename(result.url));
    whiteBuf = fs.existsSync(diskFile) ? fs.readFileSync(diskFile) : photoSvc.getDerivative(path.basename(result.url))?.buffer || null;
    whiteInfo = result;
  } catch (e: any) {
    whiteError = e?.message || String(e);
  }

  let integrity: Awaited<ReturnType<typeof integritySvc.analyzeOutputIntegrity>> | null = null;
  let whiteDims = { width: 0, height: 0 };
  let bboxPx: { x: number; y: number; width: number; height: number } | null = null;
  let padPx: { left: number; right: number; top: number; bottom: number } | null = null;
  let cornersWhite = false;
  if (whiteBuf) {
    whiteDims = await integritySvc.getOrientedDimensions(whiteBuf);
    integrity = await integritySvc.analyzeOutputIntegrity(whiteBuf, { source: srcSubject });
    if (integrity.subjectBox && integrity.padding) {
      const sb = integrity.subjectBox;
      bboxPx = {
        x: Math.round(sb.x * whiteDims.width), y: Math.round(sb.y * whiteDims.height),
        width: Math.round(sb.width * whiteDims.width), height: Math.round(sb.height * whiteDims.height),
      };
      padPx = {
        left: Math.round(integrity.padding.left * whiteDims.width), right: Math.round(integrity.padding.right * whiteDims.width),
        top: Math.round(integrity.padding.top * whiteDims.height), bottom: Math.round(integrity.padding.bottom * whiteDims.height),
      };
    }
    const { data, info } = await sharp(whiteBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => { const o = (y * info.width + x) * info.channels; return [data[o], data[o + 1], data[o + 2]]; };
    cornersWhite = [px(0, 0), px(info.width - 1, 0), px(0, info.height - 1), px(info.width - 1, info.height - 1)].every((c) => c.every((v) => v >= 250));
    fs.writeFileSync(path.join(outDir, 'white_background.jpg'), whiteBuf);
  }

  add('B1', 'White-background image generated (Product Accuracy / exact cutout, offline)', whiteBuf !== null,
    whiteError ? `generation failed: ${whiteError}` : `mode=${whiteInfo?.mode}; segmentation=${segmentation}; pipeline outputStatus=${whiteInfo?.outputStatus}`);
  add('B2', 'Output canvas is the expected 1:1 size', whiteBuf !== null && whiteDims.width === expectedDims.width && whiteDims.height === expectedDims.height,
    `output ${whiteDims.width}x${whiteDims.height}, expected ${expectedDims.width}x${expectedDims.height}`);
  add('B3', 'Complete jewellery inside canvas, no clipping (outputIntegrityService)',
    integrity !== null && integrity.ok && integrity.touchedEdges.length === 0 && !integrity.isClipped && !integrity.isBlank && !integrity.isTooSmall,
    integrity
      ? `status=${integrity.status}; clipped=${integrity.isClipped}; blank=${integrity.isBlank}; tooSmall=${integrity.isTooSmall}; touchedEdges=[${integrity.touchedEdges.join(', ')}]${integrity.issues.length ? '; issues: ' + integrity.issues.join(' | ') : ''}`
      : 'no output to analyse');
  add('B4', 'Output background corners are pure white', whiteBuf !== null && cornersWhite, whiteBuf ? `corners >=250 on all channels: ${cornersWhite}` : 'no output');
  add('B5', 'Pipeline verdict allows the exact-match label (ready, no forbidden object in output)',
    whiteInfo?.outputStatus === 'ready' && whiteInfo?.matchLabelAllowed === true,
    whiteInfo ? `outputStatus=${whiteInfo.outputStatus}; matchLabelAllowed=${whiteInfo.matchLabelAllowed}; validatorForbiddenObjects=[${(whiteInfo.validatorForbiddenObjects || []).join(', ')}]; issues=[${(whiteInfo.outputIssues || []).join(' | ')}]` : 'no pipeline result');

  // ----- F2: jewellery completeness (chain segments, pendant, earrings must all survive) --------------------
  let completeness: Awaited<ReturnType<typeof gate.evaluateJewelleryCompleteness>> | null = null;
  let completenessError: string | null = null;
  if (whiteBuf) {
    try {
      completeness = await gate.evaluateJewelleryCompleteness(fileBytes, whiteBuf, { includeLostMask: true });
    } catch (e: any) {
      completenessError = e?.message || String(e);
    }
  }
  add('F2', `Jewellery foreground retention >= ${(gate.DEFAULT_MIN_RETENTION * 100).toFixed(0)}% with NO jewellery component lost (chain, pendant, earrings)`,
    completeness !== null && completeness.applicable && completeness.pass,
    completeness
      ? `retained ${completeness.retainedPercent.toFixed(1)}% of the original jewellery foreground; components ${completeness.retainedComponentCount}/${completeness.sourceComponentCount} kept; status=${completeness.status}${completeness.issues.length ? '; ' + completeness.issues.join(' | ') : ''}${completeness.applicable ? '' : ' (gate not applicable: no jewellery foreground found in the original - treated as FAIL)'}`
      : `completeness gate did not run: ${completenessError ?? 'no white output'}`);

  // ----- (c) crop recovery after a bad 2048 derivative -----------------------------------------------
  // Reproduce the bad scenario: a 2048x2048 square derivative that was made by cover-cropping the photo.
  const badDerivative = await sharp(fileBytes).rotate().resize(2048, 2048, { fit: 'cover' }).jpeg({ quality: 92 }).toBuffer();
  const badName = `${mediaId}_shopify_2048.jpg`;
  const badSaved = photoSvc.saveDerivativeBuffer(badDerivative, badName);
  const badDims = await integritySvc.getOrientedDimensions(badDerivative);
  fs.writeFileSync(path.join(outDir, 'bad_derivative_2048.jpg'), badDerivative);

  add('C1', 'Bad 2048x2048 derivative reproduced and recognised as a derivative (not the original)',
    integritySvc.isDerivativeReference(badSaved.url) && (badDims.width !== originalRef.width || badDims.height !== originalRef.height) && sha256(badDerivative) !== shaBefore,
    `derivative ${badDims.width}x${badDims.height} url=${badSaved.url} isDerivativeReference=${integritySvc.isDerivativeReference(badSaved.url)}`);

  const refusal = await integritySvc.verifyAgainstOriginal(badDerivative, originalRef);
  add('C2', 'Crop recovery REFUSES the derivative as a source', refusal !== null, `verifyAgainstOriginal(derivative) => ${refusal ?? 'null (accepted - BAD)'}`);

  // Same steps as POST /api/media/crop with sourceOriginal: load the recorded original url, verify, crop.
  const recoveredSource = gallery.getItemBuffer({ url: originalRef.url, originalUrl: originalRef.url });
  let srcDims = { width: 0, height: 0 };
  let recoveredSha = '';
  let mismatch: string | null = 'original could not be loaded';
  if (recoveredSource) {
    srcDims = await integritySvc.getOrientedDimensions(recoveredSource);
    recoveredSha = sha256(recoveredSource);
    mismatch = await integritySvc.verifyAgainstOriginal(recoveredSource, originalRef);
  }
  const sourceIsTrueOriginal =
    recoveredSource !== null && mismatch === null &&
    srcDims.width === originalRef.width && srcDims.height === originalRef.height && recoveredSha === shaBefore;
  add('C3', 'Crop-recovery source IS the true original (same dimensions and sha256)', sourceIsTrueOriginal,
    `crop source ${srcDims.width}x${srcDims.height} sha256=${recoveredSha.slice(0, 16)}...; original ${originalRef.width}x${originalRef.height} sha256=${shaBefore.slice(0, 16)}...; verify=${mismatch ?? 'ok'}`);

  let cropBuf: Buffer | null = null;
  let cropRect: any = null;
  let cropErr: string | null = null;
  if (recoveredSource && sourceIsTrueOriginal) {
    try {
      cropRect = await det.detectJewelryAutoCrop(recoveredSource, 'necklace_set');
      const crop = await det.applyNonDestructiveCrop(recoveredSource, { ...cropRect, aspectRatio: '1:1', filename: `crop_recovery_${mediaId}.jpg` }, 2048);
      cropBuf = crop.buffer;
      fs.writeFileSync(path.join(outDir, 'crop_recovery.jpg'), cropBuf);
    } catch (e: any) {
      cropErr = e?.message || String(e);
    }
  }
  let cropIntegrity: Awaited<ReturnType<typeof integritySvc.analyzeOutputIntegrity>> | null = null;
  if (cropBuf) cropIntegrity = await integritySvc.analyzeOutputIntegrity(cropBuf, { source: srcSubject });
  add('C4', 'Recovered crop written (cut from the true original, fitted into 2048x2048 with white padding)', cropBuf !== null,
    cropBuf ? `crop rect (source px/fractions) ${safeJson(cropRect)}; output ${(await integritySvc.getOrientedDimensions(cropBuf)).width}x${(await integritySvc.getOrientedDimensions(cropBuf)).height}` : `crop failed: ${cropErr ?? 'skipped (source was not the true original)'}`);
  add('C5', 'Recovered crop keeps the whole jewellery inside its canvas (informational)', null,
    cropIntegrity ? `status=${cropIntegrity.status}; touchedEdges=[${cropIntegrity.touchedEdges.join(', ')}]; issues=${cropIntegrity.issues.join(' | ') || 'none'}` : 'no crop');

  // ----- (d) original unchanged -------------------------------------------------------------------
  const bytesAfter = fs.readFileSync(photoPath);
  const statAfter = fs.statSync(photoPath);
  const shaAfter = sha256(bytesAfter);
  const storedAfter = fs.existsSync(storedPath) ? sha256(fs.readFileSync(storedPath)) : '';
  add('D1', 'Original file bytes unchanged (sha256 before == after, size and mtime too)',
    shaBefore === shaAfter && statBefore.size === statAfter.size && statBefore.mtimeMs === statAfter.mtimeMs,
    `before=${shaBefore}; after=${shaAfter}; size ${statBefore.size}->${statAfter.size}; mtime unchanged=${statBefore.mtimeMs === statAfter.mtimeMs}`);
  add('D2', 'Stored immutable original (temp data dir) is byte-identical to your file and still unchanged after the run',
    storedMatches && storedAfter === shaBefore, `stored sha256=${storedAfter}`);
  const copyOk = sha256(fs.readFileSync(copyPath)) === shaBefore;
  add('D3', `Copy of the original in the output folder (${copyName}) is byte-identical`, copyOk, `sha256=${shaBefore}`);

  // ----- (e) no provider / network ---------------------------------------------------------------------
  add('G1', 'No AI provider / network call was made (keys removed, fetch blocked)', networkAttempts.length === 0,
    `blocked network attempts: ${networkAttempts.length}${networkAttempts.length ? ' -> ' + networkAttempts.join(', ') : ''}`);

  const failed = checks.filter((c) => c.status === 'FAIL');
  const overall: 'PASS' | 'FAIL' = failed.length === 0 ? 'PASS' : 'FAIL';

  // ----- contact sheet ------------------------------------------------------------------------------------
  const panelBox = 640;
  const capH = 74;
  const lostNames = completeness ? completeness.lostRegions.map((r) => `${r.label} ${r.retainedPercent.toFixed(0)}%`) : [];
  let lostOverlay: Buffer | null = null;
  if (completeness?.lostMask) {
    const { width: lw, height: lh, data } = completeness.lostMask;
    const grown = gate.dilateRect(data, lw, lh, 4, 4);
    const rgba = Buffer.alloc(lw * lh * 4);
    for (let i = 0; i < grown.length; i++) if (grown[i]) { rgba[i * 4] = 230; rgba[i * 4 + 1] = 20; rgba[i * 4 + 2] = 20; rgba[i * 4 + 3] = 215; }
    lostOverlay = await sharp(rgba, { raw: { width: lw, height: lh, channels: 4 } }).png().toBuffer();
  }
  const panels: Array<{ title: string; sub: string; buf: Buffer | null; bbox?: typeof bboxPx; lost?: boolean }> = [
    {
      title: lostNames.length ? 'ORIGINAL - RED = JEWELLERY LOST IN OUTPUT' : 'ORIGINAL (unchanged)',
      sub: `${originalRef.width}x${originalRef.height}  retention ${completeness ? completeness.retainedPercent.toFixed(1) + '%' : 'n/a'}${lostNames.length ? '  LOST: ' + lostNames.join(', ') : ''}`,
      buf: fileBytes,
      lost: true,
    },
    { title: 'WHITE BACKGROUND (exact cutout)', sub: whiteBuf ? `${whiteDims.width}x${whiteDims.height}  ${integrity?.ok ? 'PASS' : 'FAIL'}  (red = subject box)` : 'not generated', buf: whiteBuf, bbox: bboxPx },
    { title: 'BAD 2048 DERIVATIVE (refused as source)', sub: `${badDims.width}x${badDims.height}`, buf: badDerivative },
    { title: 'CROP RECOVERY (from true original)', sub: cropBuf ? `source ${srcDims.width}x${srcDims.height}, sha ${recoveredSha.slice(0, 8)}` : 'not generated', buf: cropBuf },
  ];
  const bannerH = 110;
  const gap = 16;
  const sheetW = gap + panels.length * (panelBox + gap);
  const sheetH = bannerH + panelBox + capH + gap * 2;
  const composites: any[] = [];
  const bannerText = args.label ? args.label : 'Real photo verification';
  const bannerColor = overall === 'PASS' ? '#1b7a3a' : '#b3261e';
  composites.push({
    input: Buffer.from(`<svg width="${sheetW}" height="${bannerH}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#222"/>
      <text x="${gap}" y="46" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="bold" fill="#ffd84d">${esc(bannerText)}</text>
      <text x="${gap}" y="88" font-family="Helvetica, Arial, sans-serif" font-size="26" fill="#fff">${esc(filename)}  |  sha256 ${shaBefore.slice(0, 16)}...  |  OVERALL: </text>
      <text x="${gap + 1000}" y="88" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="bold" fill="${overall === 'PASS' ? '#6cf29a' : '#ff8a80'}">${overall}</text>
    </svg>`),
    left: 0, top: 0,
  });
  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    const left = gap + i * (panelBox + gap);
    const top = bannerH + gap;
    composites.push({ input: await sharp({ create: { width: panelBox, height: panelBox, channels: 3, background: '#e6e6e6' } }).png().toBuffer(), left, top });
    if (p.buf) {
      const resized = await sharp(p.buf).rotate().resize(panelBox, panelBox, { fit: 'inside', background: '#e6e6e6' }).png().toBuffer({ resolveWithObject: true });
      const ox = Math.round((panelBox - resized.info.width) / 2);
      const oy = Math.round((panelBox - resized.info.height) / 2);
      composites.push({ input: resized.data, left: left + ox, top: top + oy });
      if (p.lost && completeness) {
        const layers: any[] = [];
        if (lostOverlay) layers.push({ input: await sharp(lostOverlay).resize(resized.info.width, resized.info.height, { fit: 'fill' }).png().toBuffer(), left: left + ox, top: top + oy });
        const rects = completeness.lostRegions.map((r) =>
          `<rect x="${r.bbox.x * resized.info.width}" y="${r.bbox.y * resized.info.height}" width="${r.bbox.width * resized.info.width}" height="${r.bbox.height * resized.info.height}" fill="none" stroke="#e53935" stroke-width="4" stroke-dasharray="10 6"/>`
        ).join('');
        if (rects) layers.push({ input: Buffer.from(`<svg width="${resized.info.width}" height="${resized.info.height}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`), left: left + ox, top: top + oy });
        composites.push(...layers);
      }
      if (p.bbox && whiteDims.width) {
        const s = resized.info.width / whiteDims.width;
        composites.push({
          input: Buffer.from(`<svg width="${resized.info.width}" height="${resized.info.height}" xmlns="http://www.w3.org/2000/svg"><rect x="${p.bbox.x * s}" y="${p.bbox.y * s}" width="${p.bbox.width * s}" height="${p.bbox.height * s}" fill="none" stroke="#e53935" stroke-width="3"/></svg>`),
          left: left + ox, top: top + oy,
        });
      }
    }
    composites.push({
      input: Buffer.from(`<svg width="${panelBox}" height="${capH}" xmlns="http://www.w3.org/2000/svg">
        <text x="4" y="30" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="bold" fill="#111">${esc(p.title)}</text>
        <text x="4" y="60" font-family="Helvetica, Arial, sans-serif" font-size="20" fill="#333">${esc(p.sub)}</text></svg>`),
      left, top: top + panelBox + 4,
    });
  }
  const contactSheetPath = path.join(outDir, 'contact_sheet.png');
  await sharp({ create: { width: sheetW, height: sheetH, channels: 3, background: '#f7f7f7' } }).composite(composites).png().toFile(contactSheetPath);

  // ----- reports ----------------------------------------------------------------------------------------------
  const report = {
    tool: 'scripts/verify-real-photo.ts',
    generatedAt: new Date().toISOString(),
    label: args.label,
    overall,
    input: { path: photoPath, filename, sha256: shaBefore, bytes: fileBytes.length, rawWidth: rawMeta.width, rawHeight: rawMeta.height, exifOrientation: rawMeta.orientation ?? 1, orientedWidth: originalRef.width, orientedHeight: originalRef.height },
    mode: 'exact_cutout (Product Accuracy) - deterministic, offline; no AI provider called',
    segmentation,
    tempDataDir: TEMP_ROOT + ' (deleted on exit)',
    forbiddenObjectCheck: { rulerFired, rulerDetection, validateGalleryAsset: galleryVal },
    whiteBackground: whiteBuf
      ? { width: whiteDims.width, height: whiteDims.height, subjectBoxPx: bboxPx, paddingPx: padPx, paddingFraction: integrity?.padding, integrityStatus: integrity?.status, touchedEdges: integrity?.touchedEdges, issues: integrity?.issues, pipelineOutputStatus: whiteInfo?.outputStatus }
      : { error: whiteError },
    jewelleryCompleteness: completeness ? { ...completeness, lostMask: undefined } : { error: completenessError },
    cropRecovery: { badDerivative: { width: badDims.width, height: badDims.height, sha256: sha256(badDerivative) }, sourceUsed: { width: srcDims.width, height: srcDims.height, sha256: recoveredSha, isTrueOriginal: sourceIsTrueOriginal }, cropRect, error: cropErr },
    originalUnchanged: { sha256Before: shaBefore, sha256After: shaAfter, unchanged: shaBefore === shaAfter },
    networkAttempts: networkAttempts.length,
    warnings,
    checks,
    outputFiles: ['original_copy' + path.extname(filename).toLowerCase(), 'white_background.jpg', 'crop_recovery.jpg', 'bad_derivative_2048.jpg', 'contact_sheet.png', 'report.json', 'report.txt', 'pipeline.log'],
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'pipeline.log'), pipelineLog.join('\n'));

  const L: string[] = [];
  const bar = '='.repeat(78);
  L.push(bar);
  if (args.label) L.push(args.label.toUpperCase());
  L.push('REAL PHOTO VERIFICATION REPORT');
  L.push(bar);
  L.push(`Generated   : ${report.generatedAt}`);
  L.push(`Photo       : ${filename}`);
  L.push(`SHA-256     : ${shaBefore}`);
  L.push(`Size        : ${fileBytes.length} bytes; raw ${rawMeta.width}x${rawMeta.height}, EXIF orientation ${rawMeta.orientation ?? 1}`);
  L.push(`Oriented    : ${originalRef.width}x${originalRef.height} (this is what the crop editor should show)`);
  L.push(`Mode        : Product Accuracy / exact cutout, deterministic and offline (no AI provider called)`);
  L.push(`Segmentation: ${segmentation}`);
  L.push(`              (PhotoRoom is NOT used. Framing/padding/clipping and original-file handling are verified;`);
  L.push(`               the cutout EDGE quality of the app's real PhotoRoom step is not.)`);
  for (const w of warnings) L.push(`WARNING     : ${w}`);
  L.push('');
  L.push(`OVERALL RESULT: ${overall}${failed.length ? `  (${failed.length} check(s) failed: ${failed.map((c) => c.id).join(', ')})` : ''}`);
  L.push('');
  L.push('(a) Forbidden-object (ruler) check');
  L.push(`    ruler detected on original: ${rulerFired ? 'YES (check fired)' : 'no (check did not fire)'}`);
  L.push('');
  L.push('(b) White-background output');
  if (whiteBuf && bboxPx && padPx && integrity) {
    L.push(`    output dimensions : ${whiteDims.width}x${whiteDims.height}`);
    L.push(`    subject bbox      : x=${bboxPx.x} y=${bboxPx.y} w=${bboxPx.width} h=${bboxPx.height} (px in the canvas)`);
    L.push(`    padding per side  : left=${padPx.left}px (${pct(integrity.padding!.left)})  right=${padPx.right}px (${pct(integrity.padding!.right)})  top=${padPx.top}px (${pct(integrity.padding!.top)})  bottom=${padPx.bottom}px (${pct(integrity.padding!.bottom)})`);
    L.push(`    complete jewellery inside canvas, no clipping: ${checks.find((c) => c.id === 'B3')!.status}`);
  } else {
    L.push(`    NOT GENERATED${whiteError ? ': ' + whiteError : ''}`);
    L.push(`    complete jewellery inside canvas, no clipping: ${checks.find((c) => c.id === 'B3')!.status}`);
  }
  L.push('');
  L.push('(f) Jewellery completeness (F2) - original-photo jewellery foreground vs white output');
  if (completeness && completeness.applicable) {
    const byKind = new Map<string, { total: number; kept: number }>();
    for (const r of completeness.regions) {
      const k = r.kind === 'detail' ? 'details' : r.kind === 'earring' ? 'earrings' : r.kind;
      const e = byKind.get(k) || { total: 0, kept: 0 };
      e.total += r.areaPx;
      e.kept += (r.areaPx * r.retainedPercent) / 100;
      byKind.set(k, e);
    }
    L.push(`    OVERALL retained  : ${completeness.retainedPercent.toFixed(1)}% of the jewellery foreground (required >= ${(completeness.threshold * 100).toFixed(0)}%)  -> ${completeness.pass ? 'PASS' : 'FAIL (' + completeness.status + ')'}`);
    L.push(`    components        : ${completeness.retainedComponentCount} of ${completeness.sourceComponentCount} kept, ${completeness.missingComponentCount} missing`);
    L.push(`    by part           : ${['chain', 'pendant', 'earrings', 'details'].filter((k) => byKind.has(k)).map((k) => `${k} ${((byKind.get(k)!.kept / Math.max(1, byKind.get(k)!.total)) * 100).toFixed(1)}%`).join('   ')}`);
    L.push('    region                                   kind      source px   share   retained   status');
    for (const r of completeness.regions) {
      L.push(`    ${r.label.padEnd(40)} ${r.kind.padEnd(8)} ${String(r.areaPx).padStart(10)} ${(r.sharePercent.toFixed(1) + '%').padStart(7)} ${(r.retainedPercent.toFixed(1) + '%').padStart(9)}   ${r.status === 'ok' ? 'ok' : r.status.toUpperCase() + '  <-- LOST'}`);
    }
    L.push('    connected components (source)  id  share  retained');
    for (const c of completeness.components) {
      L.push(`      component ${c.id}: ${(c.sharePercent.toFixed(1) + '%').padStart(6)} of jewellery, ${(c.retainedPercent.toFixed(1) + '%').padStart(6)} retained${c.missing ? '  <-- MISSING' : ''}   bbox x=${(c.bbox.x * 100).toFixed(0)}% y=${(c.bbox.y * 100).toFixed(0)}% w=${(c.bbox.width * 100).toFixed(0)}% h=${(c.bbox.height * 100).toFixed(0)}%`);
    }
    for (const i of completeness.issues) L.push(`    ISSUE: ${i}`);
    for (const w of completeness.warnings) L.push(`    note : ${w}`);
    L.push('    (region names are geometric guesses: "pendant" = largest compact body, "earring" = other compact bodies,');
    L.push('     thin strands = chain / hooks / posts. Lost areas are painted red on the ORIGINAL panel of contact_sheet.png.)');
  } else {
    L.push(`    NOT AVAILABLE: ${completenessError ?? (completeness ? 'no jewellery foreground found in the original photo' : 'no white output')}`);
  }
  L.push('');
  L.push('(c) Crop recovery after a bad 2048x2048 derivative');
  L.push(`    bad derivative    : ${badDims.width}x${badDims.height} (refused as a source: ${refusal ? 'yes' : 'NO'})`);
  L.push(`    crop source used  : ${srcDims.width}x${srcDims.height}, sha256 ${recoveredSha}`);
  L.push(`    true original     : ${originalRef.width}x${originalRef.height}, sha256 ${shaBefore}`);
  L.push(`    source is the true original: ${sourceIsTrueOriginal ? 'YES' : 'NO'}`);
  L.push('');
  L.push('(d) Original file bytes');
  L.push(`    sha256 before : ${shaBefore}`);
  L.push(`    sha256 after  : ${shaAfter}`);
  L.push(`    unchanged     : ${shaBefore === shaAfter ? 'YES' : 'NO'}`);
  L.push('');
  L.push('All checks');
  for (const c of checks) {
    L.push(`  [${c.status}] ${c.id}  ${c.name}`);
    L.push(`         ${c.detail}`);
  }
  L.push('');
  L.push(`Files written to ${outDir}:`);
  for (const f of report.outputFiles) L.push(`  ${f}`);
  L.push(bar);
  const text = L.join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, 'report.txt'), text);
  out(text);

  return overall === 'PASS' ? 0 : 1;
}

function cleanup() {
  try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on('exit', cleanup);

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stdout.write(`ERROR: ${err?.stack || err}\n`);
    process.exit(2);
  }
);
