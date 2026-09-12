# Media Pipeline Fix Notes

This branch (`fix/media-pipeline-codex`) contains a targeted repair for Saaz Ledger's image-generation path.

## Confirmed issues found

1. The OpenAI path used `dall-e-3` through `/v1/images/generations`, which is text-only generation and does not use the authentic jewellery reference image. For product-locked styled/model images, this was fundamentally the wrong API shape.
2. The Gemini path mixed Imagen and Gemini image models behind the same `generateContent` request shape. Imagen model IDs were therefore being called through an incompatible endpoint pattern.
3. The frontend can pass AI keys from browser-side AI settings into media-generation requests. This is unsafe and should be removed in a follow-up; media generation should rely on server-side credentials only.
4. Failed AI generation is still represented in gallery slots by reusing the hero/source URL while marking the slot as `ai_model`/`ai_lifestyle`. This causes a real photo to appear under an AI badge after generation failure.
5. Crop UI geometry is not trustworthy yet. The preview uses CSS `contain` + transform, while saved crop coordinates are reconstructed from an arbitrary `panX/300`, `panY/300`, and `panOffsetFactor=1.8` mapping rather than the real rendered-image transform.
6. Auto-crop currently requests a server-side crop but ignores the returned crop rectangle. It only resets pan and sets zoom to `1.15`.
7. The pure-white cover fallback can return the complete original rectangular photograph centered on a white canvas when segmentation fails. This technically makes the outer canvas white but does not remove the original background, so it should not be reported as a successful pure-white e-commerce cutout.

## Changes made in this branch

- Reworked OpenAI image generation to use an image-edit request with the authentic source image attached.
- Default OpenAI image model is now configurable with `OPENAI_IMAGE_MODEL`; default set to `gpt-image-2.5-sunburst`.
- Reworked Gemini image path to use current Gemini image-generation models with an inline authentic reference image and `responseModalities: ['TEXT', 'IMAGE']`.
- Removed legacy `imagen-3.0-generate-002` from the `generateContent` fallback path.
- Product-locked AI generation now refuses to run without a real source buffer.
- Switched generated 2048 masters from `fit: cover` to `fit: contain` to avoid accidental cropping of generated jewellery/model imagery.
- Removed hard-coded fake numerical consistency scores from successful generation results.
- Removed backend fallback to `VITE_GEMINI_API_KEY` from this provider file.

## Required follow-up fixes before production

### Crop editor

Replace the current pan/zoom-to-source math with geometry derived from the actual rendered image and crop viewport. The backend should receive an exact source-pixel crop rectangle that corresponds 1:1 with the user's preview.

`Auto Crop` must apply the returned server crop coordinates to the editor state instead of just setting zoom to `1.15`.

### White cover

Change the segmentation failure behavior so it does **not** claim `pure_white` success when the original photographic background remains. Return a `review_required`/failed-isolation state and let the user either:

- choose a configured external remover (PhotoRoom/remove.bg/etc.),
- adjust/crop the source, or
- explicitly accept the original-background framed version as a different mode.

### Gallery failure slots

When styled/model generation fails, do not use the hero URL as the slot image while retaining an AI badge. Use a true empty/failed slot state with `url` omitted (or a dedicated non-image UI state) and exclude the slot from Shopify publish until fixed/skipped.

### Client-side secrets

Remove Gemini/OpenAI secret injection from `src/services/mediaService.ts`. Calls to `/api/media/pack/generate`, `/regenerate-slot`, and `/accuracy/analyze` should not include API keys from browser storage. The server should resolve credentials from environment/secure settings.

## Suggested regression tests

1. Upload a 9:16 pendant photo, manually crop, save, and pixel-compare the output region to the viewport selection.
2. Run Auto Crop and verify the returned source-pixel rectangle is actually reflected in the UI and subsequent output.
3. Force background segmentation failure and verify the app does not claim a true pure-white isolated cover.
4. Force Gemini/OpenAI image-generation failure and verify no real photo appears with an AI badge.
5. Generate Slot 2 from a real source and verify a genuine generated image file is returned and stored.
6. Generate Slot 4 from a real source and verify the provider receives the reference image.
7. Confirm no browser request payload contains Gemini/OpenAI API keys.
