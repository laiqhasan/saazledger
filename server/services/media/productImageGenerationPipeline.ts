/**
 * Product-locked generation helpers shared by the image pipeline.
 * Provider HTTP calls live only in imageGenerationProvider.ts.
 */
import path from 'path';
import { DATA_DIR } from '../../db/database';
import { DERIVATIVES_DIR, UPLOADS_DIR } from '../photoService';
import { getOrCreateIsolatedMasterPng } from './backgroundRemovalService';
import type { GenerationResult } from './imageGenerationProvider';
import { validateProductFidelity } from './productFidelityValidator';

export const JEWELLERY_PRODUCT_LOCK_PROMPT = [
  'PRODUCT LOCK: Never invent jewellery from text. Edit only the supplied authentic product photograph.',
  'Preserve the exact metal colour and finish (gold stays gold, silver stays silver, rose gold stays rose gold).',
  'Preserve stone count, stone colours, stone shapes, and stone placement. Do not add extra stones.',
  'Preserve chain type, chain length, clasp, pendant, dangling details, and earring pair (exactly two earrings when the source has a pair).',
  'Preserve realistic commercial scale and proportions. Do not enlarge or shrink independently of the source.',
  'Do not redesign, simplify, replace, or restyle the jewellery.',
  'NEGATIVES: no extra stones, no extra earrings, no extra pendant, no redesign, no ruler, no watermark, no logo, no invented brand, no text overlay.',
].join('\n');

export function failedSlotResult(error: string, promptUsed?: string): GenerationResult {
  return {
    success: false,
    promptUsed,
    isDesignLocked: false,
    error,
    statusNotes: error,
  };
}

export function isPathInsideDir(candidate: string, dir: string): boolean {
  const resolved = path.resolve(candidate);
  const root = path.resolve(dir);
  const rel = path.relative(root, resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function isAllowedMediaFilePath(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return (
    isPathInsideDir(resolved, UPLOADS_DIR) ||
    isPathInsideDir(resolved, DERIVATIVES_DIR) ||
    isPathInsideDir(resolved, path.join(DATA_DIR, 'uploads/photos'))
  );
}

export function isOwnPhotoApiPath(raw: string): boolean {
  try {
    const value = raw.trim();
    if (value.startsWith('/api/photos/') || value === '/api/photos') return true;
    if (value.startsWith('http://') || value.startsWith('https://')) {
      const parsed = new URL(value);
      return parsed.pathname.startsWith('/api/photos');
    }
  } catch {
    return false;
  }
  return false;
}

export async function resolveSourceBuffer(params: {
  sourceBuffer?: Buffer;
  isolatedMasterBuffer?: Buffer;
}): Promise<{ buffer: Buffer; inputReferenceUsed: 'ISOLATED_MASTER' | 'ORIGINAL_SOURCE' } | null> {
  if (params.isolatedMasterBuffer && params.isolatedMasterBuffer.length > 0) {
    return { buffer: params.isolatedMasterBuffer, inputReferenceUsed: 'ISOLATED_MASTER' };
  }
  if (params.sourceBuffer && params.sourceBuffer.length > 0) {
    return { buffer: params.sourceBuffer, inputReferenceUsed: 'ORIGINAL_SOURCE' };
  }
  return null;
}

export async function prepareReference(sourceBuffer: Buffer): Promise<Buffer> {
  try {
    const isolated = await getOrCreateIsolatedMasterPng(sourceBuffer);
    if (isolated?.buffer?.length) return isolated.buffer;
  } catch (err: any) {
    console.warn('[ProductImagePipeline] Isolated master unavailable, using original source:', err?.message);
  }
  return sourceBuffer;
}

export async function validateFidelity(
  sourceBuffer: Buffer,
  generatedBuffer: Buffer,
  mode: 'product' | 'scene'
): Promise<{ ok: boolean; reason?: string }> {
  if (mode !== 'product') return { ok: true };
  try {
    const result = await validateProductFidelity(sourceBuffer, generatedBuffer);
    if (result.status === 'failed') {
      return { ok: false, reason: result.issues.join('; ') || 'Fidelity check failed' };
    }
    return { ok: true };
  } catch (err: any) {
    console.warn('[ProductImagePipeline] Fidelity check skipped:', err?.message);
    return { ok: true };
  }
}
