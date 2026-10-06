/**
 * Product-claim guard rails.
 *
 * A photo can show colour, shape and visible finish. It can NOT prove material, plating, purity or
 * gem authenticity. So the AI must never present sapphire / ruby / emerald / real diamond,
 * rhodium plating, 925 / sterling silver, gold or silver plating, platinum, "genuine/natural/
 * certified" etc. as fact unless the SELLER entered or confirmed it.
 *
 * Two kinds of facts are kept apart everywhere (data and wording):
 *   - confirmed:    entered / confirmed by the seller
 *   - observation:  what the AI thinks it sees; always labelled unverified and never written into
 *                   the title/description as a fact (it is neutralised to visible wording).
 */

export interface ClaimRule {
  id: string;
  label: string;
  /** matches the claim in AI text */
  pattern: RegExp;
  /** neutral, photo-supportable wording used instead */
  neutral: string | ((match: string) => string);
  /** a seller-entered fact matching this makes the claim "confirmed" and leaves the text alone */
  confirmedBy: RegExp;
}

const gem = (name: string, colour: string, colourWords: string): ClaimRule => ({
  id: `gem_${name}`,
  label: `${name} (gemstone)`,
  // "Emerald Green" / "Ruby Maroon" are colour names in the shop's colour table, not a claim.
  pattern: new RegExp(`\\b(?:natural\\s+|genuine\\s+|real\\s+)?${name}s?\\b(?!\\s+(?:${colourWords})\\b)`, 'gi'),
  neutral: colour,
  confirmedBy: new RegExp(`\\b${name}s?\\b`, 'i'),
});

