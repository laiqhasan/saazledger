import { describe, it, expect } from 'vitest';
import { sanitizeClaims, findUnverifiedClaims, classifyAttributes, OBSERVATION_PREFIX } from '../src/services/claimGuard';
import { normalizeAiOutput } from '../src/services/aiVisionService';
import { DEFAULT_CODE_TABLES } from '../src/services/initialData';
import { generateJewelryTitle } from '../src/services/titleGenerationService';

const BANNED = /sapphire|rhodium|\b925\b|sterling|gold[- ]plated|silver[- ]plated|ruby|platinum|genuine|certified|hallmarked/i;

/** A mocked AI response (no provider is called) that over-claims material from a photo. */
const overclaimingAiResponse = {
  type_code: 'PD',
  stone_code: 'D',
  color_code: '04',
  title: 'Sapphire Blue Pear Halo Rhodium Plated 925 Silver Pendant Set with Earrings',
  description:
    'Product Overview: Natural sapphire centre stone surrounded by real diamonds in genuine 925 sterling silver with rhodium plating and gold plating accents.\n' +
    'Specifications:\n• Metal Appearance: Rhodium Plated 925 Silver\n• Primary Gemstones: Sapphire',
  confidence_notes: 'Identified a sapphire and rhodium finish.',
  detected_attributes: [
    { attribute: 'Plating', value: 'Rhodium', evidence: 'Visible', status: 'confirmed' },
    { attribute: 'Centre-stone colour', value: 'Sapphire blue', evidence: 'Visible', status: 'visible' },
    { attribute: 'Metal appearance', value: 'Sterling 925 silver', evidence: 'Visible', status: 'confirmed' },
    { attribute: 'Design', value: 'Pear halo', evidence: 'Visible', status: 'visible' },
  ],
};

describe('Claim guard: material / purity / gem claims are never invented from a photo', () => {
  it('neutralises unconfirmed sapphire / rhodium / 925 / plating claims into visible wording', () => {
    const { text, findings } = sanitizeClaims(
      'Sapphire pendant in rhodium plated 925 silver with gold plating and real diamond, genuine gold finish'
    );
    expect(text).not.toMatch(BANNED);
    expect(text).toMatch(/blue/i);
    expect(text).toMatch(/silver-tone/i);
    expect(findings.length).toBeGreaterThanOrEqual(5);
  });

  it('keeps claims the seller confirmed', () => {
    const facts = 'Seller confirmed: 925 sterling silver, rhodium plated';
    const { text } = sanitizeClaims('Rhodium plated 925 silver pendant', facts);
    expect(text).toMatch(/rhodium plated 925 silver/i);
    expect(findUnverifiedClaims('Rhodium plated 925 silver pendant', facts)).toHaveLength(0);
  });

  it('only confirms the specific claim the seller made', () => {
    const facts = 'It is 925 sterling silver.';
    const { text } = sanitizeClaims('925 silver pendant with sapphire', facts);
    expect(text).toMatch(/925 silver/);
    expect(text).not.toMatch(/sapphire/i);
  });

  it('leaves shop colour names and American Diamond wording alone', () => {
    const { text, findings } = sanitizeClaims('Emerald Green American Diamond Silver-Tone Pendant Set');
    expect(text).toBe('Emerald Green American Diamond Silver-Tone Pendant Set');
    expect(findings).toHaveLength(0);
    expect(sanitizeClaims('Real diamond pendant').text).toMatch(/American Diamond/);
  });
});

describe('AI vision output: AI observations are separate from seller-confirmed facts', () => {
  it('title and description contain no unverified material claims', () => {
    const result = normalizeAiOutput(overclaimingAiResponse, DEFAULT_CODE_TABLES as any, 'Mock AI');
    expect(result.title).not.toMatch(BANNED);
    expect(result.description).not.toMatch(BANNED);
    expect(result.confidenceNotes).not.toMatch(BANNED);
    expect(result.title).toMatch(/blue/i);
    expect(result.title).toMatch(/silver-tone/i);
    expect(result.claimGuardNotes && result.claimGuardNotes.length).toBeGreaterThan(0);
  });

  it('AI "confirmed" status is not trusted: it becomes an unverified observation needing confirmation', () => {
    const result = normalizeAiOutput(overclaimingAiResponse, DEFAULT_CODE_TABLES as any, 'Mock AI');
    expect(result.confirmedFacts).toHaveLength(0);
    expect(result.unverifiedObservations!.length).toBe(overclaimingAiResponse.detected_attributes.length);
    const plating = result.detectedAttributes!.find((a) => a.attribute === 'Plating')!;
    expect(plating.status).toBe('confirmation_required');
    expect(plating.unverified).toBe(true);
    expect(plating.source).toBe('ai_observation');
    expect(plating.evidence.startsWith(OBSERVATION_PREFIX)).toBe(true);
    expect(plating.value).not.toMatch(/rhodium/i);
  });

  it('claims the seller confirmed are kept and recorded as confirmed facts', () => {
    const facts = '925 sterling silver pendant, rhodium plated. Sapphire blue centre stone.';
    const result = normalizeAiOutput(overclaimingAiResponse, DEFAULT_CODE_TABLES as any, 'Mock AI', facts);
    expect(result.title).toMatch(/925/);
    expect(result.confirmedFacts!.length).toBeGreaterThan(0);
    expect(result.confirmedFacts!.every((a) => a.source === 'seller_confirmed' && !a.unverified)).toBe(true);
    // the observation that the seller did not back stays unverified
    expect(result.unverifiedObservations!.some((a) => a.attribute === 'Design')).toBe(true);
  });

  it('classifyAttributes: observation wording is labelled unverified', () => {
    const { observations, confirmed } = classifyAttributes(
      [{ attribute: 'Accent stones', value: 'American Diamond', evidence: 'Visible', status: 'visible' }],
      ''
    );
    expect(confirmed).toHaveLength(0);
    expect(observations[0].evidence).toMatch(/^Unverified observation/);
    expect(observations[0].status).toBe('confirmation_required');
  });
});

describe('Title generation never writes unconfirmed observations as facts', () => {
  it('unconfirmed stone and plating are omitted / shown as tone, never as a material claim', () => {
    const title = generateJewelryTitle({
      colour: 'Blue',
      stoneMaterial: 'Sapphire',
      stoneConfirmed: false,
      metalFinish: 'silver',
      plating: 'Rhodium Plated',
      platingConfirmed: false,
      designMotif: 'Pear Halo',
      productType: 'Pendant Set',
      includesEarrings: true,
    });
    expect(title).not.toMatch(/sapphire|rhodium|plated/i);
    expect(title).toMatch(/Silver-Tone/);
  });

  it('a seller-confirmed stone and plating are written into the title', () => {
    const title = generateJewelryTitle({
      colour: 'Blue',
      stoneMaterial: 'American Diamond',
      stoneConfirmed: true,
      metalFinish: 'silver',
      plating: 'Silver-Plated',
      platingConfirmed: true,
      designMotif: 'Pear Halo',
      productType: 'Pendant Set',
      includesEarrings: true,
    });
    expect(title).toBe('Blue American Diamond Silver-Plated Pear Halo Pendant Set with Earrings');
  });
});
