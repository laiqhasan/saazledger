import type { DuplicateCheckResult, JewelryItem } from '../types/inventory';

/**
 * Pads a number to 5 digits (e.g. 1 -> "00001", 12 -> "00012")
 */
export function formatSerial(num: number): string {
  return String(num).padStart(5, '0');
}

/**
 * Builds standard SKU string: [Type] + [Stone] + [Color] + [Serial]
 * e.g., PD + J + 12 + 00001 -> PDJ12-00001
 */
export function buildSku(typeCode: string, stoneCode: string, colorCode: string, serial: string): string {
  const cleanType = (typeCode || '').trim().toUpperCase();
  const cleanStone = (stoneCode || '').trim().toUpperCase();
  const cleanColor = (colorCode || '').trim().toUpperCase();
  const cleanSerial = (serial || '').trim();
  return `${cleanType}${cleanStone}${cleanColor}-${cleanSerial}`;
}

/**
 * Finds next free 5-digit serial number for the exact Type + Stone + Color combo
 */
export function getNextSerialForCombo(
  typeCode: string,
  stoneCode: string,
  colorCode: string,
  inventory: JewelryItem[]
): string {
  const matchingItems = inventory.filter(
    (item) =>
      item.typeCode.toUpperCase() === typeCode.toUpperCase() &&
      item.stoneCode.toUpperCase() === stoneCode.toUpperCase() &&
      item.colorCode.toUpperCase() === colorCode.toUpperCase()
  );

  if (matchingItems.length === 0) {
    return '00001';
  }

  let maxSerial = 0;
  for (const item of matchingItems) {
    const num = parseInt(item.serial, 10);
    if (!isNaN(num) && num > maxSerial) {
      maxSerial = num;
    }
  }

  return formatSerial(maxSerial + 1);
}

/**
 * Multi-layer duplicate prevention check
 */
export function checkItemDuplicates(params: {
  typeCode: string;
  stoneCode: string;
  colorCode: string;
  serial: string;
  sku: string;
  inventory: JewelryItem[];
  excludeItemId?: string;
  imageHash?: string;
}): DuplicateCheckResult {
  const { typeCode, stoneCode, colorCode, sku, inventory, excludeItemId, imageHash } = params;

  // Filter out current item if editing
  const activeInventory = excludeItemId
    ? inventory.filter((item) => item.id !== excludeItemId)
    : inventory;

  // Layer 1: Exact SKU Block
  const exactSkuMatch = activeInventory.find(
    (item) => item.sku.trim().toUpperCase() === sku.trim().toUpperCase()
  );

  if (exactSkuMatch) {
    return {
      status: 'exact_sku_conflict',
      conflictingItem: exactSkuMatch,
      message: `Duplicate SKU detected! SKU "${exactSkuMatch.sku}" is already assigned to "${exactSkuMatch.title}". Every piece must possess a unique SKU.`,
    };
  }

  // Layer 2: Similar Combo Warning (Type + Stone + Color matches existing stock)
  const comboMatch = activeInventory.find(
    (item) =>
      item.typeCode.toUpperCase() === typeCode.toUpperCase() &&
      item.stoneCode.toUpperCase() === stoneCode.toUpperCase() &&
      item.colorCode.toUpperCase() === colorCode.toUpperCase()
  );

  if (comboMatch) {
    const nextFreeSerial = getNextSerialForCombo(typeCode, stoneCode, colorCode, activeInventory);
    const nextFreeSku = buildSku(typeCode, stoneCode, colorCode, nextFreeSerial);
    return {
      status: 'combo_match',
      conflictingItem: comboMatch,
      suggestedSerial: nextFreeSerial,
      suggestedSku: nextFreeSku,
      message: `Existing design combo detected! You already have "${comboMatch.title}" (${comboMatch.sku}) with this Type, Stone, and Color.`,
    };
  }

  // Layer 3: Image Signature Match (if photos have identical or near-identical signatures)
  if (imageHash) {
    const imageMatch = activeInventory.find(
      (item) => item.imageHash && item.imageHash === imageHash
    );
    if (imageMatch) {
      return {
        status: 'image_match',
        conflictingItem: imageMatch,
        message: `Visual duplicate warning! The uploaded photo matches the image on file for "${imageMatch.title}" (${imageMatch.sku}).`,
      };
    }
  }

  return { status: 'clean' };
}

/**
 * Generates an 8x8 average grayscale hash from an image file/URL for visual duplicate detection
 */
export async function generateClientImageHash(imgElement: HTMLImageElement): Promise<string> {
  return new Promise((resolve) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 8;
      canvas.height = 8;
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve('');

      ctx.drawImage(imgElement, 0, 0, 8, 8);
      const imgData = ctx.getImageData(0, 0, 8, 8).data;

      // Compute average grayscale value
      let total = 0;
      for (let i = 0; i < imgData.length; i += 4) {
        const gray = 0.299 * imgData[i] + 0.587 * imgData[i + 1] + 0.114 * imgData[i + 2];
        total += gray;
      }
      const avg = total / 64;

      // Build bit string
      let hash = '';
      for (let i = 0; i < imgData.length; i += 4) {
        const gray = 0.299 * imgData[i] + 0.587 * imgData[i + 1] + 0.114 * imgData[i + 2];
        hash += gray >= avg ? '1' : '0';
      }
      resolve(hash);
    } catch {
      resolve('');
    }
  });
}

/**
 * Calculates Hamming distance between two 64-bit binary strings
 */
