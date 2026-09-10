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
export async function generateClientImageHash(source: HTMLImageElement | string): Promise<string> {
  return new Promise((resolve) => {
    try {
      const processImg = (imgEl: HTMLImageElement) => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 8;
          canvas.height = 8;
          const ctx = canvas.getContext('2d');
          if (!ctx) return resolve('');

          ctx.drawImage(imgEl, 0, 0, 8, 8);
          const imgData = ctx.getImageData(0, 0, 8, 8).data;

          // Compute average grayscale value
          let total = 0;
          for (let i = 0; i < imgData.length; i += 4) {
            const gray = 0.299 * imgData[i] + 0.587 * imgData[i + 1] + 0.114 * imgData[i + 2];
            total += gray;
          }
          const avg = total / 64;

          // Build bit string (64 characters: '0' and '1')
          let hash = '';
          for (let i = 0; i < imgData.length; i += 4) {
            const gray = 0.299 * imgData[i] + 0.587 * imgData[i + 1] + 0.114 * imgData[i + 2];
            hash += gray >= avg ? '1' : '0';
          }
          resolve(hash);
        } catch {
          resolve('');
        }
      };

      if (typeof source === 'string') {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => processImg(img);
        img.onerror = () => resolve('');
        img.src = source;
      } else {
        processImg(source);
      }
    } catch {
      resolve('');
    }
  });
}

/**
 * Calculates Hamming distance between two 64-bit binary strings or identical hashes
 */
export function calculateHammingDistance(hash1: string, hash2: string): number {
  if (!hash1 || !hash2) return 64;
  if (hash1 === hash2) return 0;
  if (hash1.length !== hash2.length) return 64;
  let diff = 0;
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] !== hash2[i]) diff++;
  }
  return diff;
}

export interface SimilarProductMatch {
  item: JewelryItem;
  matchType: 'visual_hash' | 'recent_upload' | 'combo' | 'title';
  confidence: number;
  reason: string;
}

/**
 * Product-Image-Centric duplicate and similarity detector.
 *
 * STRICT RULE:
 * Alerts are ONLY triggered on behalf of the PRODUCT IMAGE (visual hash, exact checksum, or image URL).
 * Title keywords, category codes, and generic combinations NEVER trigger this alert.
 */
export function findSimilarProducts(params: {
  inventory: JewelryItem[];
  excludeItemId?: string;
  imageHash?: string;
  fileHash?: string;
  imageUrl?: string;
  typeCode?: string;
  stoneCode?: string;
  colorCode?: string;
  title?: string;
}): SimilarProductMatch[] {
  const { inventory, excludeItemId, imageHash, fileHash, imageUrl } = params;
  const activeItems = (excludeItemId ? inventory.filter((i) => i.id !== excludeItemId) : inventory).filter((i) => !i.isDeleted);
  const matches: SimilarProductMatch[] = [];

  // If no image identifier is provided, strictly NEVER alert on behalf of title or generic combos
  if (!imageHash && !fileHash && !imageUrl) {
    return [];
  }

  const now = Date.now();

  for (const item of activeItems) {
    let visualScore = 0;
    let matchDetail = '';

    // 1. Direct Visual Hash comparison (Hamming distance on 64-bit grayscale perceptual hash)
    if (imageHash && item.imageHash) {
      if (imageHash === item.imageHash) {
        visualScore = 100;
        matchDetail = '100% exact visual image match';
      } else {
        const isBinaryHash = /^[01]{64}$/.test(imageHash) && /^[01]{64}$/.test(item.imageHash);
        if (isBinaryHash) {
          const dist = calculateHammingDistance(imageHash, item.imageHash);
          if (dist <= 14) {
            const similarity = Math.round(((64 - dist) / 64) * 100);
            if (similarity > visualScore) {
              visualScore = similarity;
              matchDetail = `${similarity}% visual signature match`;
            }
          }
        }
      }
    }

    // 2. Direct Content / File Checksum comparison (SHA-256 or exact file match)
    if (fileHash && item.imageHash) {
      if (fileHash.toLowerCase() === item.imageHash.toLowerCase()) {
        visualScore = 100;
        matchDetail = '100% identical file checksum match';
      }
    }

    // 3. Exact Image URL / Path match
    if (imageUrl) {
      const cleanInputUrl = imageUrl.split('?')[0];
      const checkUrls = [item.imageUrl, item.originalImageUrl, item.whiteBgImageUrl].filter(Boolean) as string[];
      for (const u of checkUrls) {
        const cleanItemUrl = u.split('?')[0];
        if (cleanItemUrl === cleanInputUrl) {
          visualScore = 100;
          matchDetail = '100% identical uploaded photo URL match';
          break;
        }
        // Match content-addressed filename prefix if both are server photo paths
        if (cleanItemUrl.startsWith('/api/photos/') && cleanInputUrl.startsWith('/api/photos/')) {
          const file1 = cleanItemUrl.replace('/api/photos/', '').split('.')[0];
          const file2 = cleanInputUrl.replace('/api/photos/', '').split('.')[0];
          if (file1 && file2 && (file1 === file2 || file1.startsWith(file2) || file2.startsWith(file1))) {
            visualScore = 100;
            matchDetail = '100% identical product photo content match';
            break;
          }
        }
      }
    }

    // STRICT USER REQUIREMENT: Alert ONLY on behalf of product image!
    // No match if visual likeness is below threshold (75%)
    if (visualScore < 75) {
      continue;
    }

    // Check if uploaded recently (e.g., within the last 24 hours)
    let matchType: 'visual_hash' | 'recent_upload' = 'visual_hash';
    let reason = `Uploaded photo visually matches catalog item (${matchDetail}, SKU: ${item.sku})`;

    if (item.dateAdded) {
      const addedTime = new Date(item.dateAdded).getTime();
      const diffMinutes = Math.round((now - addedTime) / 60000);
      if (diffMinutes >= 0 && diffMinutes <= 1440) {
        matchType = 'recent_upload';
        const timeDesc =
          diffMinutes < 1
            ? 'just now'
            : diffMinutes < 60
            ? `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`
            : `${Math.round(diffMinutes / 60)} hours ago`;
        reason = `Uploaded ${timeDesc} with visually matching product photo (${matchDetail}, SKU: ${item.sku})`;
      }
    }

    matches.push({
      item,
      matchType,
      confidence: visualScore,
      reason,
    });
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
