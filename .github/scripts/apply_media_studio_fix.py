from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"Patch anchor not found: {label}")
    return text.replace(old, new, 1)


# -----------------------------------------------------------------------------
# 1) Register E-Commerce White Product (Exact) in the actual preset source.
# -----------------------------------------------------------------------------
p = Path("server/services/media/modelImageGeneratorService.ts")
text = p.read_text()
if "ecommerce_white_product:" not in text:
    anchor = "\n};\n\nexport const STRICT_DESIGN_LOCK_CLAUSE"
    preset = """
  ecommerce_white_product: {
    id: 'ecommerce_white_product',
    name: 'E-Commerce White Product (Exact)',
    category: 'editorial',
    description: 'Second premium 2048px pure-white listing image using exact jewellery pixels; PhotoRoom isolation, no model, no redesign',
    basePrompt:
      'Create a second premium e-commerce product image on a solid pure white #FFFFFF background. Preserve the exact jewellery pixels, design, metal tone, stone colours, stone count, chain, clasp, earrings and proportions. Do not redraw, recolour, reshape, add or remove any product component.',
  },
"""
    text = replace_once(text, anchor, preset + anchor, "preset registration")
p.write_text(text)


# -----------------------------------------------------------------------------
# 2) Fix Slot 3 detail crop. Old code begins at 48% of the set and can cut
#    through matching earrings. Keep the complete central product cluster.
# -----------------------------------------------------------------------------
p = Path("server/services/media/deterministicImageService.ts")
text = p.read_text()
old = """  if (targetRegion === 'pendant' || targetRegion === 'stones') {
    const focusTop = targetRegion === 'pendant' ? 0.48 : 0.4;
    cropY = Math.round(autoBox.y + autoBox.height * focusTop);
    cropH = Math.max(1, Math.round(autoBox.height * (1 - focusTop)));
    cropX = Math.round(autoBox.x + autoBox.width * 0.12);
    cropW = Math.max(1, Math.round(autoBox.width * 0.76));
  } else if (targetRegion === 'earrings') {
    cropY = Math.round(autoBox.y + autoBox.height * 0.18);
    cropH = Math.max(1, Math.round(autoBox.height * 0.44));
    cropX = Math.round(autoBox.x + autoBox.width * 0.12);
    cropW = Math.max(1, Math.round(autoBox.width * 0.76));
  }
"""
new = """  if (targetRegion === 'pendant') {
    // Safe pendant-set detail: keep BOTH complete earrings and the pendant.
    // Only trim the least-useful upper chain area; never cut through a component.
    const focusTop = 0.20;
    const focusBottom = 0.99;
    cropY = Math.round(autoBox.y + autoBox.height * focusTop);
    cropH = Math.max(1, Math.round(autoBox.height * (focusBottom - focusTop)));
    cropX = Math.round(autoBox.x + autoBox.width * 0.05);
    cropW = Math.max(1, Math.round(autoBox.width * 0.90));
  } else if (targetRegion === 'stones') {
    cropY = Math.round(autoBox.y + autoBox.height * 0.34);
    cropH = Math.max(1, Math.round(autoBox.height * 0.62));
    cropX = Math.round(autoBox.x + autoBox.width * 0.09);
    cropW = Math.max(1, Math.round(autoBox.width * 0.82));
  } else if (targetRegion === 'earrings') {
    cropY = Math.round(autoBox.y + autoBox.height * 0.18);
    cropH = Math.max(1, Math.round(autoBox.height * 0.44));
    cropX = Math.round(autoBox.x + autoBox.width * 0.12);
    cropW = Math.max(1, Math.round(autoBox.width * 0.76));
  }
"""
if old in text:
    text = text.replace(old, new, 1)
elif "const focusTop = 0.20;" not in text:
    raise RuntimeError("Patch anchor not found: safe Slot 3 crop")
p.write_text(text)


# -----------------------------------------------------------------------------
# 3) Backend gallery fixes:
#    - never decode /api/photos/... as if it were base64
#    - correctly label exact-white output as a deterministic derivative
#    - make the Slot 3 label describe the safe set detail
# -----------------------------------------------------------------------------
p = Path("server/services/media/galleryPackService.ts")
text = p.read_text()

