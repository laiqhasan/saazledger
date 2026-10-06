# Straight chain / post removal: root cause and fix

All tests and fixtures for this fix are SYNTHETIC drawings. The genuine photo (IMG_20261001_120958.jpg) was not available.

## Root cause

`cleanJewelleryCutoutArtifacts()` in `server/services/media/imageCleanupService.ts` (called from
`createPureWhiteCover()` in `deterministicImageService.impl.ts` for every exact-cutout / white-background output,
and from `backgroundRemovalService.ts`) classified a connected component as a "ruler" by SHAPE ALONE:

- `isHorizontalRuler`: bbox aspect >= 2.2, width >= 20% of the frame, within 18% of the top/bottom edge.
- `isVerticalRuler`: aspect <= 0.45, height >= 20%, within 5% of the left/right edge.
- `isCornerDualRuler`, `isBorderEdge` (thin strip >= 35% long touching the border), and the `isProp` rule.

A chain laid straight, a spare straight chain length near the photo edge, or a straight chain/post that is not
touching the pendant is exactly a long thin component, so it was marked `keep = false` and zeroed. There was no
check for tick marks, thickness, colour or proximity to jewellery. A second defect: the output alpha was rebuilt by
upscaling an 800px grid mask, which also thinned/fattened kept chains and dropped sub-grid strands; tight bounds were
taken from coarse grid components. Nothing downstream compared the output with the photo, so the loss was silent.

## Fix

- `jewelleryForegroundService.findRulerBands`: positive ruler identification only (thick band >= 1.2% of the short
  side and >= 25% of the frame long, solid, with >= 8 regularly spaced ticks, or a long uniform solid bar). Straightness
  alone never qualifies; chain-scale strands cannot match.
- Cleanup removes a ruler only if it is identified AND not connected to / within 1.5% of the frame of jewellery.
  Connected or near rulers: nothing is removed, `needsReview = true`, warning returned. Uncertain strands are kept
  (`keptStraightStructures`, `warnings`). Removal is remove-only on the full-resolution alpha.
- Completeness gate `evaluateJewelleryCompleteness`: compares output with the source photo jewellery foreground
  (component and region retention: pendant, earrings, thin chain/hook/post strands). < 97% retained, a missing
  component or an incomplete region gives `pass=false`. `combineEvaluation` turns that into `needs_review` (never
  `ready`, no exact-match label); `evaluateWhiteProductOutput`, galleryPackService slots and
  `src/utils/mediaPackStatus.ts` (`jewelleryCompleteness`) carry it to the UI. Gate status `failed` marks lost
  components / < 90% retention; at slot level it is shown as needs_review so the image stays inspectable.
- 1:1 crop path (`applyNonDestructiveCrop`): contain now keeps 3% white padding when the crop aspect differs
  from the canvas (tall crop no longer touches top/bottom); matching-aspect and `free` crops are unchanged.

## Limits

Axis-aligned rulers only; white-on-white rulers are not detected (they are then treated as jewellery, which is the safe side).
Region names are geometric guesses. Thresholds were tuned on synthetic fixtures only.
