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
