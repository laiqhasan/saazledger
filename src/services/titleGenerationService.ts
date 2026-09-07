/**
 * SAAZ LEDGER — JEWELLERY TITLE GENERATION & ATTRIBUTE MAPPING SERVICE
 * 
 * Implements strict rules for Indian artificial jewellery cataloguing:
 * 1. SILVER DEFAULT: Never automatically guess or output Rhodium. Use Silver / Silver-Tone / Silver-Plated.
 * 2. SILVER-PLATED vs SILVER-TONE: Silver-Plated when confirmed; Silver-Tone when unconfirmed visual.
 * 3. CUSTOMER-FRIENDLY STONES: American Diamond / American Diamond (CZ) instead of technical Cubic Zirconia / CZ.
 * 4. FLUFF WORD REMOVAL: Strips Ornate, Exquisite, Stunning, Beautiful, Gorgeous, Luxury, Premium, Elegant, Designer, Fancy.
 * 5. CANONICAL STRUCTURE: [Colour] [Stone / Material] [Finish] [Design / Motif] [Product Type] [Included Components].
 * 6. USER CONFIRMATION LOCK: User-confirmed attributes & locked titles are permanently preserved.
 */

export interface JewelryTitleAttributes {
  colour?: string;              // e.g. "Multicolour", "Emerald Green", "Ruby Maroon"
  stoneMaterial?: string;       // e.g. "American Diamond", "Kundan", "Polki", "Pearl"
  stoneConfirmed?: boolean;     // true if user/supplier confirmed
  metalFinish?: string;         // e.g. "Silver", "Gold", "Antique Gold", "Rose Gold"
  plating?: string;             // e.g. "Silver-Plated", "Silver-Tone", "Gold-Plated", "Gold-Tone"
  platingConfirmed?: boolean;   // true if user/supplier confirmed
  designMotif?: string;         // e.g. "Floral", "Peacock", "Geometric", "Leaf", "Temple"
  productType?: string;         // e.g. "Pendant Set", "Necklace Set", "Drop Earrings"
  includedComponents?: string;  // e.g. "with Earrings", "with Maang Tikka", "Pair"
  includesEarrings?: boolean;
  isTitleLocked?: boolean;
  titleSource?: 'AI Generated' | 'AI + User Edited' | 'Manually Locked';
}

// Low-value promotional/filler words to strip from catalog titles
const FLUFF_WORDS = [
  'ornate',
  'exquisite',
  'stunning',
  'beautiful',
  'gorgeous',
  'luxury',
  'premium',
  'elegant',
  'designer',
  'fancy',
];

// Disallowed AI rhodium tokens (user can still manually enter them if confirmed)
const RHODIUM_REGEX = /\brhodium(?:\s+(?:plated|finish|silver|tone|white))?\b/gi;

/**
 * Normalizes colour names for Indian artificial jewellery cataloguing
 */
