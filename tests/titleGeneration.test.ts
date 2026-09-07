import { describe, it, expect } from 'vitest';
import {
  generateJewelryTitle,
  normalizeMetalFinishAndPlating,
  normalizeStoneMaterial,
  auditAndCleanTitle,
  removeFluffWords,
} from '../src/services/titleGenerationService';

describe('SAAZ LEDGER — Title Generation & AI Attribute Mapping Rules', () => {
  // TEST 1: Silver-looking jewellery -> Expected AI Finish: Silver, Never Rhodium
  it('TEST 1: Silver-looking jewellery maps to Silver, never Rhodium', () => {
    const res = normalizeMetalFinishAndPlating('silver-looking white metal', undefined, false);
    expect(res.finish).toBe('Silver');
    expect(res.finish).not.toBe('Rhodium');
    expect(res.plating).toBe('Silver-Tone');
  });

  // TEST 2: Image visually resembles rhodium -> Expected: Silver, Never Rhodium
  it('TEST 2: When visual appearance resembles rhodium, AI defaults to Silver', () => {
    const res = normalizeMetalFinishAndPlating('rhodium-like bright white finish', undefined, false);
    expect(res.finish).toBe('Silver');
    expect(res.finish).not.toContain('Rhodium');
    expect(res.plating).toBe('Silver-Tone');
  });

  // TEST 3: User manually selected: Rhodium Plated -> Preserve Rhodium Plated
  it('TEST 3: User-confirmed Rhodium Plated is preserved and not overwritten', () => {
    const res = normalizeMetalFinishAndPlating('silver', 'Rhodium Plated', true);
    expect(res.plating).toBe('Rhodium Plated');
    expect(res.isConfirmed).toBe(true);

    const title = generateJewelryTitle({
      colour: 'Multicolour',
      stoneMaterial: 'American Diamond',
      stoneConfirmed: true,
      plating: 'Rhodium Plated',
      platingConfirmed: true,
      designMotif: 'Floral',
      productType: 'Pendant Set',
      includedComponents: 'with Earrings',
    });
    expect(title).toContain('Rhodium Plated');
  });

  // TEST 4: Confirmed: American Diamond, Silver Plated, Floral, Pendant Set, Earrings, Multicolour
  // Expected title: Multicolour American Diamond Silver-Plated Floral Pendant Set with Earrings
  it('TEST 4: Generates exact confirmed canonical title with Silver-Plated', () => {
    const title = generateJewelryTitle({
      colour: 'Multicolour',
      stoneMaterial: 'American Diamond',
      stoneConfirmed: true,
      plating: 'Silver Plated',
      platingConfirmed: true,
      designMotif: 'Floral',
      productType: 'Pendant Set',
      includedComponents: 'with Earrings',
    });

    expect(title).toBe(
      'Multicolour American Diamond Silver-Plated Floral Pendant Set with Earrings'
    );
  });

  // TEST 5: Plating not confirmed -> Expected Silver-Tone
  it('TEST 5: Unconfirmed plating outputs Silver-Tone', () => {
    const title = generateJewelryTitle({
      colour: 'Multicolour',
      stoneMaterial: 'American Diamond',
      stoneConfirmed: true,
      plating: 'Silver',
      platingConfirmed: false,
      designMotif: 'Floral',
      productType: 'Pendant Set',
      includedComponents: 'with Earrings',
    });

    expect(title).toBe(
      'Multicolour American Diamond Silver-Tone Floral Pendant Set with Earrings'
    );
  });

  // TEST 6: Title currently contains "Ornate" -> removes "Ornate"
  it('TEST 6: Removes promotional/fluff words like Ornate, Exquisite, Stunning', () => {
    const { cleaned, removedWords } = removeFluffWords(
      'Multicolour CZ Silver Plated Ornate Floral Pendant Set with Earrings'
    );
    expect(removedWords).toContain('ornate');
    expect(cleaned).not.toContain('Ornate');

    const audit = auditAndCleanTitle(
      'Multicolour CZ Silver Plated Ornate Floral Pendant Set with Earrings'
    );
    expect(audit.suggestedTitle).toBe(
      'Multicolour American Diamond Silver-Plated Floral Pendant Set with Earrings'
    );
    expect(audit.suggestedTitle).not.toContain('Ornate');
    expect(audit.suggestedTitle).not.toContain('CZ');
  });

  // TEST 7: User manually locks title -> AI rerun must not overwrite it
  it('TEST 7: Locked title prevents overwrite', () => {
    const lockedTitle = 'Custom Heirloom Signature Pendant';
    const isLocked = true;
    const titleSource = 'Manually Locked';

    // When locked, title generator returns empty string or keeps user title
    const generated = generateJewelryTitle({
      colour: 'Multicolour',
      stoneMaterial: 'American Diamond',
      isTitleLocked: isLocked,
      titleSource,
    });
    expect(generated).toBe('');
  });

  // TEST 8: Attribute is corrected after SKU creation -> SKU remains permanent
  it('TEST 8: Title change does not change permanent SKU', () => {
    const item = {
      sku: 'PDJ02-00128',
      title: 'Multicolour CZ Rhodium Floral Pendant Set',
    };

    const audit = auditAndCleanTitle(item.title);
    const updatedItem = {
      ...item,
      title: audit.suggestedTitle,
    };

    expect(updatedItem.sku).toBe('PDJ02-00128'); // SKU unchanged!
    expect(updatedItem.title).toBe(
      'Multicolour American Diamond Silver-Plated Floral Pendant Set'
    );
  });

  // Additional stone verification test
  it('Unconfirmed stone is omitted from title so AI does not invent materials', () => {
    const title = generateJewelryTitle({
      colour: 'Multicolour',
      stoneMaterial: 'American Diamond / CZ',
      stoneConfirmed: false, // unconfirmed!
      plating: 'Silver',
      platingConfirmed: false,
      designMotif: 'Floral',
      productType: 'Pendant Set',
      includedComponents: 'with Earrings',
    });

    expect(title).toBe('Multicolour Silver-Tone Floral Pendant Set with Earrings');
  });
});