old = """  if (options.sourceBase64) {
    const raw = options.sourceBase64.replace(/^data:image\\/\\w+;base64,/, '');
    try {
      refBuffer = Buffer.from(raw, 'base64');
      refUrl = options.sourceImageUrl || `data:image/jpeg;base64,${raw}`;
    } catch {}
  } else if (options.sourceSlotNumber) {
"""
new = """  if (options.sourceBase64?.startsWith('data:image/')) {
    const raw = options.sourceBase64.replace(/^data:image\\/[^;]+;base64,/, '');
    try {
      refBuffer = Buffer.from(raw, 'base64');
      refUrl = options.sourceImageUrl || options.sourceBase64;
    } catch {}
  } else if (options.sourceSlotNumber) {
"""
if old in text:
    text = text.replace(old, new, 1)
elif "options.sourceBase64?.startsWith('data:image/')" not in text:
    raise RuntimeError("Patch anchor not found: URL/base64 source guard")

old = """  } else if (options.sourceImageUrl) {
    refUrl = options.sourceImageUrl;
    refBuffer = getItemBuffer({ imageUrl: options.sourceImageUrl });
  }
"""
new = """  } else if (options.sourceImageUrl || options.sourceBase64) {
    // UI quick actions may pass a local /api/photos/... URL in sourceBase64.
    // Resolve it as an authentic image URL; do not decode the URL characters.
    refUrl = options.sourceImageUrl || options.sourceBase64 || '';
    refBuffer = getItemBuffer({ imageUrl: refUrl, url: refUrl });
  }
"""
if old in text:
    text = text.replace(old, new, 1)

text = text.replace(
    "          slotTitle: 'Detail / Craftsmanship Close-up',",
    "          slotTitle: 'Product Detail - Pendant + Earrings (Safe Crop)',",
    1,
)

# Initial Slot 4 path.
slot4_start = text.find("  // SLOT 4 — actual model generation only.")
slot5_start = text.find("  // SLOT 5 — component focus by default", slot4_start)
if slot4_start < 0 or slot5_start < 0:
    raise RuntimeError("Could not locate Slot 4 section")
section = text[slot4_start:slot5_start]
marker = "      const presetKey = params.modelPresetKey || 'office_to_occasion';\n"
if "const isExactWhiteProduct" not in section:
    section = replace_once(
        section,
        marker,
        marker + "      const isExactWhiteProduct = presetKey === 'ecommerce_white_product';\n",
        "Slot 4 exact-white flag",
    )
section = section.replace(
    "          slotTitle: `Fashion Model (${MODEL_STYLING_PRESETS[presetKey]?.name || 'Editorial'})`,",
    "          slotTitle: isExactWhiteProduct ? 'E-Commerce White Product (Exact)' : `Fashion Model (${MODEL_STYLING_PRESETS[presetKey]?.name || 'Editorial'})`,",
    1,
)
section = section.replace(
    "          sourceType: 'ai_model',",
    "          sourceType: isExactWhiteProduct ? 'DERIVATIVE' : 'ai_model',",
    1,
)
section = section.replace(
    "          altText: generateSlotAltText(params.productTitle, 'MODEL_1'),",
    "          altText: isExactWhiteProduct ? `Pure white e-commerce product view of ${params.productTitle}` : generateSlotAltText(params.productTitle, 'MODEL_1'),",
    1,
)
section = section.replace(
    "          qualityScore: modelGen.consistencyScore ?? 0,",
    "          qualityScore: isExactWhiteProduct ? 100 : (modelGen.consistencyScore ?? 0),",
    1,
)
section = section.replace(
    "          isAiGenerated: true,",
    "          isAiGenerated: !isExactWhiteProduct,",
    1,
)
text = text[:slot4_start] + section + text[slot5_start:]

# Regeneration / quick-add path.
regen_start = text.find("  if (slotNumber === 4 || options.targetRole === 'AI_MODEL')")
if regen_start < 0:
    raise RuntimeError("Could not locate model regeneration section")