export function calculateHammingDistance(hash1: string, hash2: string): number {
  if (!hash1 || !hash2 || hash1.length !== hash2.length) return 64;
  let diff = 0;
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] !== hash2[i]) diff++;
  }
  return diff;
}

export interface SimilarProductMatch {
  item: JewelryItem;
  matchType: 'visual_hash' | 'combo' | 'title' | 'recent_upload';
  confidence: number;
  reason: string;
}

/**
 * Multi-factor similarity and recent duplicate detector
 */
export function findSimilarProducts(params: {
  inventory: JewelryItem[];
  excludeItemId?: string;
  imageHash?: string;
  typeCode?: string;
  stoneCode?: string;
  colorCode?: string;
  title?: string;
}): SimilarProductMatch[] {
  const { inventory, excludeItemId, imageHash, typeCode, stoneCode, colorCode, title } = params;
  const activeItems = (excludeItemId ? inventory.filter((i) => i.id !== excludeItemId) : inventory).filter((i) => !i.isDeleted);
  const matches: SimilarProductMatch[] = [];

  const titleTokens = title
    ? title
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !['with', 'and', 'the', 'for', 'set'].includes(w))
    : [];

  const now = Date.now();

  for (const item of activeItems) {
    let bestScore = 0;
    let reason = '';
    let matchType: 'visual_hash' | 'combo' | 'title' | 'recent_upload' = 'combo';

    // 1. Visual Hash comparison (Hamming distance on 64-bit grayscale hash)
    if (imageHash && item.imageHash) {
      const dist = calculateHammingDistance(imageHash, item.imageHash);
      if (dist <= 12) {
        const similarity = Math.round(((64 - dist) / 64) * 100);
        if (similarity > bestScore) {
          bestScore = similarity;
          matchType = 'visual_hash';
          reason = `Uploaded photo visually matches on-file image (${similarity}% visual signature match)`;
        }
      }
    }

    // 2. Exact combo match (Type + Stone + Color)
    if (
      typeCode &&
      stoneCode &&
      colorCode &&
      item.typeCode?.toUpperCase() === typeCode.toUpperCase() &&
      item.stoneCode?.toUpperCase() === stoneCode.toUpperCase() &&
      item.colorCode?.toUpperCase() === colorCode.toUpperCase()
    ) {
      const comboScore = 85;
      if (comboScore > bestScore) {
        bestScore = comboScore;
        matchType = 'combo';
        reason = `Identical Type (${typeCode}), Stone (${stoneCode}), and Color (${colorCode}) combination`;
      }
    }

    // 3. Title keyword overlap
    if (titleTokens.length > 0 && item.title) {
      const itemTokens = item.title
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !['with', 'and', 'the', 'for', 'set'].includes(w));

      let common = 0;
      for (const t of titleTokens) {
        if (itemTokens.includes(t)) common++;
      }
      const overlapScore = Math.round((common / Math.max(1, Math.min(titleTokens.length, itemTokens.length))) * 100);
      if (overlapScore >= 60 && overlapScore > bestScore) {
        bestScore = overlapScore;
        matchType = 'title';
        reason = `Title keyword similarity (${overlapScore}% matching terminology)`;
      }
    }

    // 4. Recent upload check (uploaded in last 3 hours with at least 2 matching attributes)
    if (item.dateAdded) {
      const addedTime = new Date(item.dateAdded).getTime();
      const diffMinutes = Math.round((now - addedTime) / 60000);
      if (diffMinutes >= 0 && diffMinutes <= 180) {
        const sameType = typeCode && item.typeCode?.toUpperCase() === typeCode.toUpperCase();
        const sameStone = stoneCode && item.stoneCode?.toUpperCase() === stoneCode.toUpperCase();
        const sameColor = colorCode && item.colorCode?.toUpperCase() === colorCode.toUpperCase();
        const attrMatches = (sameType ? 1 : 0) + (sameStone ? 1 : 0) + (sameColor ? 1 : 0);

        if (attrMatches >= 2) {
          const recentScore = Math.max(bestScore, 80);
          if (recentScore >= bestScore) {
            bestScore = recentScore;
            matchType = 'recent_upload';
            const timeDesc = diffMinutes < 1 ? 'just now' : `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
            reason = `Uploaded ${timeDesc} with matching characteristics (${item.sku})`;
          }
        }
      }
    }

    if (bestScore >= 60) {
      matches.push({
        item,
        matchType,
        confidence: bestScore,
        reason,
      });
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Profit and margin helper calculations
 */
export function calculateItemFinancials(buyingPrice: number, sellingPrice: number, quantity: number) {
  const cost = Math.max(0, Number(buyingPrice) || 0);
  const retail = Math.max(0, Number(sellingPrice) || 0);
  const qty = Math.max(0, Number(quantity) || 0);

  const unitProfit = retail - cost;
  const marginPercent = retail > 0 ? (unitProfit / retail) * 100 : 0;
  const markupPercent = cost > 0 ? (unitProfit / cost) * 100 : 0;

  const totalCost = cost * qty;
  const totalRetail = retail * qty;
  const potentialProfit = totalRetail - totalCost;

  return {
    unitProfit,
    marginPercent: Math.round(marginPercent * 10) / 10,
    markupPercent: Math.round(markupPercent * 10) / 10,
    totalCost,
    totalRetail,
    potentialProfit,
  };
}

/**
 * Currency formatter (INR ₹ / generic currency)
 */
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);
}
