import { describe, expect, it } from 'vitest';
import '../server/services/media/imageGenerationProvider';
import { MODEL_STYLING_PRESETS } from '../server/services/media/modelImageGeneratorService';

describe('E-Commerce White Product preset', () => {
  it('registers a product-only exact white e-commerce option in the media studio preset list', () => {
    const preset = MODEL_STYLING_PRESETS.ecommerce_white_product;

    expect(preset).toBeDefined();
    expect(preset.id).toBe('ecommerce_white_product');
    expect(preset.name).toContain('E-Commerce White Product');
    expect(preset.description.toLowerCase()).toContain('no model');
    expect(preset.description.toLowerCase()).toContain('no redesign');
  });
});