regen = text[regen_start:]
marker = "    const presetKey = options.newPresetKey || targetSlot.modelPresetKey || 'office_to_occasion';\n"
if "const isExactWhiteProduct" not in regen[:800]:
    regen = replace_once(
        regen,
        marker,
        marker + "    const isExactWhiteProduct = presetKey === 'ecommerce_white_product';\n",
        "regeneration exact-white flag",
    )
regen = regen.replace(
    "        slotRole: 'MODEL_1',",
    "        slotRole: isExactWhiteProduct ? 'ALT_VIEW' : 'MODEL_1',",
    1,
)
regen = regen.replace(
    "        slotTitle: `Fashion Model (${MODEL_STYLING_PRESETS[presetKey]?.name || 'Editorial'})`,",
    "        slotTitle: isExactWhiteProduct ? 'E-Commerce White Product (Exact)' : `Fashion Model (${MODEL_STYLING_PRESETS[presetKey]?.name || 'Editorial'})`,",
    1,
)
regen = regen.replace(
    "        altText: `Fashion model wearing ${currentPack.productTitle}`,",
    "        altText: isExactWhiteProduct ? `Pure white e-commerce product view of ${currentPack.productTitle}` : `Fashion model wearing ${currentPack.productTitle}`,",
    1,
)
regen = regen.replace(
    "        sourceType: 'ai_model',",
    "        sourceType: isExactWhiteProduct ? 'DERIVATIVE' : 'ai_model',",
    1,
)
regen = regen.replace(
    "        qualityScore: modelGen.consistencyScore ?? 0,",
    "        qualityScore: isExactWhiteProduct ? 100 : (modelGen.consistencyScore ?? 0),",
    1,
)
regen = regen.replace(
    "        isAiGenerated: true,",
    "        isAiGenerated: !isExactWhiteProduct,",
    1,
)
text = text[:regen_start] + regen
p.write_text(text)


# -----------------------------------------------------------------------------
# 4) Frontend:
#    - always expose Exact White in presets (even if browser/backend list is stale)
#    - add a direct '+ Exact White' action on every real-photo card
#    - let quick-add invoke existing backend exact-white generator
# -----------------------------------------------------------------------------
p = Path("src/components/MediaPackStudioModal.tsx")
text = p.read_text()

old = """      fetchMediaPresets().then((list) => {
        if (list && list.length > 0) {
          setPresets(list);
          if (!selectedPreset) setSelectedPreset(list[0].id);
        }
      });
"""
new = """      fetchMediaPresets().then((list) => {
        const exactWhitePreset: StylingPreset = {
          id: 'ecommerce_white_product',
          name: 'E-Commerce White Product (Exact)',
          description: 'Second premium pure-white product image using exact jewellery pixels; no model or redesign',
          defaultPrompt: 'PhotoRoom exact-product isolation on #FFFFFF with non-destructive 2048px framing.',
        };
        const normalizedPresets = Array.isArray(list) ? [...list] : [];
        if (!normalizedPresets.some((p) => p.id === exactWhitePreset.id)) {
          normalizedPresets.push(exactWhitePreset);
        }
        setPresets(normalizedPresets);
        if (!selectedPreset && normalizedPresets.length > 0) setSelectedPreset(normalizedPresets[0].id);
      });
"""
if old in text:
    text = text.replace(old, new, 1)
elif "const exactWhitePreset: StylingPreset" not in text:
    raise RuntimeError("Patch anchor not found: client preset injection")

fallback = '                          <option value="everyday_wear">Everyday Casual</option>\n'
if 'option value="ecommerce_white_product"' not in text and fallback in text:
    text = text.replace(
        fallback,
        fallback + '                          <option value="ecommerce_white_product">E-Commerce White Product (Exact)</option>\n',
        1,
    )

old_sig = "targetType: 'AI_MODEL' | 'STYLED_SUPPORTING',"
if old_sig in text:
    text = text.replace(
        old_sig,
        "targetType: 'AI_MODEL' | 'STYLED_SUPPORTING' | 'ECOMMERCE_WHITE_EXACT',",
        1,
    )

