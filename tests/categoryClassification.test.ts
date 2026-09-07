import { describe, it, expect } from 'vitest';
import { resolveJewelryCategories } from '../src/services/shopifyService';
import { generateJewelryTitle } from '../src/services/titleGenerationService';
import { DEFAULT_CODE_TABLES } from '../src/services/initialData';

describe('SAAZ LEDGER — Category Classification Rules', () => {
  it('Rule 1A: Pendant + Earrings -> Internal Category = Pendant Set, Shopify Category = Jewelry Sets in Jewelry', () => {
    const item = {
      typeCode: 'PD',
      productType: 'Pendant Set',
      includedComponents: 'Pendant + Earrings',
      title: 'Multicolour American Diamond Silver-Plated Floral Pendant Set with Earrings',
    };
    const cat = resolveJewelryCategories(item);
    expect(cat.internalCategory).toBe('Pendant Set');
    expect(cat.shopifyCategory).toBe('Jewelry Sets in Jewelry');
    expect(cat.shopifyCategoryPath).toBe('Apparel & Accessories > Jewelry > Jewelry Sets');
  });

  it('Rule 1B: Pendant + Chain + Earrings -> Internal Category = Pendant Set, Shopify Category = Jewelry Sets in Jewelry', () => {
    const item = {
      typeCode: 'PD',
      productType: 'Pendant Set',
      includedComponents: 'Pendant + Chain + Earrings',
      title: 'Multicolour American Diamond Silver-Plated Floral Pendant Set with Earrings',
    };
    const cat = resolveJewelryCategories(item);
    expect(cat.internalCategory).toBe('Pendant Set');
    expect(cat.shopifyCategory).toBe('Jewelry Sets in Jewelry');
    expect(cat.shopifyCategoryPath).toBe('Apparel & Accessories > Jewelry > Jewelry Sets');
  });

  it('Rule 2A: Pendant only -> Internal Category = Pendant / Pendant Necklace, Shopify Category = Pendants', () => {
    const item = {
      typeCode: 'PDN',
      productType: 'Pendant',
      includedComponents: 'Pendant only',
      title: 'Emerald Green American Diamond Silver-Tone Floral Pendant',
    };
    const cat = resolveJewelryCategories(item);
    expect(cat.internalCategory).toBe('Pendant / Pendant Necklace');
    expect(cat.shopifyCategory).toBe('Pendants');
    expect(cat.shopifyCategoryPath).toBe('Apparel & Accessories > Jewelry > Charms & Pendants > Pendants');
  });

  it('Rule 2B: Pendant + Chain only -> Internal Category = Pendant / Pendant Necklace, Shopify Category = Pendants', () => {
    const item = {
      typeCode: 'PDN',
      productType: 'Pendant Necklace',
      includedComponents: 'Pendant + Chain only',
      title: 'Emerald Green American Diamond Silver-Tone Floral Pendant Necklace',
    };
    const cat = resolveJewelryCategories(item);
    expect(cat.internalCategory).toBe('Pendant / Pendant Necklace');
    expect(cat.shopifyCategory).toBe('Pendants');
    expect(cat.shopifyCategoryPath).toBe('Apparel & Accessories > Jewelry > Charms & Pendants > Pendants');
  });

  it('Rule 2C: Pendant + Chain (without earrings) resolves to Pendants even if initially PD code', () => {
    const item = {
      typeCode: 'PD',
      productType: 'Pendant Necklace',
      includedComponents: 'Pendant + Chain',
      title: 'Emerald Green American Diamond Silver-Tone Floral Pendant Necklace',
    };
    const cat = resolveJewelryCategories(item);
    expect(cat.internalCategory).toBe('Pendant / Pendant Necklace');
    expect(cat.shopifyCategory).toBe('Pendants');
  });

  it('Generates clean title for Pendant / Pendant Necklace without appending "Set" or "with Earrings"', () => {
    const titlePendantOnly = generateJewelryTitle({
      colour: 'Emerald Green',
      stoneMaterial: 'American Diamond',
      stoneConfirmed: true,
      plating: 'Silver-Tone',
      platingConfirmed: true,
      designMotif: 'Floral',
      productType: 'Pendant / Pendant Necklace',
      includedComponents: 'Pendant only',
    });
    expect(titlePendantOnly).toBe('Emerald Green American Diamond Silver-Tone Floral Pendant');
    expect(titlePendantOnly).not.toContain('Earring');
    expect(titlePendantOnly).not.toContain('Set');

    const titleWithChain = generateJewelryTitle({
      colour: 'Emerald Green',
      stoneMaterial: 'American Diamond',
      stoneConfirmed: true,
      plating: 'Silver-Tone',
      platingConfirmed: true,
      designMotif: 'Floral',
      productType: 'Pendant / Pendant Necklace',
      includedComponents: 'Pendant + Chain only',
    });
    expect(titleWithChain).toBe('Emerald Green American Diamond Silver-Tone Floral Pendant Necklace');
    expect(titleWithChain).not.toContain('Earring');
    expect(titleWithChain).not.toContain('Set');
  });

  it('Code tables contain PD for Pendant Set and PDN for Pendant / Pendant Necklace', () => {
    const pd = DEFAULT_CODE_TABLES.types.find((t) => t.code === 'PD');
    const pdn = DEFAULT_CODE_TABLES.types.find((t) => t.code === 'PDN');
    expect(pd).toBeDefined();
    expect(pd?.label).toBe('Pendant Set');
    expect(pdn).toBeDefined();
    expect(pdn?.label).toBe('Pendant / Pendant Necklace');
  });
});
