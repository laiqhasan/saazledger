// Stable source wrapper for media-generation presets.
// The historical implementation stays in modelImageGeneratorService.impl.ts;
// this file adds the exact-product e-commerce preset at the source of truth.

export * from './modelImageGeneratorService.impl';

import { MODEL_STYLING_PRESETS } from './modelImageGeneratorService.impl';

if (!MODEL_STYLING_PRESETS.ecommerce_white_product) {
  MODEL_STYLING_PRESETS.ecommerce_white_product = {
    id: 'ecommerce_white_product',
    name: 'E-Commerce White Product (Exact)',
    category: 'editorial',
    description:
      'Second premium 2048px pure-white listing image using exact jewellery pixels; PhotoRoom isolation, no model, no redesign',
    basePrompt:
      'Create a second premium e-commerce product image on a solid pure white #FFFFFF background. Preserve the exact jewellery pixels, design, metal tone, stone colours, stone count, chain, clasp, earrings and proportions. Do not redraw, recolour, reshape, add or remove any product component.',
  };
}