old = """    const newSlotNumber = galleryPack.slots.length + 1;
    setRegeneratingSlot(newSlotNumber);

    // Add placeholder slot
    const placeholderSlot: import('../types/media').GallerySlot = {
      slotNumber: newSlotNumber,
      slotRole: targetType === 'AI_MODEL' ? 'AI_MODEL_LIFESTYLE_1' : 'STYLED_SUPPORTING',
      slotTitle: targetType === 'AI_MODEL' ? 'Fashion Model (Generating...)' : 'Styled Supporting (Generating...)',
      mediaAssetId: `new_gen_${Date.now()}`,
      url: source.base64,
      sourceType: targetType === 'AI_MODEL' ? 'ai_model' : 'ai_lifestyle',
      altText: `${product?.title || 'Jewelry piece'} ${targetType === 'AI_MODEL' ? 'model' : 'styled'}`,
      seoKeywords: [],
      dimensions: { width: 2048, height: 2048 },
      isCover: false,
      isAiGenerated: true,
      canRegenerate: true,
      included: true,
    };
"""
new = """    const newSlotNumber = galleryPack.slots.length + 1;
    setRegeneratingSlot(newSlotNumber);
    const isExactWhite = targetType === 'ECOMMERCE_WHITE_EXACT';
    const isModel = targetType === 'AI_MODEL';
    const effectivePreset = isExactWhite ? 'ecommerce_white_product' : selectedPreset;

    // Placeholder only; backend replaces this card with the generated derivative.
    const placeholderSlot: import('../types/media').GallerySlot = {
      slotNumber: newSlotNumber,
      slotRole: isExactWhite ? 'ALT_ANGLE' : (isModel ? 'AI_MODEL_LIFESTYLE_1' : 'STYLED_SUPPORTING'),
      slotTitle: isExactWhite
        ? 'E-Commerce White Product (Generating...)'
        : (isModel ? 'Fashion Model (Generating...)' : 'Styled Supporting (Generating...)'),
      mediaAssetId: `new_gen_${Date.now()}`,
      url: source.base64,
      sourceType: isExactWhite ? 'DERIVATIVE' : (isModel ? 'ai_model' : 'ai_lifestyle'),
      altText: isExactWhite
        ? `${product?.title || 'Jewelry piece'} exact white background product view`
        : `${product?.title || 'Jewelry piece'} ${isModel ? 'model' : 'styled'}`,
      seoKeywords: isExactWhite ? ['jewelry', 'white background', 'ecommerce'] : [],
      dimensions: { width: 2048, height: 2048 },
      isCover: false,
      isAiGenerated: !isExactWhite,
      canRegenerate: true,
      included: true,
      modelPresetKey: isExactWhite ? 'ecommerce_white_product' : undefined,
    };
"""
if old in text:
    text = text.replace(old, new, 1)
elif "const isExactWhite = targetType === 'ECOMMERCE_WHITE_EXACT';" not in text:
    raise RuntimeError("Patch anchor not found: exact-white quick-add setup")

# Only change the regenerate call inside generateNewSlotFromPhoto.
func_start = text.find("  const generateNewSlotFromPhoto = async (")
func_end = text.find("  // Single-slot Model or Styled Supporting Regeneration", func_start)
if func_start < 0 or func_end < 0:
    raise RuntimeError("Could not locate quick-add generation function")
func = text[func_start:func_end]
func = func.replace("        stylingPreset: selectedPreset,", "        stylingPreset: effectivePreset,", 1)
func = func.replace(
    "        targetRole: targetType,",
    "        targetRole: targetType === 'STYLED_SUPPORTING' ? 'STYLED_SUPPORTING' : 'AI_MODEL',",
    1,
)
text = text[:func_start] + func + text[func_end:]

# Direct button after + Styled Shot.
if "+ Exact White" not in text:
    needle = """                              <Sparkles size={11} />
                              <span>+ Styled Shot</span>
                            </button>
"""
    button = needle + """                            <button
                              type="button"
                              onClick={() => generateNewSlotFromPhoto('ECOMMERCE_WHITE_EXACT', { base64: displayImgUrl, title: slot.slotTitle || 'Real Photo', slotNumber: slot.slotNumber })}
                              style={{
                                flex: 1,
                                padding: '5px 6px',
                                borderRadius: '6px',
                                backgroundColor: 'rgba(255, 255, 255, 0.08)',
                                border: '1px solid rgba(255, 255, 255, 0.18)',
                                color: '#f8fafc',
                                fontSize: '0.62rem',
                                fontWeight: 700,
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '3px',
                              }}
                              title="Create a second exact-product 2048px pure-white e-commerce image with PhotoRoom. No redesign or recolouring."
                            >
                              <ShieldCheck size={11} />
                              <span>+ Exact White</span>
                            </button>
"""
    text = replace_once(text, needle, button, "Exact White card button")