export const CLAIM_RULES: ClaimRule[] = [
  {
    id: 'rhodium',
    label: 'rhodium plating',
    pattern: /\brhodium(?:[- ](?:plated|plating|finish|tone|silver|white))?\b/gi,
    neutral: 'silver-tone',
    confirmedBy: /rhodium/i,
  },
  {
    id: 'sterling_925',
    label: '925 / sterling / pure silver',
    pattern: /\b(?:925(?:\s*(?:sterling\s*)?silver)?|silver\s*925|sterling(?:\s+silver)?|pure\s+silver|solid\s+silver|fine\s+silver)\b/gi,
    neutral: 'silver-tone',
    confirmedBy: /925|sterling|pure silver|solid silver|fine silver/i,
  },
  {
    id: 'silver_plating',
    label: 'silver plating',
    pattern: /\bsilver[- ](?:plated|plating)\b/gi,
    neutral: 'silver-tone',
    confirmedBy: /silver.?plat/i,
  },
  {
    id: 'gold_plating',
    label: 'gold plating / karat gold',
    pattern: /\b(?:\d{2}\s*k(?:t|arat)?(?:\s+gold)?(?:[- ]plated)?|gold[- ](?:plated|plating|filled)|vermeil|real\s+gold|solid\s+gold|pure\s+gold)\b/gi,
    neutral: 'gold-tone',
    confirmedBy: /gold.?plat|gold.?fill|\d{2}\s*k(t|arat)?\b|vermeil|real gold|solid gold|pure gold/i,
  },
  {
    id: 'platinum',
    label: 'platinum / white gold',
    pattern: /\b(?:platinum|white\s+gold)\b/gi,
    neutral: 'silver-tone',
    confirmedBy: /platinum|white gold/i,
  },
  gem('sapphire', 'blue', 'zzz'),
  gem('ruby', 'red', 'maroon|red'),
  gem('emerald', 'green', 'green'),
  gem('topaz', 'stone', 'zzz'),
  gem('amethyst', 'purple', 'zzz'),
  gem('garnet', 'deep red', 'zzz'),
  gem('tanzanite', 'blue-violet', 'zzz'),
  gem('moissanite', 'clear stone', 'zzz'),
  {
    id: 'real_diamond',
    label: 'real diamond',
    // bare "diamond(s)" that is not the shop's "American Diamond" simulant wording
    pattern: /(?<!american\s)(?<!american\s\()\b(?:natural\s+|genuine\s+|real\s+|certified\s+)?diamonds?\b/gi,
    neutral: 'American Diamond',
    confirmedBy: /\bdiamond/i,
  },
  {
    id: 'authenticity',
    label: 'genuine / natural / certified / hallmarked',
    pattern: /\b(?:genuine|authentic|natural|certified|hallmarked|real)\s+(?=(?:gold|silver|stones?|gemstones?|pearls?|platinum|metal))/gi,
    neutral: '',
    confirmedBy: /genuine|authentic|natural|certified|hallmark|real/i,
  },
];

export interface ClaimFinding {
  ruleId: string;
  label: string;
  matched: string;
  replacement: string;
}

function isConfirmed(rule: ClaimRule, confirmedFacts?: string): boolean {
  return Boolean(confirmedFacts && rule.confirmedBy.test(confirmedFacts));
}

/** Lists material/purity/gem claims in `text` that the seller has NOT confirmed. */
export function findUnverifiedClaims(text: string, confirmedFacts?: string): ClaimFinding[] {
  const findings: ClaimFinding[] = [];
  if (!text) return findings;
  for (const rule of CLAIM_RULES) {
    if (isConfirmed(rule, confirmedFacts)) continue;
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const replacement = typeof rule.neutral === 'function' ? rule.neutral(m[0]) : rule.neutral;
      findings.push({ ruleId: rule.id, label: rule.label, matched: m[0], replacement });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return findings;
}

function tidy(text: string): string {
  return text
    .replace(/\b(\w+(?:-\w+)?)\s+\1\b/gi, '$1') // "silver-tone silver-tone" -> "silver-tone"
    .replace(/\bblue\s+blue\b/gi, 'blue')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Replaces unverified material/purity/gem claims with neutral, visible wording (e.g. "sapphire" ->
 * "blue", "925 silver" / "rhodium plated" / "silver-plated" -> "silver-tone"). Claims the seller
 * confirmed are left untouched.
 */
export function sanitizeClaims(text: string, confirmedFacts?: string): { text: string; findings: ClaimFinding[] } {
  if (!text) return { text: text || '', findings: [] };
  let out = text;
  const findings: ClaimFinding[] = [];
  for (const rule of CLAIM_RULES) {
    if (isConfirmed(rule, confirmedFacts)) continue;
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    out = out.replace(re, (match) => {
      const replacement = typeof rule.neutral === 'function' ? rule.neutral(match) : rule.neutral;
      findings.push({ ruleId: rule.id, label: rule.label, matched: match, replacement });
      return replacement;
    });
  }
  return { text: tidy(out), findings };
}

export type FactStatus = 'seller_confirmed' | 'ai_observation';

export interface AttributeLike {
  attribute: string;
  value: string;
  evidence: string;
  status: 'visible' | 'confirmation_required' | 'confirmed';
}

export interface GuardedAttribute extends AttributeLike {
  source: FactStatus;
  /** true => never written into title/description as a fact */
  unverified: boolean;
}

const MATERIAL_ATTRIBUTE = /plating|metal|finish|material|stone type|gem|accent stones?|purity|hallmark/i;

export const OBSERVATION_PREFIX = 'Unverified observation';

/**
 * Splits attributes into seller-confirmed facts and AI observations. An attribute is only
 * "confirmed" when the SELLER's text supports it - the AI saying `status: "confirmed"` does not
 * count. Observations keep a visible "Unverified observation" evidence label.
 */
export function classifyAttributes(
  attributes: AttributeLike[],
  confirmedFacts?: string
): { confirmed: GuardedAttribute[]; observations: GuardedAttribute[]; all: GuardedAttribute[] } {
  const facts = (confirmedFacts || '').toLowerCase();
  const all: GuardedAttribute[] = attributes.map((a) => {
    const value = (a.value || '').trim();
    const sellerSupports = value.length > 0 && facts.length > 0 && value.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3).some((w) => facts.includes(w));
    const confirmed = sellerSupports && a.status !== 'visible' ? true : sellerSupports && a.status === 'visible' && !MATERIAL_ATTRIBUTE.test(a.attribute);
    if (confirmed) {
      return { ...a, status: 'confirmed', source: 'seller_confirmed', unverified: false };
    }
    const needsConfirmation = MATERIAL_ATTRIBUTE.test(a.attribute) || a.status === 'confirmation_required' || a.status === 'confirmed';
    return {
      ...a,
      status: needsConfirmation ? 'confirmation_required' : 'visible',
      evidence: a.evidence.startsWith(OBSERVATION_PREFIX) ? a.evidence : `${OBSERVATION_PREFIX} - ${a.evidence || 'seen in photo'}`,
      source: 'ai_observation',
      unverified: true,
    };
  });
  return { confirmed: all.filter((a) => !a.unverified), observations: all.filter((a) => a.unverified), all };
}