export function normalizeColourName(colour?: string): string {
  if (!colour) return '';
  const trimmed = colour.trim();

  // Normalize Multicolour spellings to canonical Indian catalogue spelling
  if (/^multi[- ]?colou?r$/i.test(trimmed)) {
    return 'Multicolour';
  }

  // Capitalize words cleanly
  return trimmed
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Normalizes stone terminology for Indian artificial jewellery:
 * Prefers "American Diamond" over "Cubic Zirconia" or bare "CZ".
 */
export function normalizeStoneMaterial(
  stone?: string,
  confirmed = true
): { name: string; isVerified: boolean } {
  if (!stone) return { name: '', isVerified: false };
  const raw = stone.trim();

  // If unconfirmed, mark unverified
  if (!confirmed) {
    return { name: raw, isVerified: false };
  }

  let normalized = raw;

  // Replace technical "Cubic Zirconia" or bare "CZ" with "American Diamond"
  if (/\b(?:cubic\s+zirconia|cz|ad)\b/i.test(normalized)) {
    // If it mentions American Diamond already, ensure canonical casing
    if (/american\s+diamond/i.test(normalized)) {
      normalized = normalized.replace(/american\s+diamond(?:\s*\(cz\))?/gi, 'American Diamond');
    } else {
      normalized = normalized.replace(/\b(?:cubic\s+zirconia|cz)\b/gi, 'American Diamond');
    }
  }

  // Standardize multiple spaces
  normalized = normalized.replace(/\s+/g, ' ').trim();

  return {
    name: normalized,
    isVerified: true,
  };
}

/**
 * Normalizes metal appearance and plating:
 * NEVER allows AI to guess "Rhodium". Defaults white/silver appearance to "Silver" / "Silver-Tone" / "Silver-Plated".
 */
export function normalizeMetalFinishAndPlating(
  detectedFinish?: string,
  userConfirmedPlating?: string,
  isConfirmed = false
): { finish: string; plating: string; isConfirmed: boolean } {
  // If user explicitly confirmed a value (including Rhodium), PRESERVE IT!
  if (userConfirmedPlating && isConfirmed) {
    const rawPlating = userConfirmedPlating.trim();
    let normalized = rawPlating;
    if (/^silver[- ]?plated$/i.test(rawPlating)) normalized = 'Silver-Plated';
    if (/^silver[- ]?tone$/i.test(rawPlating)) normalized = 'Silver-Tone';
    if (/^rhodium[- ]?plated$/i.test(rawPlating)) normalized = 'Rhodium Plated';
    if (/^gold[- ]?plated$/i.test(rawPlating)) normalized = 'Gold-Plated';
    if (/^gold[- ]?tone$/i.test(rawPlating)) normalized = 'Gold-Tone';

    return {
      finish: normalized.includes('Silver') ? 'Silver' : normalized.includes('Rhodium') ? 'Rhodium' : 'Gold',
      plating: normalized,
      isConfirmed: true,
    };
  }

  const raw = (detectedFinish || '').trim().toLowerCase();

  // Check if white / silver appearance detected
  const isWhiteOrSilver =
    raw.includes('silver') ||
    raw.includes('white') ||
    raw.includes('rhodium') ||
    raw.includes('platinum') ||
    raw.includes('bright-white');

  if (isWhiteOrSilver) {
    // AI MUST NEVER OUTPUT RHODIUM
    return {
      finish: 'Silver',
      plating: isConfirmed ? 'Silver-Plated' : 'Silver-Tone',
      isConfirmed,
    };
  }

  if (raw.includes('rose gold')) {
    return {
      finish: 'Rose Gold',
      plating: isConfirmed ? 'Rose Gold-Plated' : 'Rose Gold-Tone',
      isConfirmed,
    };
  }

  if (raw.includes('antique') || raw.includes('brass') || raw.includes('matte')) {
    return {
      finish: 'Antique Gold',
      plating: 'Antique Gold',
      isConfirmed,
    };
  }

  // Default gold / warm tone
  return {
    finish: 'Gold',
    plating: isConfirmed ? 'Gold-Plated' : 'Gold-Tone',
    isConfirmed,
  };
}

/**
 * Strips promotional and low-value adjectives from text
 */
export function removeFluffWords(text: string): { cleaned: string; removedWords: string[] } {
  let cleaned = text;
  const removedWords: string[] = [];

  for (const word of FLUFF_WORDS) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    if (regex.test(cleaned)) {
      removedWords.push(word);
      cleaned = cleaned.replace(regex, ' ');
    }
  }

  // Remove multiple consecutive spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return { cleaned, removedWords };
}

/**
 * Builds canonical jewellery product title following the 6-part hierarchy:
 * [Colour] [Stone / Material] [Finish] [Design / Motif] [Product Type] [Included Components]
 */