# Avoid displaying exact-white derivative as an AI/model hallucination card.
old = """                  const isAiSlot =
                    slot.isAiGenerated ||
                    slot.sourceType === 'ai_model' ||
                    slot.sourceType === 'ai_lifestyle' ||
                    slot.sourceType === 'AI_MODEL' ||
                    slot.slotRole === 'STYLED_SUPPORTING' ||
                    (slot.slotRole as string) === 'MODEL_1' ||
                    (slot.slotRole as string) === 'MODEL_2_OR_SUPPORTING' ||
                    slot.slotRole === 'AI_MODEL_LIFESTYLE_1' ||
                    slot.slotRole === 'AI_MODEL_LIFESTYLE_2';
"""
new = """                  const isExactWhiteSlot = slot.modelPresetKey === 'ecommerce_white_product';
                  const isAiSlot =
                    !isExactWhiteSlot && (
                      slot.isAiGenerated ||
                      slot.sourceType === 'ai_model' ||
                      slot.sourceType === 'ai_lifestyle' ||
                      slot.sourceType === 'AI_MODEL' ||
                      slot.slotRole === 'STYLED_SUPPORTING' ||
                      (slot.slotRole as string) === 'MODEL_1' ||
                      (slot.slotRole as string) === 'MODEL_2_OR_SUPPORTING' ||
                      slot.slotRole === 'AI_MODEL_LIFESTYLE_1' ||
                      slot.slotRole === 'AI_MODEL_LIFESTYLE_2'
                    );
"""
if old in text:
    text = text.replace(old, new, 1)

old = """        const isAiSlot =
          slot.isAiGenerated ||
          slot.sourceType === 'ai_model' ||
          slot.sourceType === 'ai_lifestyle' ||
          slot.sourceType === 'AI_MODEL' ||
          slot.slotRole === 'STYLED_SUPPORTING' ||
          (slot.slotRole as string) === 'MODEL_1' ||
          (slot.slotRole as string) === 'MODEL_2_OR_SUPPORTING' ||
          slot.slotRole === 'AI_MODEL_LIFESTYLE_1' ||
          slot.slotRole === 'AI_MODEL_LIFESTYLE_2';
"""
new = """        const isExactWhiteSlot = slot.modelPresetKey === 'ecommerce_white_product';
        const isAiSlot =
          !isExactWhiteSlot && (
            slot.isAiGenerated ||
            slot.sourceType === 'ai_model' ||
            slot.sourceType === 'ai_lifestyle' ||
            slot.sourceType === 'AI_MODEL' ||
            slot.slotRole === 'STYLED_SUPPORTING' ||
            (slot.slotRole as string) === 'MODEL_1' ||
            (slot.slotRole as string) === 'MODEL_2_OR_SUPPORTING' ||
            slot.slotRole === 'AI_MODEL_LIFESTYLE_1' ||
            slot.slotRole === 'AI_MODEL_LIFESTYLE_2'
          );
"""
if old in text:
    text = text.replace(old, new, 1)

# Make Slot 4 UI language match the selected exact-white preset.
text = text.replace(
    "                          Slot 4: AI Fashion Model Image",
    "                          {selectedPreset === 'ecommerce_white_product' ? 'Slot 4: E-Commerce White Product (Exact)' : 'Slot 4: AI Fashion Model Image'}",
    1,
)
text = text.replace(
    "                        {enableModelSlot4 ? '✓ Will be generated with AI' : 'Off (Uses authentic real photo)'}",
    "                        {enableModelSlot4 ? (selectedPreset === 'ecommerce_white_product' ? '✓ Exact product pixels on pure white - no redesign' : '✓ Will be generated with AI') : 'Off (Uses authentic real photo)'}",
    1,
)

p.write_text(text)
print("Media studio source patches applied.")