export function generateJewelryTitle(attributes: JewelryTitleAttributes): string {
  // If title is locked by user, return as-is
  if (attributes.isTitleLocked && attributes.titleSource === 'Manually Locked') {
    return '';
  }

  const parts: string[] = [];

  // 1. [Colour]
  const colour = normalizeColourName(attributes.colour);
  if (colour && colour.toLowerCase() !== 'standard' && colour.toLowerCase() !== 'default') {
    parts.push(colour);
  }

  // 2. [Stone / Material]
  // Only include stone if confirmed, or if explicitly passed as verified material
  if (attributes.stoneMaterial) {
    const { name, isVerified } = normalizeStoneMaterial(
      attributes.stoneMaterial,
      attributes.stoneConfirmed ?? true
    );
    if (name && isVerified) {
      parts.push(name);
    }
  }

  // 3. [Finish / Plating]
  const metalNorm = normalizeMetalFinishAndPlating(
    attributes.metalFinish || attributes.plating,
    attributes.plating,
    attributes.platingConfirmed ?? false
  );

  // Avoid duplicate colour/finish (e.g. if colour is already "Silver", don't say "Silver Silver-Plated")
  const finishLabel = metalNorm.plating;
  if (finishLabel && !parts.some((p) => p.toLowerCase() === finishLabel.toLowerCase())) {
    parts.push(finishLabel);
  }

  // 4. [Design / Motif]
  if (attributes.designMotif) {
    const { cleaned: cleanMotif } = removeFluffWords(attributes.designMotif.trim());
    if (cleanMotif) {
      // Capitalize cleanly
      const formattedMotif = cleanMotif
        .split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
      parts.push(formattedMotif);
    }
  }

  // 5. [Product Type]
  let productType = (attributes.productType || 'Jewelry Piece').trim();
  if (/^Pendant\s*\/\s*Pendant\s+Necklace$/i.test(productType)) {
    productType = attributes.includedComponents?.toLowerCase().includes('chain') ? 'Pendant Necklace' : 'Pendant';
  }
  // Capitalize properly
  const formattedType = productType
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

  // Avoid repeating "Pendant Set" if designMotif already included it
  if (!parts.some((p) => p.toLowerCase().includes(formattedType.toLowerCase()))) {
    parts.push(formattedType);
  }

  // 6. [Included Components]
  let components = attributes.includedComponents?.trim();
  if (!components && attributes.includesEarrings && !formattedType.toLowerCase().includes('earring')) {
    components = 'with Earrings';
  }

  if (components) {
    // If components just restates pendant only or pendant + chain only, don't repeat in title
    if (!/^(pendant\s*only|chain\s*only|pendant\s*\+\s*chain(\s*only)?|\d+\s*pendant.*)$/i.test(components)) {
      // Clean up "with" casing
      let cleanComp = components;
      if (/^with\s+/i.test(cleanComp)) {
        cleanComp = 'with ' + cleanComp.slice(5).trim();
      }
      parts.push(cleanComp);
    }
  }

  // Join and strip any remaining fluff words or double spaces
  let rawTitle = parts.join(' ').replace(/\s+/g, ' ').trim();
  const { cleaned } = removeFluffWords(rawTitle);

  // Enforce Rhodium prohibition on AI output:
  // If user didn't manually confirm Rhodium, replace any rogue Rhodium mention with Silver
  if (!attributes.platingConfirmed || !attributes.plating?.toLowerCase().includes('rhodium')) {
    return cleaned
      .replace(RHODIUM_REGEX, 'Silver')
      .replace(/\bSilver\s+Plated\b/gi, 'Silver-Plated')
      .replace(/\bSilver\s+Tone\b/gi, 'Silver-Tone')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return cleaned;
}

/**
 * Inspects an existing title and suggests a cleaner, normalized title based on SAAZ AURA rules.
 * Highlights exact changes for user review.
 */
export function auditAndCleanTitle(currentTitle: string): {
  currentTitle: string;
  suggestedTitle: string;
  changes: string[];
  hasImprovements: boolean;
} {
  if (!currentTitle || !currentTitle.trim()) {
    return { currentTitle: '', suggestedTitle: '', changes: [], hasImprovements: false };
  }

  const changes: string[] = [];
  let updated = currentTitle;

  // 1. Remove Rhodium guesses
  if (RHODIUM_REGEX.test(updated)) {
    updated = updated.replace(RHODIUM_REGEX, 'Silver-Plated');
    changes.push('Rhodium → Silver-Plated (Never guess Rhodium for white metal)');
  }

  // 2. Remove fluff adjectives
  const { cleaned: unFluffed, removedWords } = removeFluffWords(updated);
  if (removedWords.length > 0) {
    updated = unFluffed;
    changes.push(`Removed low-value word(s): ${removedWords.map((w) => `"${w}"`).join(', ')}`);
  }

  // 3. Normalize CZ / Cubic Zirconia to American Diamond
  if (/\b(?:cubic\s+zirconia|cz)\b/i.test(updated)) {
    updated = updated.replace(/\b(?:cubic\s+zirconia|cz)\b/gi, 'American Diamond');
    changes.push('CZ / Cubic Zirconia → American Diamond');
  }

  // 4. Normalize Plating format
  if (/\bsilver\s+plated\b/i.test(updated) && !updated.includes('Silver-Plated')) {
    updated = updated.replace(/\bsilver\s+plated\b/gi, 'Silver-Plated');
    changes.push('Normalized "Silver Plated" → "Silver-Plated"');
  }
  if (/\bsilver\s+tone\b/i.test(updated) && !updated.includes('Silver-Tone')) {
    updated = updated.replace(/\bsilver\s+tone\b/gi, 'Silver-Tone');
    changes.push('Normalized "Silver Tone" → "Silver-Tone"');
  }

  // 5. Normalize Multicolour spelling
  if (/\b(?:multicolor|multi\s+color|multi-colour)\b/i.test(updated)) {
    updated = updated.replace(/\b(?:multicolor|multi\s+color|multi-colour)\b/gi, 'Multicolour');
    changes.push('Normalized to Indian spelling "Multicolour"');
  }

  // Final cleanup of spaces
  updated = updated.replace(/\s+/g, ' ').trim();

  return {
    currentTitle,
    suggestedTitle: updated,
    changes,
    hasImprovements: changes.length > 0 && updated !== currentTitle,
  };
}
