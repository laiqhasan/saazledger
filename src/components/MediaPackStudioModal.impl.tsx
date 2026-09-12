import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Upload,
  Sparkles,
  Layers,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  ArrowLeft,
  RefreshCw,
  Download,
  Share2,
  Crown,
  Lock,
  ShoppingBag,
  Sliders,
  Image as ImageIcon,
  Info,
  Plus,
  Trash2,
  Star,
  Eye,
  EyeOff,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Split,
  Check,
  ChevronLeft,
  ChevronRight,
  Bot,
  Zap,
  ShieldCheck,
  ArrowUp,
  ArrowDown,
  Crop as CropIcon,
  Ruler,
} from 'lucide-react';
import type { JewelryItem } from '../types/inventory';
import type { GalleryPack, GallerySlot, ProductMediaPack, ProductMediaAsset, SourceMode, StylingPreset, StyledSlot2Option, ProductMeasurements } from '../types/media';
import {
  fetchMediaPresets,
  generateMediaPack,
  regeneratePackSlot,
  publishPackToShopify,
  fetchMediaJobStatus,
  analyzeMediaAccuracy,
  generatePureWhiteCover,
  requestJewelryAutoCrop,
  requestDetailCrop,
  applyMediaCrop,
  extractMeasurements,
  fetchProductMeasurements,
  applyProductMeasurements,
  type AiAccuracyAnalysis,
} from '../services/mediaService';
import { CropEditorModal } from './CropEditorModal';
import { SideBySideReviewModal } from './SideBySideReviewModal';
import {
  getStoredShopifyConfig,
  saveStoredShopifyConfig,
  syncShopifyConfigWithServer,
  normalizeShopDomain,
  testShopifyConnection,
  findShopifyProductBySku,
  pushItemToShopify,
} from '../services/shopifyService';
import type { ShopifyConfig } from '../types/inventory';
import { getStoredInventory, saveStoredInventory } from '../services/storage';
import { getStoredAiConfig } from '../services/aiVisionService';
import { cleanPhotoBackground } from '../services/apiService';

function extractProductAttributesClient(title: string) {
  const lower = (title || '').toLowerCase();
  let metalTone = 'fine jewelry finish';
  if (/silver|rhodium|white gold|platinum/i.test(lower)) metalTone = 'silver-tone / rhodium finish';
  else if (/rose gold/i.test(lower)) metalTone = 'rose gold finish';
  else if (/gold|yellow gold/i.test(lower)) metalTone = 'yellow gold finish';
  else if (/oxidized|antique/i.test(lower)) metalTone = 'antique oxidized silver finish';

  const stones: string[] = [];
  if (/royal blue|sapphire/i.test(lower)) stones.push('royal blue sapphire');
  if (/emerald|green/i.test(lower)) stones.push('emerald green');
  if (/ruby|red/i.test(lower)) stones.push('ruby red');
  if (/american diamond|ad|cz|cubic zirconia|diamond|moissanite/i.test(lower)) stones.push('sparkling American diamond (CZ)');
  if (/pearl|moti/i.test(lower)) stones.push('lustrous pearls');
  if (/kundan|polki/i.test(lower)) stones.push('kundan polki stones');
  const gemstones = stones.length > 0 ? stones.join(', ') : 'faceted gemstones';

  return { metalTone, gemstones };
}

interface MediaPackStudioModalProps {
  isOpen: boolean;
  onClose: () => void;
  product?: JewelryItem | null;
  onPackPublished?: (productId: string, pack: GalleryPack) => void;
}

interface UploadedFileItem {
  id: string;
  name: string;
  size: number;
  dataUrl: string;
  isMobile9x16?: boolean;
  mediaAssetId?: string;
}

type WorkflowCardId = 'white' | 'model' | 'detail' | 'silk' | 'original';

const WORKFLOW_CARD_ORDER: WorkflowCardId[] = ['white', 'model', 'detail', 'silk', 'original'];

const WORKFLOW_SLOT_NUMBER: Record<WorkflowCardId, number> = {
  white: 1,
  model: 4,
  detail: 3,
  silk: 2,
  original: 5,
};

const LEGACY_SLOT_TO_CARD: Record<number, WorkflowCardId> = {
  1: 'white',
  2: 'silk',
  3: 'detail',
  4: 'model',
  5: 'original',
};

const WORKFLOW_PACK_FIELD: Record<WorkflowCardId, keyof ProductMediaPack> = {
  white: 'whiteProduct',
  model: 'fashionModel',
  detail: 'closeUp',
  silk: 'silkStyled',
  original: 'originalPhoto',
};

const WORKFLOW_CARD_META: Record<WorkflowCardId, {
  title: string;
  description: string;
  badge: string;
  accent: string;
  softBg: string;
}> = {
  white: {
    title: 'White Product (Exact)',
    description: 'Exact jewellery on a pure white background with professional e-commerce framing.',
    badge: 'WHITE BG',
    accent: '#fae084',
    softBg: 'rgba(245, 158, 11, 0.12)',
  },
  model: {
    title: 'Fashion Model',
    description: 'Show the exact jewellery worn naturally on a fashion model.',
    badge: 'MODEL',
    accent: '#a5b4fc',
    softBg: 'rgba(99, 102, 241, 0.13)',
  },
  detail: {
    title: 'Detail Close-up',
    description: 'High-detail product crop showing stones, pendant, earrings or craftsmanship.',
    badge: 'CLOSE-UP',
    accent: '#67e8f9',
    softBg: 'rgba(6, 182, 212, 0.1)',
  },
  silk: {
    title: 'Silk Styled',
    description: 'Luxury supporting image styled with silk and optional floral accents.',
    badge: 'STYLED',
    accent: '#c4b5fd',
    softBg: 'rgba(139, 92, 246, 0.13)',
  },
  original: {
    title: 'Original Photo',
    description: 'Keep an authentic product photo from your upload or professional photoshoot.',
    badge: 'ORIGINAL',
    accent: '#6ee7b7',
    softBg: 'rgba(16, 185, 129, 0.11)',
  },
};

function getWorkflowCardForSlot(slot: Partial<GallerySlot> | any): WorkflowCardId | null {
  const explicitRole = String(slot?.mediaPackRole || slot?.role || '').toLowerCase();
  if (explicitRole === 'whiteproduct' || explicitRole === 'white_product' || explicitRole === 'white') return 'white';
  if (explicitRole === 'fashionmodel' || explicitRole === 'fashion_model' || explicitRole === 'model') return 'model';
  if (explicitRole === 'closeup' || explicitRole === 'close_up' || explicitRole === 'detail') return 'detail';
  if (explicitRole === 'silkstyled' || explicitRole === 'silk_styled' || explicitRole === 'silk') return 'silk';
  if (explicitRole === 'originalphoto' || explicitRole === 'original_photo' || explicitRole === 'original') return 'original';

  const role = String(slot?.slotRole || '').toUpperCase();
  if (role === 'HERO_COVER') return 'white';
  if (role === 'AI_MODEL_LIFESTYLE_1' || role === 'MODEL_1') return 'model';
  if (role === 'DETAIL_CLOSEUP') return 'detail';
  if (role === 'STYLED_SUPPORTING') return 'silk';
  if (role === 'REAL_PHOTO_FALLBACK') return 'original';
  if (role === 'MODEL_2_OR_SUPPORTING' || role === 'AI_MODEL_LIFESTYLE_2') return 'original';
  if (role === 'ALT_VIEW' || role === 'ALT_ANGLE') return LEGACY_SLOT_TO_CARD[Number(slot?.slotNumber)] || null;

  return LEGACY_SLOT_TO_CARD[Number(slot?.slotNumber)] || null;
}

function normalizeSlotForCard(slot: GallerySlot, cardId: WorkflowCardId, coverCard: WorkflowCardId): GallerySlot {
  const meta = WORKFLOW_CARD_META[cardId];
  const slotRoleByCard: Record<WorkflowCardId, GallerySlot['slotRole']> = {
    white: 'HERO_COVER',
    model: 'AI_MODEL_LIFESTYLE_1',
    detail: 'DETAIL_CLOSEUP',
    silk: 'STYLED_SUPPORTING',
    original: 'REAL_PHOTO_FALLBACK',
  };

  return {
    ...slot,
    slotNumber: WORKFLOW_SLOT_NUMBER[cardId],
    slotRole: slotRoleByCard[cardId],
    slotTitle: slot.slotTitle || meta.title,
    isCover: coverCard === cardId,
    mediaPackRole: cardId,
  } as GallerySlot;
}

function orderWorkflowSlots(slots: GallerySlot[], order: WorkflowCardId[] = WORKFLOW_CARD_ORDER): GallerySlot[] {
  return [...slots].sort((a, b) => {
    const aCard = getWorkflowCardForSlot(a);
    const bCard = getWorkflowCardForSlot(b);
    const aRank = aCard ? order.indexOf(aCard) : 99;
    const bRank = bCard ? order.indexOf(bCard) : 99;
    if (aRank !== bRank) return aRank - bRank;
    return (a.slotNumber || 99) - (b.slotNumber || 99);
  });
}

function slotToMediaPackAsset(slot: GallerySlot, cardId: WorkflowCardId): ProductMediaAsset {
  const url = slot.url || (slot as any).imageUrl || (slot as any).src;
  return {
    id: String((slot as any).mediaAssetId || (slot as any).mediaId || (slot as any).id || `${cardId}_${slot.slotNumber}`),
    role: cardId,
    sourceMode: slot.sourceMode || 'auto',
    sourceMediaId: slot.sourceReferenceName || slot.originalUrl || undefined,
    url,
    localPath: url?.startsWith('/api/') ? url : undefined,
    provider: slot.generationProvider,
    generationProvider: slot.generationProvider,
    width: slot.dimensions?.width,
    height: slot.dimensions?.height,
    generatedAt: slot.createdAt,
    createdAt: slot.createdAt,
    isManual: slot.sourceMode === 'manual',
    included: slot.included !== false,
  };
}

function buildProductMediaPack(slots: GallerySlot[]): ProductMediaPack {
  const mediaPack: ProductMediaPack = {};
  for (const slot of slots) {
    const cardId = getWorkflowCardForSlot(slot);
    if (!cardId) continue;
    mediaPack[WORKFLOW_PACK_FIELD[cardId]] = slotToMediaPackAsset(slot, cardId) as any;
    if (cardId === 'white' && slot.isolatedMasterUrl) {
      mediaPack.isolatedMaster = {
        id: `isolated_${(slot as any).mediaAssetId || (slot as any).mediaId || slot.slotNumber}`,
        role: 'isolatedMaster',
        sourceMode: 'auto',
        sourceMediaId: slot.originalUrl,
        url: slot.isolatedMasterUrl,
        localPath: slot.isolatedMasterUrl.startsWith('/api/') ? slot.isolatedMasterUrl : undefined,
        provider: 'photoroom',
        width: slot.dimensions?.width || 2048,
        height: slot.dimensions?.height || 2048,
        generatedAt: slot.createdAt,
        createdAt: slot.createdAt,
        included: false,
      };
    }
  }
  mediaPack.originalImage = mediaPack.originalPhoto;
  return mediaPack;
}

export const MediaPackStudioModal: React.FC<MediaPackStudioModalProps> = ({
  isOpen,
  onClose,
  product,
  onPackPublished,
}) => {
  // Tabs: 'upload_inspect' | 'gallery_builder' | 'social_derivatives'
  const [activeTab, setActiveTab] = useState<'upload_inspect' | 'gallery_builder' | 'social_derivatives'>('upload_inspect');

  // Uploaded files
  const [rawFiles, setRawFiles] = useState<UploadedFileItem[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cardFileInputRefs = useRef<Record<WorkflowCardId, HTMLInputElement | null>>({
    white: null,
    model: null,
    detail: null,
    silk: null,
    original: null,
  });
  const lastLoadedProductKeyRef = useRef<string>('');

  const [sourceModes, setSourceModes] = useState<Record<WorkflowCardId, SourceMode>>({
    white: 'auto',
    model: 'skip',
    detail: 'auto',
    silk: 'skip',
    original: 'auto',
  });
  const [manualCardFiles, setManualCardFiles] = useState<Partial<Record<WorkflowCardId, UploadedFileItem>>>({});
  const [workflowOrder, setWorkflowOrder] = useState<WorkflowCardId[]>(WORKFLOW_CARD_ORDER);
  const [coverCard, setCoverCard] = useState<WorkflowCardId>('white');
  const [detailFocus, setDetailFocus] = useState<'auto' | 'pendant' | 'earrings' | 'stones' | 'cluster'>('auto');
  const [whiteProductRatio, setWhiteProductRatio] = useState<'1:1' | '4:5' | '9:16'>('1:1');
  const [whiteProductMode, setWhiteProductMode] = useState<'ai_presentation' | 'exact_cutout'>('ai_presentation');
  const [whiteProductAiProvider, setWhiteProductAiProvider] = useState<'auto' | 'gemini' | 'openai'>('auto');
  const [showWhiteRegenControls, setShowWhiteRegenControls] = useState(false);
  const [whiteProductCustomInstruction, setWhiteProductCustomInstruction] = useState('');
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [openCardDetails, setOpenCardDetails] = useState<Partial<Record<WorkflowCardId, boolean>>>({});

  // Measurements & ruler calibration
  const [measurements, setMeasurements] = useState<ProductMeasurements | null>(null);
  const [isExtractingMeasurements, setIsExtractingMeasurements] = useState<boolean>(false);
  const [isRebuildingIsolation, setIsRebuildingIsolation] = useState<boolean>(false);
  const [measurementError, setMeasurementError] = useState<string | null>(null);
  const [appliedMeasurementsSuccess, setAppliedMeasurementsSuccess] = useState<boolean>(false);

  // Styling presets
  const [presets, setPresets] = useState<StylingPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>('indian_festive');
  const [slot2Style, setSlot2Style] = useState<StyledSlot2Option>('silk_and_flower');
  const [enableStyledSlot2, setEnableStyledSlot2] = useState<boolean>(false);
  const [enableModelSlot4, setEnableModelSlot4] = useState<boolean>(false);
  const [enableLifestyleSlot5, setEnableLifestyleSlot5] = useState<boolean>(false);
  const [step1PromptSlot2, setStep1PromptSlot2] = useState<string>('');
  const [step1PromptSlot4, setStep1PromptSlot4] = useState<string>('');
  const [step1PromptSlot5, setStep1PromptSlot5] = useState<string>('');
  const [customPrompt, setCustomPrompt] = useState<string>('');
  const [approvalMode, setApprovalMode] = useState<'REVIEW_FIRST' | 'FULL_AUTO'>('REVIEW_FIRST');

  // Pipeline execution & results
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStep, setProcessingStep] = useState<string>('');
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [galleryPack, setGalleryPack] = useState<GalleryPack | null>(null);
  const [pipelineWarnings, setPipelineWarnings] = useState<string[]>([]);
  const [socialOutputs, setSocialOutputs] = useState<Record<string, string>>({});

  // User-chosen AI Reference Image in Step 1
  const [aiReferenceFileId, setAiReferenceFileId] = useState<string | null>(null);

  // AI Image Generation Engine: 'gemini' (Imagen 3 / Pro) vs 'openai' (DALL·E 3)
  const [selectedAiProvider, setSelectedAiProvider] = useState<'gemini' | 'openai'>(() => {
    return getStoredAiConfig().provider || 'gemini';
  });
  // Per-slot AI provider overrides for regeneration
  const [slotAiProvider, setSlotAiProvider] = useState<Record<number, 'gemini' | 'openai'>>({});

  // Regeneration per slot & per-slot selected reference image
  const [regeneratingSlot, setRegeneratingSlot] = useState<number | null>(null);
  const [slotReferenceSource, setSlotReferenceSource] = useState<Record<number, string>>({});
  const [showAddSlotMenu, setShowAddSlotMenu] = useState(false);

  // Per-slot background mode: 'original' | 'white' | 'transparent'
  const [slotBgMode, setSlotBgMode] = useState<Record<number, 'original' | 'white' | 'transparent'>>({});
  const [cleaningSlotBg, setCleaningSlotBg] = useState<number | null>(null);

  // Per-slot editable AI generation prompts
  const [slotCustomPrompts, setSlotCustomPrompts] = useState<Record<number, string>>({});

  // Dedicated Crop Editor Modal State
  const [cropModalState, setCropModalState] = useState<{
    isOpen: boolean;
    slotNumber: number;
    imageUrl: string;
    imageBase64?: string;
    title: string;
  } | null>(null);

  // Dedicated Side-by-Side Review Modal State
  const [sideBySideState, setSideBySideState] = useState<{
    isOpen: boolean;
    originalUrl: string;
    generatedUrl: string;
    productTitle: string;
    slotTitle: string;
    slotNumber: number;
  } | null>(null);

  const getDefaultPromptForSlot = (slotNum: number, role?: string): string => {
    const title = product?.title || 'Jewelry Piece';
    const attrs = extractProductAttributesClient(title);

    if (slotNum === 4 || role === 'MODEL_1' || role === 'AI_MODEL_LIFESTYLE_1') {
      return `Macro close-up commercial jewelry photograph of an elegant Indian fashion model wearing the exact ${title}. Focused tightly on collarbone and neckline, authentic replica of source piece with exact ${attrs.metalTone} and ${attrs.gemstones}, clean atelier studio lighting.`;
    }
    if (slotNum === 5 || role === 'MODEL_2' || role === 'AI_MODEL_LIFESTYLE_2') {
      return `Ultra-luxury commercial still life presentation of ${title} resting gracefully on draped champagne silk fabric with delicate fresh flower petals, crystal sharp focus, studio lighting.`;
    }
    if (slotNum === 2 || role === 'STYLED_SUPPORTING') {
      return `Commercial jewelry presentation of ${title} artfully arranged on pure draped silk cloth with subtle fresh floral accents, no distracting props.`;
    }
    return `Macro high-detail commercial photograph of ${title} showcasing stone setting, facet brilliance, and fine metal craftsmanship under clean studio lighting.`;
  };

  // Shopify sync & connection state
  const [shopifyConfig, setShopifyConfig] = useState<ShopifyConfig>(getStoredShopifyConfig());
  const [showShopifyConnectDrawer, setShowShopifyConnectDrawer] = useState<boolean>(false);
  const [shopifyDomainInput, setShopifyDomainInput] = useState<string>(shopifyConfig.shopDomain || '');
  const [shopifyTokenInput, setShopifyTokenInput] = useState<string>(shopifyConfig.adminAccessToken || '');
  const [shopifyClientIdInput, setShopifyClientIdInput] = useState<string>('');
  const [shopifyClientSecretInput, setShopifyClientSecretInput] = useState<string>('');
  const [shopifyConnectAuthMode, setShopifyConnectAuthMode] = useState<'token' | 'credentials'>('token');
  const [showConnectSecret, setShowConnectSecret] = useState<boolean>(false);
  const [isTestingShopifyConnect, setIsTestingShopifyConnect] = useState<boolean>(false);
  const [shopifyConnectError, setShopifyConnectError] = useState<string | null>(null);

  const [isPublishing, setIsPublishing] = useState(false);
  const [publishSuccessMessage, setPublishSuccessMessage] = useState<string | null>(null);
  const [publishErrorMessage, setPublishErrorMessage] = useState<string | null>(null);

  // Sync Shopify credentials with backend SQLite database on mount
  useEffect(() => {
    if (isOpen) {
      syncShopifyConfigWithServer().then((cfg) => {
        if (cfg) {
          setShopifyConfig(cfg);
          if (cfg.shopDomain) setShopifyDomainInput(cfg.shopDomain);
          if (cfg.adminAccessToken) setShopifyTokenInput(cfg.adminAccessToken);
        }
      });
    }
  }, [isOpen]);

  // Handle direct inline Shopify connection & verification
  const handleInlineConnectShopify = async () => {
    setShopifyConnectError(null);
    if (!shopifyDomainInput.trim()) {
      setShopifyConnectError('Please enter your Shopify store domain (e.g. your-store.myshopify.com)');
      return;
    }

    setIsTestingShopifyConnect(true);
    const cleanDomain = normalizeShopDomain(shopifyDomainInput);

    try {
      let finalToken = shopifyTokenInput.trim();

      if (shopifyConnectAuthMode === 'credentials') {
        if (!shopifyClientIdInput.trim() || !shopifyClientSecretInput.trim()) {
          setShopifyConnectError('Please enter both Client ID and Client Secret');
          setIsTestingShopifyConnect(false);
          return;
        }
        const exchangeRes = await fetch('/api/shopify/exchange-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            shopDomain: cleanDomain,
            clientId: shopifyClientIdInput.trim(),
            clientSecret: shopifyClientSecretInput.trim(),
          }),
        });
        const exchangeData = await exchangeRes.json();
        if (!exchangeRes.ok || !exchangeData.accessToken) {
          throw new Error(exchangeData.error || 'Failed to exchange Client ID/Secret for Access Token');
        }
        finalToken = exchangeData.accessToken;
      }

      if (!finalToken) {
        setShopifyConnectError('Admin API Access Token (shpat_...) is required');
        setIsTestingShopifyConnect(false);
        return;
      }

      const candidateConfig: ShopifyConfig = {
        shopDomain: cleanDomain,
        adminAccessToken: finalToken,
        apiVersion: '2026-07',
        isConnected: false,
        defaultStatus: 'draft',
      };

      const testRes = await testShopifyConnection(candidateConfig);
      if (!testRes.success) {
        throw new Error(testRes.error || 'Failed to connect to Shopify. Please verify your domain and access token.');
      }

      const activeConfig: ShopifyConfig = {
        ...candidateConfig,
        isConnected: true,
        shopName: testRes.shopName,
        email: testRes.email,
        currency: testRes.currency,
        primaryLocationId: testRes.primaryLocationId,
        locationName: testRes.locationName,
      };

      saveStoredShopifyConfig(activeConfig);
      setShopifyConfig(activeConfig);
      setPublishErrorMessage(null);
      setPublishSuccessMessage(`✅ Successfully connected to ${testRes.shopName || cleanDomain}! You can now push directly to Shopify.`);
      setShowShopifyConnectDrawer(false);
    } catch (err: any) {
      setShopifyConnectError(err.message || 'Connection test failed. Check domain and token.');
    } finally {
      setIsTestingShopifyConnect(false);
    }
  };

  // Full-Screen Image Preview / Lightbox state
  const [previewSlotIndex, setPreviewSlotIndex] = useState<number | null>(null);
  const [previewRawFileId, setPreviewRawFileId] = useState<string | null>(null);
  const [previewZoom, setPreviewZoom] = useState<number>(1);
  const [showComparison, setShowComparison] = useState<boolean>(false);

  // AI Accuracy Analysis & Viewport Inspection state
  const [accuracyMap, setAccuracyMap] = useState<Record<number, AiAccuracyAnalysis>>({});
  const [isAnalyzingAccuracy, setIsAnalyzingAccuracy] = useState<boolean>(false);
  const [showAccuracyDetails, setShowAccuracyDetails] = useState<boolean>(false);
  const [syncScroll, setSyncScroll] = useState<boolean>(true);

  // Lightbox scroll references for vertical & horizontal inspection
  const leftScrollRef = useRef<HTMLDivElement>(null);
  const rightScrollRef = useRef<HTMLDivElement>(null);
  const singleScrollRef = useRef<HTMLDivElement>(null);
  const rawFileScrollRef = useRef<HTMLDivElement>(null);
  const isSyncingScrollRef = useRef<boolean>(false);

  const handleLeftScroll = () => {
    if (!syncScroll || isSyncingScrollRef.current) return;
    if (leftScrollRef.current && rightScrollRef.current) {
      isSyncingScrollRef.current = true;
      const left = leftScrollRef.current;
      const maxLeft = left.scrollHeight - left.clientHeight;
      if (maxLeft > 0) {
        const ratio = left.scrollTop / maxLeft;
        const right = rightScrollRef.current;
        const maxRight = right.scrollHeight - right.clientHeight;
        right.scrollTop = ratio * maxRight;
      }
      setTimeout(() => {
        isSyncingScrollRef.current = false;
      }, 40);
    }
  };

  const handleRightScroll = () => {
    if (!syncScroll || isSyncingScrollRef.current) return;
    if (leftScrollRef.current && rightScrollRef.current) {
      isSyncingScrollRef.current = true;
      const right = rightScrollRef.current;
      const maxRight = right.scrollHeight - right.clientHeight;
      if (maxRight > 0) {
        const ratio = right.scrollTop / maxRight;
        const left = leftScrollRef.current;
        const maxLeft = left.scrollHeight - left.clientHeight;
        left.scrollTop = ratio * maxLeft;
      }
      setTimeout(() => {
        isSyncingScrollRef.current = false;
      }, 40);
    }
  };

  const scrollToPosition = (position: 'top' | 'center' | 'bottom') => {
    const targets = showComparison
      ? [leftScrollRef.current, rightScrollRef.current]
      : [singleScrollRef.current, rawFileScrollRef.current];

    targets.forEach((el) => {
      if (!el) return;
      if (position === 'top') {
        el.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (position === 'center') {
        el.scrollTo({ top: Math.max(0, (el.scrollHeight - el.clientHeight) / 2), behavior: 'smooth' });
      } else if (position === 'bottom') {
        el.scrollTo({ top: Math.max(0, el.scrollHeight - el.clientHeight), behavior: 'smooth' });
      }
    });
  };

  const triggerAccuracyAnalysis = async (slotNumber: number, force = false) => {
    if (!force && accuracyMap[slotNumber]) return;
    const currentSlot = galleryPack?.slots.find((s) => s.slotNumber === slotNumber);
    if (!currentSlot) return;
    const genUrl = currentSlot.url || (currentSlot as any).imageUrl || (currentSlot as any).src;
    const originalUrl = rawFiles[0]?.dataUrl || (galleryPack?.slots[0]?.url || (galleryPack?.slots[0] as any)?.imageUrl);
    if (!genUrl || !originalUrl) return;

    setIsAnalyzingAccuracy(true);
    try {
      const res = await analyzeMediaAccuracy({
        originalImageUrl: originalUrl,
        generatedImageUrl: genUrl,
        productTitle: product?.title || 'Jewellery',
      });
      if (res.success && res.analysis) {
        setAccuracyMap((prev) => ({ ...prev, [slotNumber]: res.analysis! }));
      }
    } catch (err) {
      console.error('Failed to analyze design accuracy', err);
    } finally {
      setIsAnalyzingAccuracy(false);
    }
  };

  useEffect(() => {
    if (previewSlotIndex !== null && galleryPack?.slots && galleryPack.slots[previewSlotIndex]) {
      const currentSlot = galleryPack.slots[previewSlotIndex];
      const isAi =
        currentSlot.isAiGenerated ||
        currentSlot.sourceType === 'ai_model' ||
        currentSlot.sourceType === 'ai_lifestyle' ||
        currentSlot.sourceType === 'AI_MODEL' ||
        currentSlot.slotRole === 'STYLED_SUPPORTING' ||
        (currentSlot.slotRole as string) === 'MODEL_1' ||
        (currentSlot.slotRole as string) === 'MODEL_2_OR_SUPPORTING' ||
        currentSlot.slotRole === 'AI_MODEL_LIFESTYLE_1' ||
        currentSlot.slotRole === 'AI_MODEL_LIFESTYLE_2';

      if (isAi && !accuracyMap[currentSlot.slotNumber]) {
        triggerAccuracyAnalysis(currentSlot.slotNumber);
      }
    }
  }, [previewSlotIndex, galleryPack]);

  // Keyboard navigation for image preview lightbox (Arrow keys and Escape)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (previewSlotIndex !== null && galleryPack?.slots && galleryPack.slots.length > 0) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setPreviewSlotIndex((prev) => (prev !== null && prev > 0 ? prev - 1 : galleryPack.slots.length - 1));
          setPreviewZoom(1);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          setPreviewSlotIndex((prev) => (prev !== null && prev < galleryPack.slots.length - 1 ? prev + 1 : 0));
          setPreviewZoom(1);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setPreviewSlotIndex(null);
          setPreviewZoom(1);
        }
      } else if (previewRawFileId !== null) {
        if (e.key === 'Escape') {
          setPreviewRawFileId(null);
          setPreviewZoom(1);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewSlotIndex, previewRawFileId, galleryPack]);

  // Load presets on open & isolate product session
  useEffect(() => {
    if (isOpen) {
      fetchMediaPresets().then((list) => {
        if (list && list.length > 0) {
          setPresets(list);
          if (!selectedPreset) setSelectedPreset(list[0].id);
        }
      });

      const currentProductKey = `${product?.id || ''}_${product?.sku || ''}`;
      if (lastLoadedProductKeyRef.current !== currentProductKey) {
        lastLoadedProductKeyRef.current = currentProductKey;
        // Clean session reset: clear images from any previous product to prevent image leakage across products
        setGalleryPack(null);
        setSocialOutputs({});
        setPipelineWarnings([]);
        setActiveTab('upload_inspect');
        setSlotCustomPrompts({});
        setSlotBgMode({});
        setSlotReferenceSource({});

        const primary = product?.imageUrl || (product as any)?.primaryImageUrl;
        if (primary) {
          setRawFiles([
            {
              id: 'existing-hero',
              name: `${product?.sku || 'product'}-hero.jpg`,
              size: 0,
              dataUrl: primary,
              isMobile9x16: false,
            },
          ]);
          setAiReferenceFileId('existing-hero');
        } else {
          setRawFiles([]);
          setAiReferenceFileId(null);
        }

        if (product?.id) {
          fetchProductMeasurements(product.id)
            .then((res) => {
              if (res.success && res.measurements) {
                setMeasurements(res.measurements);
              } else {
                setMeasurements(null);
              }
            })
            .catch(() => setMeasurements(null));
        } else {
          setMeasurements(null);
        }
      }
    } else {
      lastLoadedProductKeyRef.current = '';
    }
  }, [isOpen, product]);

  if (!isOpen) return null;

  // File drop / select handler
  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const maxFiles = 20;
    const countToTake = Math.min(files.length, maxFiles);

    Array.from(files).slice(0, countToTake).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const rawDataUrl = e.target?.result as string;
        const img = new Image();
        img.onload = () => {
          const is9x16 = img.height > img.width && img.height / img.width >= 1.6;
          const newId = `upload-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

          // Downscale oversized images (e.g. 4000x3000 phone camera shots) to 2048px maximum dimension.
          // This reduces payload from 15-20MB down to ~600KB, preventing HTTP 413 & network timeouts.
          let finalDataUrl = rawDataUrl;
          const maxDim = 2048;
          if (img.width > maxDim || img.height > maxDim) {
            try {
              const canvas = document.createElement('canvas');
              let w = img.width;
              let h = img.height;
              if (w > h) {
                h = Math.round((h * maxDim) / w);
                w = maxDim;
              } else {
                w = Math.round((w * maxDim) / h);
                h = maxDim;
              }
              canvas.width = w;
              canvas.height = h;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.drawImage(img, 0, 0, w, h);
                finalDataUrl = canvas.toDataURL('image/jpeg', 0.92);
              }
            } catch (canvasErr) {
              console.warn('Canvas optimization fallback to original:', canvasErr);
            }
          }

          setRawFiles((prev) => {
            // CRITICAL FIX: If prev only contains auto-seeded 'existing-hero', discard it and replace with newly uploaded authentic photos!
            // Do NOT mix an old or placeholder photo from another product into the current jewelry pack.
            const hasOnlyExistingHero = prev.length === 1 && (prev[0].id === 'existing-hero' || prev[0].id.startsWith('existing-'));
            const baseList = hasOnlyExistingHero ? [] : prev;
            if (!aiReferenceFileId || hasOnlyExistingHero) {
              setAiReferenceFileId(newId);
            }
            return [
              ...baseList,
              {
                id: newId,
                name: file.name,
                size: finalDataUrl.length,
                dataUrl: finalDataUrl,
                isMobile9x16: is9x16,
              },
            ];
          });
        };
        img.src = rawDataUrl;
      };
      reader.readAsDataURL(file);
    });
  };

  const removeFile = (id: string) => {
    setRawFiles((prev) => {
      const next = prev.filter((f) => f.id !== id);
      if (aiReferenceFileId === id) {
        setAiReferenceFileId(next[0]?.id || null);
      }
      return next;
    });
  };

  const getWorkflowSlot = (cardId: WorkflowCardId, pack: GalleryPack | null = galleryPack) => {
    if (!pack) return undefined;
    return (
      pack.slots.find((slot) => getWorkflowCardForSlot(slot) === cardId) ||
      pack.slots.find((slot) => slot.slotNumber === WORKFLOW_SLOT_NUMBER[cardId])
    );
  };

  const getCardPreviewUrl = (cardId: WorkflowCardId) => {
    const manual = sourceModes[cardId] === 'manual' ? manualCardFiles[cardId]?.dataUrl : undefined;
    if (manual) return manual;
    const slot = getWorkflowSlot(cardId);
    const slotUrl = slot?.url || (slot as any)?.imageUrl || (slot as any)?.src;
    if (cardId === 'white') {
      // NEVER fall back to original raw photo for White Product
      return slotUrl || galleryPack?.slots[0]?.cleanCoverUrl || '';
    }
    if (slotUrl) return slotUrl;
    if (cardId === 'original') return rawFiles[0]?.dataUrl || product?.imageUrl || (product as any)?.primaryImageUrl || '';
    return '';
  };

  const getCardStatus = (cardId: WorkflowCardId) => {
    if (sourceModes[cardId] === 'skip') return 'SKIPPED';
    if (sourceModes[cardId] === 'manual' && manualCardFiles[cardId]) return 'MANUAL';
    const slot = getWorkflowSlot(cardId);
    if (slot?.generationFailed) return 'FAILED';
    if (cardId === 'original' && getCardPreviewUrl(cardId)) return 'ORIGINAL';
    if (slot?.url || (slot as any)?.imageUrl) return slot?.included === false ? 'NEEDS REVIEW' : 'GENERATED';
    return sourceModes[cardId] === 'auto' ? 'AUTO' : 'NEEDS REVIEW';
  };

  const makeManualSlot = (
    cardId: WorkflowCardId,
    file: UploadedFileItem,
    existing?: GallerySlot,
    sourceMode: SourceMode = 'manual'
  ): GallerySlot => {
    const meta = WORKFLOW_CARD_META[cardId];
    const slotNumber = WORKFLOW_SLOT_NUMBER[cardId];
    const roleByCard: Record<WorkflowCardId, GallerySlot['slotRole']> = {
      white: 'HERO_COVER',
      model: 'AI_MODEL_LIFESTYLE_1',
      detail: 'DETAIL_CLOSEUP',
      silk: 'STYLED_SUPPORTING',
      original: 'REAL_PHOTO_FALLBACK',
    };
    return {
      ...(existing || {}),
      slotNumber,
      slotRole: roleByCard[cardId],
      slotTitle: meta.title,
      mediaAssetId: `manual_${cardId}_${file.id}`,
      url: file.dataUrl,
      imageUrl: file.dataUrl,
      thumbnailUrl: file.dataUrl,
      sourceType: 'real_photo',
      altText: existing?.altText || `${product?.title || 'Jewellery'} ${meta.title}`,
      seoKeywords: existing?.seoKeywords || ['jewellery', meta.title.toLowerCase()],
      dimensions: existing?.dimensions || { width: 2048, height: 2048 },
      isCover: coverCard === cardId,
      isAiGenerated: false,
      canRegenerate: false,
      included: true,
      sourceReferenceName: file.name,
      generationFailed: false,
      generationError: undefined,
      sourceMode,
      generationProvider: sourceMode === 'manual' ? 'manual-upload' : 'original',
      createdAt: new Date().toISOString(),
      mediaPackRole: cardId,
    } as GallerySlot;
  };

  const applyWorkflowModesToPack = (pack: GalleryPack): GalleryPack => {
    const slotMap = new Map<WorkflowCardId, GallerySlot>();
    pack.slots.forEach((slot) => {
      const cardId = getWorkflowCardForSlot(slot);
      if (cardId && !slotMap.has(cardId)) {
        slotMap.set(cardId, normalizeSlotForCard({ ...slot }, cardId, coverCard));
      }
    });

    WORKFLOW_CARD_ORDER.forEach((cardId) => {
      const existing = slotMap.get(cardId);
      const mode = sourceModes[cardId];
      const manual = manualCardFiles[cardId];

      if (mode === 'manual' && manual) {
        slotMap.set(cardId, makeManualSlot(cardId, manual, existing));
        return;
      }

      if (cardId === 'original' && mode === 'auto') {
        const source = rawFiles[0];
        if (source) {
          slotMap.set(cardId, makeManualSlot(cardId, source, existing, 'auto'));
          return;
        }
      }

      if (existing) {
        slotMap.set(cardId, normalizeSlotForCard({
          ...existing,
          slotTitle: WORKFLOW_CARD_META[cardId].title,
          included: mode !== 'skip',
          isCover: coverCard === cardId,
          sourceMode: mode,
        }, cardId, coverCard));
      }
    });

    const orderedSlots = orderWorkflowSlots(Array.from(slotMap.values()), workflowOrder)
      .map((slot) => ({ ...slot, isCover: getWorkflowCardForSlot(slot) === coverCard }));

    return { ...pack, slots: orderedSlots, sourceModes, mediaPack: buildProductMediaPack(orderedSlots) };
  };

  const handleManualCardUpload = (cardId: WorkflowCardId, files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const item: UploadedFileItem = {
        id: `manual-${cardId}-${Date.now()}`,
        name: file.name,
        size: dataUrl.length,
        dataUrl,
      };
      setManualCardFiles((prev) => ({ ...prev, [cardId]: item }));
      setSourceModes((prev) => ({ ...prev, [cardId]: 'manual' }));
      setGalleryPack((prev) => {
        if (!prev) return prev;
        const existing = getWorkflowSlot(cardId, prev);
        const nextSlots = prev.slots.filter((slot) => getWorkflowCardForSlot(slot) !== cardId && slot.slotNumber !== WORKFLOW_SLOT_NUMBER[cardId]);
        nextSlots.push(makeManualSlot(cardId, item, existing));
        const orderedSlots = orderWorkflowSlots(nextSlots, workflowOrder)
          .map((slot) => ({ ...slot, isCover: getWorkflowCardForSlot(slot) === coverCard }));
        return {
          ...prev,
          slots: orderedSlots,
          mediaPack: buildProductMediaPack(orderedSlots),
        };
      });
    };
    reader.readAsDataURL(file);
  };

  const selectedCount = WORKFLOW_CARD_ORDER.filter((cardId) => sourceModes[cardId] !== 'skip').length;
  const manualCount = WORKFLOW_CARD_ORDER.filter((cardId) => sourceModes[cardId] === 'manual' && manualCardFiles[cardId]).length;
  const generatedCount = WORKFLOW_CARD_ORDER.filter((cardId) => {
    const slot = getWorkflowSlot(cardId);
    return Boolean(slot?.url || (slot as any)?.imageUrl) && !manualCardFiles[cardId] && sourceModes[cardId] !== 'skip';
  }).length;
  const readyCount = WORKFLOW_CARD_ORDER.filter((cardId) => {
    const status = getCardStatus(cardId);
    return status === 'GENERATED' || status === 'MANUAL' || status === 'ORIGINAL';
  }).length;
  const selectedAutoLabels = WORKFLOW_CARD_ORDER
    .filter((cardId) => sourceModes[cardId] === 'auto')
    .map((cardId) => WORKFLOW_CARD_META[cardId].title);
  const modelStylingPresets = presets.filter((p) => p.id !== 'ecommerce_white_product');

  const anyAiSelected = sourceModes.silk === 'auto' || sourceModes.model === 'auto';

  // Run Media Pack Pipeline
  const runPipeline = async () => {
    if (rawFiles.length === 0) {
      alert('Please upload at least 1 real product photo.');
      return;
    }

    setIsProcessing(true);
    setProcessingStep('Analyzing mobile photos, framing non-destructive squares...');
    setProgressPercent(15);
    setPublishErrorMessage(null);
    setPublishSuccessMessage(null);

    const payload = {
      productId: product?.id,
      sku: product?.sku,
      newFiles: rawFiles.map((f) => ({
        id: f.id,
        filename: f.name,
        base64Data: f.dataUrl,
      })),
      stylingPreset: selectedPreset,
      slot2StyleOption: slot2Style,
      enableStyledSlot2: sourceModes.silk === 'auto',
      enableModelGeneration: anyAiSelected,
      enableModelSlot4: sourceModes.model === 'auto',
      enableLifestyleSlot5: false,
      customPrompt: customPrompt.trim() || undefined,
      customPromptSlot2: step1PromptSlot2.trim() || undefined,
      customPromptSlot4: step1PromptSlot4.trim() || undefined,
      customPromptSlot5: step1PromptSlot5.trim() || undefined,
      approvalMode,
      autoPushShopify: approvalMode === 'FULL_AUTO',
      aiReferenceFileId: aiReferenceFileId || rawFiles[0]?.id,
      aiProvider: selectedAiProvider,
      sourceModes,
      selectedOutputTypes: WORKFLOW_CARD_ORDER.filter((cardId) => sourceModes[cardId] !== 'skip'),
      whiteProductOutputRatio: whiteProductRatio,
      whiteProductMode,
      whiteProductAiProvider,
    };

    const stepTimer = setInterval(() => {
      setProgressPercent((prev) => {
        if (!anyAiSelected) {
          if (prev < 50) {
            setProcessingStep('Framing authentic product photos into 2048px master squares...');
            return 50;
          } else if (prev < 90) {
            setProcessingStep('Composing Shopify gallery from real photos...');
            return 90;
          }
          return prev;
        }
        if (prev < 35) {
          setProcessingStep('Framing photos & preparing square derivatives...');
          return 35;
        } else if (prev < 65) {
          setProcessingStep(sourceModes.silk === 'auto' ? 'Generating Silk Styled image...' : 'Processing selected gallery cards...');
          return 65;
        } else if (prev < 85) {
          setProcessingStep(sourceModes.model === 'auto' ? 'Generating Fashion Model image...' : 'Composing selected gallery cards...');
          return 85;
        } else if (prev < 95) {
          setProcessingStep('Composing recommended Shopify gallery pack...');
          return 95;
        }
        return prev;
      });
    }, 1200);

    try {
      const res = await generateMediaPack(payload);
      clearInterval(stepTimer);

      if (!res.success) {
        setIsProcessing(false);
        setPublishErrorMessage(res.message || 'Media Pack generation failed');
        alert(res.message || 'Media Pack generation failed');
        return;
      }

      if (step1PromptSlot2.trim()) {
        setSlotCustomPrompts((prev) => ({ ...prev, 2: step1PromptSlot2.trim() }));
      }
      if (step1PromptSlot4.trim()) {
        setSlotCustomPrompts((prev) => ({ ...prev, 4: step1PromptSlot4.trim() }));
      }
      if (step1PromptSlot5.trim()) {
        setSlotCustomPrompts((prev) => ({ ...prev, 5: step1PromptSlot5.trim() }));
      }

      if (res.jobId) {
        setActiveJobId(res.jobId);
        const pollInterval = setInterval(async () => {
          const job = await fetchMediaJobStatus(res.jobId!);
          if (job) {
            setProgressPercent(job.progress_percent || 50);
            setProcessingStep(job.current_step || 'Processing media pack...');

            if (job.status === 'COMPLETED') {
              clearInterval(pollInterval);
              setIsProcessing(false);
              if (job.result_summary?.galleryPack) {
                const workflowPack = applyWorkflowModesToPack(job.result_summary.galleryPack);
                setGalleryPack(workflowPack);
                setPipelineWarnings(workflowPack.warnings || []);
                if (job.result_summary.socialDerivatives) {
                  setSocialOutputs(job.result_summary.socialDerivatives);
                }
                setActiveTab('gallery_builder');
              }
            } else if (job.status === 'FAILED') {
              clearInterval(pollInterval);
              setIsProcessing(false);
              alert(`Job failed: ${job.error_message || 'Unknown error'}`);
            }
          }
        }, 1500);
      } else if (res.galleryPack) {
        setProgressPercent(100);
        setProcessingStep('Gallery ready!');
        setIsProcessing(false);
        const workflowPack = applyWorkflowModesToPack(res.galleryPack);
        setGalleryPack(workflowPack);
        setPipelineWarnings(workflowPack.warnings || []);
        if (res.galleryPack.socialDerivatives) {
          setSocialOutputs(res.galleryPack.socialDerivatives);
        }
        setActiveTab('gallery_builder');
      }
    } catch (err: any) {
      clearInterval(stepTimer);
      setIsProcessing(false);
      alert('An unexpected error occurred during generation: ' + (err.message || String(err)));
    }
  };

  // Move Slot Left/Right
  const swapSlots = (indexA: number, indexB: number) => {
    if (!galleryPack) return;
    const slots = [...galleryPack.slots];
    if (indexA < 0 || indexA >= slots.length || indexB < 0 || indexB >= slots.length) return;

    const cardA = getWorkflowCardForSlot(slots[indexA]);
    const cardB = getWorkflowCardForSlot(slots[indexB]);
    if (cardA && cardB) {
      setWorkflowOrder((prev) => {
        const next = [...prev];
        const aIdx = next.indexOf(cardA);
        const bIdx = next.indexOf(cardB);
        if (aIdx >= 0 && bIdx >= 0) {
          [next[aIdx], next[bIdx]] = [next[bIdx], next[aIdx]];
        }
        return next;
      });
    }

    const temp = slots[indexA];
    slots[indexA] = slots[indexB];
    slots[indexB] = temp;

    const updated = slots.map((s) => ({
      ...s,
      isCover: getWorkflowCardForSlot(s) === coverCard,
    }));

    setGalleryPack({
      ...galleryPack,
      slots: updated,
      mediaPack: buildProductMediaPack(updated),
    });
  };

  // Set explicit slot as hero cover without mutating semantic role.
  const setSlotAsCover = (slotIdx: number) => {
    if (!galleryPack) return;
    const picked = galleryPack.slots[slotIdx];
    const pickedCard = getWorkflowCardForSlot(picked);
    if (!pickedCard) return;
    setCoverCard(pickedCard);
    const updated = galleryPack.slots.map((s) => ({
      ...s,
      isCover: getWorkflowCardForSlot(s) === pickedCard,
    }));

    setGalleryPack({
      ...galleryPack,
      slots: updated,
      mediaPack: buildProductMediaPack(updated),
    });
  };

  // Dedicated Crop Editor Handlers
  const handleOpenCropModal = (slotNumber: number, imageUrl: string, title?: string) => {
    let base64: string | undefined = undefined;
    const targetSlot = galleryPack?.slots.find((s) => s.slotNumber === slotNumber);
    const matchedRaw = rawFiles.find((f) => targetSlot?.mediaAssetId?.includes(f.id));
    if (matchedRaw) {
      base64 = matchedRaw.dataUrl;
    }
    setCropModalState({
      isOpen: true,
      slotNumber,
      imageUrl,
      imageBase64: base64,
      title: title || `Edit Crop — Slot ${slotNumber}`,
    });
  };

  const handleApplyCropResult = (slotNumber: number, result: { url: string; base64?: string; cropRect: any }) => {
    if (!galleryPack) return;
    const updated = galleryPack.slots.map((s) =>
      s.slotNumber === slotNumber
        ? {
            ...s,
            url: result.url,
            imageUrl: result.url,
            cleanCoverUrl: s.slotNumber === 1 ? result.url : s.cleanCoverUrl,
            cropData: result.cropRect,
          }
        : s
    );
    setGalleryPack({ ...galleryPack, slots: updated });
  };

  const handleAutoCropSlot = async (slotNumber: number) => {
    if (!galleryPack) return;
    const targetSlot = galleryPack.slots.find((s) => s.slotNumber === slotNumber);
    if (!targetSlot) return;

    try {
      const res = await requestJewelryAutoCrop({
        url: targetSlot.url,
      });
      if (res.success && res.crop) {
        const cropRes = await applyMediaCrop({
          url: targetSlot.url,
          crop: res.crop,
        });
        if (cropRes.success && cropRes.url) {
          handleApplyCropResult(slotNumber, { url: cropRes.url, cropRect: res.crop });
        }
      }
    } catch (e: any) {
      alert('Auto-crop notice: ' + e.message);
    }
  };

  const handleRegenerateDetailCloseup = async () => {
    if (!galleryPack) return;
    const targetSlot = getWorkflowSlot('detail') || getWorkflowSlot('white') || getWorkflowSlot('original');
    const sourceUrl =
      targetSlot?.originalUrl ||
      targetSlot?.isolatedMasterUrl ||
      targetSlot?.url ||
      rawFiles[0]?.dataUrl;
    if (!sourceUrl) return;

    const targetRegion =
      detailFocus === 'earrings'
        ? 'earrings'
        : detailFocus === 'stones' || detailFocus === 'cluster'
        ? 'stones'
        : 'pendant';

    try {
      setRegeneratingSlot(WORKFLOW_SLOT_NUMBER.detail);
      const res = await requestDetailCrop({
        url: sourceUrl,
        targetRegion,
      });
      if (!res.success || !res.url) {
        throw new Error(res.error || 'Detail close-up generation failed');
      }

      const existing = getWorkflowSlot('detail');
      const detailSlot: GallerySlot = normalizeSlotForCard({
        ...(existing || {}),
        slotNumber: WORKFLOW_SLOT_NUMBER.detail,
        slotRole: 'DETAIL_CLOSEUP',
        slotTitle: WORKFLOW_CARD_META.detail.title,
        mediaAssetId: existing?.mediaAssetId || `detail_${Date.now()}`,
        sourceType: 'detail_crop',
        url: res.url,
        imageUrl: res.url,
        thumbnailUrl: res.url,
        altText: existing?.altText || `${product?.title || 'Jewellery'} detail close-up`,
        seoKeywords: existing?.seoKeywords || ['jewellery', 'detail close-up'],
        dimensions: existing?.dimensions || { width: 2048, height: 2048 },
        isCover: coverCard === 'detail',
        isAiGenerated: false,
        canRegenerate: true,
        included: true,
        sourceMode: 'auto',
        generationProvider: 'deterministic-crop',
        createdAt: new Date().toISOString(),
      } as GallerySlot, 'detail', coverCard);

      const nextSlots = galleryPack.slots.filter((slot) => getWorkflowCardForSlot(slot) !== 'detail');
      nextSlots.push(detailSlot);
      const ordered = orderWorkflowSlots(nextSlots, workflowOrder);
      setGalleryPack({ ...galleryPack, slots: ordered, mediaPack: buildProductMediaPack(ordered) });
    } catch (e: any) {
      alert('Failed to regenerate detail close-up: ' + (e?.message || 'Unknown error'));
    } finally {
      setRegeneratingSlot(null);
    }
  };

  const handleRebuildWhiteCover = async (overrideOptions?: {
    mode?: 'exact_cutout' | 'ai_presentation';
    ratio?: '1:1' | '4:5' | '9:16';
    aiProvider?: 'auto' | 'gemini' | 'openai';
    customInstruction?: string;
  }) => {
    if (!galleryPack) return;
    const slot1 = galleryPack.slots.find((s) => s.slotNumber === 1);
    if (!slot1) return;

    try {
      setCleaningSlotBg(1);
      const targetMode = overrideOptions?.mode || whiteProductMode;
      const targetRatio = overrideOptions?.ratio || whiteProductRatio;
      const targetProvider = overrideOptions?.aiProvider || whiteProductAiProvider;

      const res = await generatePureWhiteCover({
        url: slot1.originalUrl || slot1.url,
        backgroundMode: 'pure_white',
        outputRatio: targetRatio,
        whiteProductMode: targetMode,
        aiProvider: targetProvider,
        productTitle: product?.title,
        customInstruction: overrideOptions?.customInstruction,
      });
      if (res.success && res.url) {
        const updated = galleryPack.slots.map((s) =>
          s.slotNumber === 1
            ? {
                ...s,
                url: res.url!,
                imageUrl: res.url!,
                cleanCoverUrl: res.url!,
                exactCutoutUrl: res.exactCutoutUrl || s.exactCutoutUrl,
                whiteProductMode: res.mode || targetMode,
                productMatchScore: res.productMatchScore !== undefined ? res.productMatchScore : s.productMatchScore,
                matchVerdict: res.matchVerdict || s.matchVerdict,
                accuracyAnalysis: res.accuracyAnalysis || s.accuracyAnalysis,
                isolatedMasterUrl: res.isolatedMasterUrl || s.isolatedMasterUrl,
                transparentUrl: res.isolatedMasterUrl || s.transparentUrl,
                currentBgMode: 'white' as const,
                dimensions: res.width && res.height ? { width: res.width, height: res.height } : s.dimensions,
                outputRatio: res.outputRatio || targetRatio,
                segmentationQuality: res.quality,
              }
            : s
        );
        setGalleryPack({ ...galleryPack, slots: updated, mediaPack: buildProductMediaPack(updated) });
      }
    } catch (e: any) {
      alert('Failed to rebuild white cover: ' + e.message);
    } finally {
      setCleaningSlotBg(null);
    }
  };

  const handleUseExactCutout = () => {
    if (!galleryPack) return;
    const slot1 = galleryPack.slots.find((s) => s.slotNumber === 1);
    if (!slot1) return;
    const exactUrl = slot1.exactCutoutUrl || slot1.isolatedMasterUrl || slot1.url;

    const updated = galleryPack.slots.map((s) =>
      s.slotNumber === 1
        ? {
            ...s,
            url: exactUrl,
            imageUrl: exactUrl,
            cleanCoverUrl: exactUrl,
            whiteProductMode: 'exact_cutout' as const,
            productMatchScore: 100,
            matchVerdict: 'HIGH_MATCH' as const,
          }
        : s
    );
    setGalleryPack({ ...galleryPack, slots: updated, mediaPack: buildProductMediaPack(updated) });
  };

  const handleOpenSideBySideReview = (slotNumber: number) => {
    if (!galleryPack) return;
    const slot = galleryPack.slots.find((s) => s.slotNumber === slotNumber);
    if (!slot) return;
    const authenticSlot = galleryPack.slots.find(
      (s) => (s.slotRole as string) === 'ORIGINAL_AUTHENTIC' || s.slotRole === 'REAL_PHOTO_FALLBACK' || s.slotNumber === 5
    );
    const orig = slot.originalUrl || authenticSlot?.url || galleryPack.slots[0]?.originalUrl || rawFiles[0]?.dataUrl || galleryPack.slots[0]?.url || '';
    setSideBySideState({
      isOpen: true,
      originalUrl: orig,
      generatedUrl: slot.url,
      productTitle: product?.title || 'Jewelry Item',
      slotTitle: slot.slotTitle || `Slot ${slot.slotNumber}`,
      slotNumber,
    });
  };

  // Update SEO Alt text
  const updateSlotAltText = (slotIdx: number, newAlt: string) => {
    if (!galleryPack) return;
    const slots = [...galleryPack.slots];
    slots[slotIdx] = { ...slots[slotIdx], altText: newAlt };
    setGalleryPack({ ...galleryPack, slots });
  };

  const handleExtractMeasurements = async () => {
    if (!product?.id) return;
    setIsExtractingMeasurements(true);
    setMeasurementError(null);
    try {
      // Measurements MUST strictly run against ORIGINAL_SOURCE (raw upload photo),
      // NEVER against White Product or isolated master where ruler was eliminated.
      const originalSourceMediaId =
        rawFiles[0]?.mediaAssetId ||
        (product as any)?.primaryMediaId ||
        (product as any)?.mediaId ||
        '';

      const sourceUrl =
        rawFiles[0]?.dataUrl ||
        getCardPreviewUrl('original') ||
        product.imageUrl ||
        (product as any)?.primaryImageUrl ||
        '';

      const res = await extractMeasurements({
        imageUrl: sourceUrl,
        mediaId: originalSourceMediaId || undefined,
        originalSourceMediaId: originalSourceMediaId || undefined,
        productId: product.id,
      });

      if (res.success && res.measurements) {
        setMeasurements(res.measurements);
      } else {
        setMeasurementError(
          res.error ||
            (res.hasRuler
              ? 'Measurements could not be calculated from ruler'
              : 'No ruler or scale detected in the source photograph. Please ensure the original photo includes a visible ruler.')
        );
      }
    } catch (err: any) {
      setMeasurementError(err.message || 'Measurement extraction failed');
    } finally {
      setIsExtractingMeasurements(false);
    }
  };

  const handleApplyMeasurements = async () => {
    if (!product?.id || !measurements) return;
    try {
      const res = await applyProductMeasurements(product.id, measurements);
      if (res.success) {
        setAppliedMeasurementsSuccess(true);
        setTimeout(() => setAppliedMeasurementsSuccess(false), 4000);
      } else {
        setMeasurementError(res.error || 'Failed to save measurements');
      }
    } catch (err: any) {
      setMeasurementError(err.message || 'Failed to apply measurements to product attributes');
    }
  };

  // Delete slot from gallery pack
  const deleteSlot = (slotIdx: number) => {
    if (!galleryPack) return;
    if (galleryPack.slots.length <= 1) {
      alert('You must keep at least 1 image in the gallery pack.');
      return;
    }
    const removedCard = getWorkflowCardForSlot(galleryPack.slots[slotIdx]);
    const remaining = galleryPack.slots.filter((_, idx) => idx !== slotIdx);
    const nextCover = removedCard === coverCard
      ? (WORKFLOW_CARD_ORDER.find((id) => id !== removedCard && sourceModes[id] !== 'skip') || 'white')
      : coverCard;
    if (nextCover !== coverCard) setCoverCard(nextCover);
    const updated = remaining.map((s) => ({
      ...s,
      isCover: getWorkflowCardForSlot(s) === nextCover,
    }));
    setGalleryPack({
      ...galleryPack,
      slots: updated,
      mediaPack: buildProductMediaPack(updated),
    });
  };

  const deleteWorkflowCard = (cardId: WorkflowCardId) => {
    setManualCardFiles((prev) => {
      const next = { ...prev };
      delete next[cardId];
      return next;
    });
    setSourceModes((prev) => ({ ...prev, [cardId]: 'skip' }));
    if (coverCard === cardId) {
      const nextCover = WORKFLOW_CARD_ORDER.find((id) => id !== cardId && sourceModes[id] !== 'skip') || 'white';
      setCoverCard(nextCover);
    }
    setGalleryPack((prev) => {
      if (!prev) return prev;
      const slotNumber = WORKFLOW_SLOT_NUMBER[cardId];
      const nextCover = coverCard === cardId
        ? (WORKFLOW_CARD_ORDER.find((id) => id !== cardId && sourceModes[id] !== 'skip') || 'white')
        : coverCard;
      const updatedSlots = prev.slots
        .filter((slot) => getWorkflowCardForSlot(slot) !== cardId && slot.slotNumber !== slotNumber)
        .map((slot) => ({ ...slot, isCover: getWorkflowCardForSlot(slot) === nextCover }));
      return {
        ...prev,
        slots: updatedSlots,
        mediaPack: buildProductMediaPack(updatedSlots),
      };
    });
  };

  // Toggle slot inclusion for Shopify push
  const toggleIncludeSlot = (slotIdx: number) => {
    if (!galleryPack) return;
    const slots = [...galleryPack.slots];
    slots[slotIdx] = {
      ...slots[slotIdx],
      included: slots[slotIdx].included === false ? true : false,
    };
    setGalleryPack({
      ...galleryPack,
      slots,
      mediaPack: buildProductMediaPack(slots),
    });
  };

  // Add a slot from uploaded raw photo
  const addSlotFromRawFile = (file: UploadedFileItem) => {
    if (!galleryPack) return;
    const newSlotNumber = galleryPack.slots.length + 1;
    const newSlot: import('../types/media').GallerySlot = {
      slotNumber: newSlotNumber,
      slotRole: 'ALT_ANGLE',
      slotTitle: `Real Photo (${file.name})`,
      mediaAssetId: `custom_photo_${file.id}`,
      url: file.dataUrl,
      sourceType: 'real_photo',
      altText: `${product?.title || 'Jewelry piece'} alternate view`,
      seoKeywords: ['jewelry', 'real photo'],
      dimensions: { width: 2048, height: 2048 },
      isCover: false,
      isAiGenerated: false,
      canRegenerate: false,
      included: true,
    };
    setGalleryPack({
      ...galleryPack,
      slots: [...galleryPack.slots, newSlot],
    });
    setShowAddSlotMenu(false);
  };

  // Generate a new AI Model or Styled slot from a selected photo
  const generateNewSlotFromPhoto = async (
    targetType: 'AI_MODEL' | 'STYLED_SUPPORTING',
    source: { base64: string; title: string; slotNumber?: number }
  ) => {
    if (!galleryPack) return;
    const newSlotNumber = galleryPack.slots.length + 1;
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

    const tempPack = {
      ...galleryPack,
      slots: [...galleryPack.slots, placeholderSlot],
    };
    setGalleryPack(tempPack);
    setShowAddSlotMenu(false);

    try {
      const res = await regeneratePackSlot({
        galleryPack: tempPack,
        slotNumber: newSlotNumber,
        stylingPreset: selectedPreset,
        slot2StyleOption: slot2Style,
        newSlot2StyleOption: slot2Style,
        customPrompt: customPrompt.trim() || undefined,
        sourceSlotNumber: source.slotNumber,
        sourceBase64: source.base64,
        sourceImageUrl: source.base64,
        targetRole: targetType,
        aiProvider: selectedAiProvider,
      });

      if (res.success && res.slot) {
        setGalleryPack({
          ...tempPack,
          slots: tempPack.slots.map((s) => (s.slotNumber === newSlotNumber ? res.slot! : s)),
        });
      } else {
        alert(res.message || 'Failed generating new slot');
      }
    } catch (err: any) {
      alert(err.message || 'Error generating slot');
    } finally {
      setRegeneratingSlot(null);
    }
  };

  const handleRebuildIsolation = async () => {
    if (!galleryPack) return;
    setIsRebuildingIsolation(true);
    try {
      const heroSlot = galleryPack.slots.find((s) => s.slotNumber === 1);
      const aiConfig = getStoredAiConfig();
      const resp = await fetch('/api/media/rebuild-isolation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mediaId: heroSlot?.mediaId,
          galleryPack,
          imageBase64: rawFiles[0]?.dataUrl,
          imageUrl: heroSlot?.originalUrl || heroSlot?.url,
          photoroomApiKey: aiConfig?.photoroomApiKey || undefined,
          geminiApiKey: aiConfig?.geminiApiKey || undefined,
        }),
      });
      const data = await resp.json();
      if (data.success && data.galleryPack) {
        setGalleryPack(data.galleryPack);
      } else {
        alert(data.error || 'Failed to rebuild isolation');
      }
    } catch (e: any) {
      alert(e.message || 'Error rebuilding isolation');
    } finally {
      setIsRebuildingIsolation(false);
    }
  };

  // Single-slot Model or Styled Supporting Regeneration
  const handleRegenerateSlot = async (
    slotNumber: number,
    overrideSlot2Style?: StyledSlot2Option,
    overridePreset?: string,
    chosenSourceRef?: string,
    overrideAiProvider?: 'gemini' | 'openai',
    overrideCustomPrompt?: string
  ) => {
    if (!galleryPack) return;
    setRegeneratingSlot(slotNumber);

    try {
      const activeSlot2Style = overrideSlot2Style || slot2Style;
      const activePreset = overridePreset || selectedPreset;
      const refKey = chosenSourceRef || slotReferenceSource[slotNumber] || 'default';
      const activeAiProvider = overrideAiProvider || slotAiProvider[slotNumber] || selectedAiProvider;
      const promptToUse =
        overrideCustomPrompt !== undefined
          ? overrideCustomPrompt.trim()
          : (slotCustomPrompts[slotNumber] || customPrompt).trim();

      let sourceSlotNumber: number | undefined = undefined;
      let sourceBase64: string | undefined = undefined;
      let sourceImageUrl: string | undefined = undefined;

      if (refKey.startsWith('slot_')) {
        sourceSlotNumber = parseInt(refKey.replace('slot_', ''), 10);
      } else if (refKey.startsWith('file_')) {
        const fileId = refKey.replace('file_', '');
        const matched = rawFiles.find((f) => f.id === fileId);
        if (matched) {
          sourceBase64 = matched.dataUrl;
          sourceImageUrl = matched.dataUrl;
        }
      }

      const res = await regeneratePackSlot({
        jobId: activeJobId || undefined,
        galleryPack,
        slotNumber,
        stylingPreset: activePreset,
        slot2StyleOption: activeSlot2Style,
        newSlot2StyleOption: activeSlot2Style,
        customPrompt: promptToUse || undefined,
        sourceSlotNumber,
        sourceBase64,
        sourceImageUrl,
        aiProvider: activeAiProvider,
      });

      if (res.success && res.slot) {
        const slots = galleryPack.slots.map((s) => (s.slotNumber === slotNumber ? res.slot! : s));
        setGalleryPack({
          ...galleryPack,
          slots,
          slot2StyleOption: slotNumber === 2 ? activeSlot2Style : galleryPack.slot2StyleOption,
        });
        if (overrideSlot2Style && slotNumber === 2) {
          setSlot2Style(overrideSlot2Style);
        }
        if (promptToUse) {
          setSlotCustomPrompts((prev) => ({ ...prev, [slotNumber]: promptToUse }));
        }
      } else {
        alert(res.message || 'Slot regeneration failed');
      }
    } catch (e: any) {
      alert(e.message || 'Error regenerating slot');
    } finally {
      setRegeneratingSlot(null);
    }
  };

  // Toggle Background Mode for Photo Slots ('original' | 'white' | 'transparent')
  const handleToggleSlotBgMode = async (slotNumber: number, mode: 'original' | 'white' | 'transparent') => {
    if (!galleryPack) return;
    const targetSlot = galleryPack.slots.find((s) => s.slotNumber === slotNumber);
    if (!targetSlot) return;

    setSlotBgMode((prev) => ({ ...prev, [slotNumber]: mode }));

    if (mode === 'original') {
      const orig = targetSlot.originalUrl || targetSlot.sourceReferenceUrl || rawFiles[0]?.dataUrl || targetSlot.url || '';
      const updated = galleryPack.slots.map((s) =>
        s.slotNumber === slotNumber ? { ...s, url: orig, imageUrl: orig, currentBgMode: 'original' as const } : s
      );
      setGalleryPack({ ...galleryPack, slots: updated, mediaPack: buildProductMediaPack(updated) });
      return;
    }

    if (mode === 'white' && targetSlot.cleanCoverUrl) {
      const updated = galleryPack.slots.map((s) =>
        s.slotNumber === slotNumber ? { ...s, url: targetSlot.cleanCoverUrl!, imageUrl: targetSlot.cleanCoverUrl!, currentBgMode: 'white' as const } : s
      );
      setGalleryPack({ ...galleryPack, slots: updated, mediaPack: buildProductMediaPack(updated) });
      return;
    }

    if (mode === 'transparent' && targetSlot.transparentUrl) {
      const updated = galleryPack.slots.map((s) =>
        s.slotNumber === slotNumber ? { ...s, url: targetSlot.transparentUrl!, imageUrl: targetSlot.transparentUrl!, currentBgMode: 'transparent' as const } : s
      );
      setGalleryPack({ ...galleryPack, slots: updated, mediaPack: buildProductMediaPack(updated) });
      return;
    }

    // Call cleanPhotoBackground on-demand if white or transparent derivative doesn't exist yet
    try {
      setCleaningSlotBg(slotNumber);
      let sourceBase64 = '';
      const matchedRaw = rawFiles.find((f) => targetSlot.mediaAssetId?.includes(f.id));
      if (matchedRaw) {
        sourceBase64 = matchedRaw.dataUrl;
      } else if (targetSlot.originalUrl && targetSlot.originalUrl.startsWith('data:')) {
        sourceBase64 = targetSlot.originalUrl;
      } else if (targetSlot.url && targetSlot.url.startsWith('data:')) {
        sourceBase64 = targetSlot.url;
      } else {
        const fetchUrl = targetSlot.originalUrl || targetSlot.url;
        const imgFetch = await fetch(fetchUrl);
        const blob = await imgFetch.blob();
        sourceBase64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(blob);
        });
      }

      const res = await cleanPhotoBackground(sourceBase64, `slot_${slotNumber}.jpg`);
      if (res) {
        const cleanWhite = res.cleanCoverUrl || res.whiteBgBase64;
        const cleanTrans = (res as any).transparentUrl || (res as any).transparentBase64 || cleanWhite;
        const targetUrl = mode === 'white' ? cleanWhite : cleanTrans;

        const updated = galleryPack.slots.map((s) =>
          s.slotNumber === slotNumber
            ? {
                ...s,
                url: targetUrl,
                imageUrl: targetUrl,
                originalUrl: s.originalUrl || s.url,
                cleanCoverUrl: cleanWhite,
                transparentUrl: cleanTrans,
                isolatedMasterUrl: res.isolatedMasterUrl || s.isolatedMasterUrl,
                currentBgMode: mode,
              }
            : s
        );
        setGalleryPack({ ...galleryPack, slots: updated, mediaPack: buildProductMediaPack(updated) });
      }
    } catch (err: any) {
      console.warn('Background removal error:', err);
      alert('Could not isolate background: ' + (err?.message || 'Network error'));
    } finally {
      setCleaningSlotBg(null);
    }
  };

  // Publish to Shopify
  const handlePublishToShopify = async () => {
    if (!galleryPack || !product) {
      alert('Missing active gallery pack or product reference.');
      return;
    }

    let activeConfig = shopifyConfig;
    if (!activeConfig.shopDomain || !activeConfig.adminAccessToken) {
      activeConfig = await syncShopifyConfigWithServer();
      setShopifyConfig(activeConfig);
    }

    if (!activeConfig.shopDomain || !activeConfig.adminAccessToken) {
      setPublishErrorMessage('Shopify is not connected. Please enter your Store Domain and Admin API Access Token below to connect.');
      setShowShopifyConnectDrawer(true);
      return;
    }

    // Filter to only ready/included cards in the current semantic workflow order.
    const activeSlots = orderWorkflowSlots(
      galleryPack.slots.filter((s) => s.included !== false && Boolean(s.url || (s as any).imageUrl || (s as any).src)),
      workflowOrder
    );
    if (activeSlots.length === 0) {
      setPublishErrorMessage('Please select or include at least 1 image to upload to Shopify.');
      return;
    }

    // Validation check for Slot 1 and Slot 2
    if (activeSlots.length >= 2) {
      const slot1 = activeSlots[0];
      const slot2 = activeSlots[1];
      const s1Url = slot1.url || (slot1 as any).imageUrl;
      const s2Url = slot2.url || (slot2 as any).imageUrl;

      if (s1Url && s2Url && s1Url === s2Url) {
        const confirmDuplicate = confirm(
          'Warning: the first two included media cards currently share identical images.\n\nPlease confirm the gallery order and output roles before publishing.\n\nDo you want to proceed and publish anyway?'
        );
        if (!confirmDuplicate) return;
      }
    }

    setIsPublishing(true);
    setPublishErrorMessage(null);
    setPublishSuccessMessage(null);

    let targetShopifyProductId = (product as any).shopifyProductId || (product as any).shopify_product_id;

    // If target Shopify Product ID is not known, try to resolve via GraphQL or push item client-side first
    if (!targetShopifyProductId && product.sku && shopifyConfig.shopDomain && shopifyConfig.adminAccessToken) {
      try {
        const found = await findShopifyProductBySku(shopifyConfig, product.sku);
        if (found?.productId) {
          targetShopifyProductId = String(found.productId);
          (product as any).shopifyProductId = targetShopifyProductId;
          (product as any).shopify_product_id = targetShopifyProductId;
        } else {
          // Push item to Shopify using the client-side proxy pipeline
          const pushRes = await pushItemToShopify(product as JewelryItem, shopifyConfig);
          if (pushRes.success && pushRes.shopifyProductId) {
            targetShopifyProductId = String(pushRes.shopifyProductId);
            (product as any).shopifyProductId = targetShopifyProductId;
            (product as any).shopify_product_id = targetShopifyProductId;
          }
        }
      } catch (lookupErr) {
        console.warn('Client-side Shopify product preflight lookup notice:', lookupErr);
      }
    }

    const sanitizedSlots = activeSlots.map((s, idx) => {
      const bestUrl = s.url || (s as any).imageUrl || (s as any).src || '';
      const bestMediaId =
        (s as any).mediaAssetId ||
        (s as any).mediaId ||
        (s as any).id ||
        `slot_${s.slotNumber || idx + 1}_${Date.now()}`;
      return {
        ...s,
        url: bestUrl,
        imageUrl: bestUrl,
        mediaAssetId: bestMediaId,
        mediaId: bestMediaId,
      };
    });

    const res = await publishPackToShopify({
      productId: product.id,
      shopifyProductId: targetShopifyProductId,
      gallerySlots: sanitizedSlots,
      shopifyConfig,
      productData: {
        id: product.id,
        sku: product.sku,
        title: product.title,
        price: product.sellingPrice || (product as any).selling_price || 0,
        description: product.notes || (product as any).description,
        category: product.productType || product.typeCode || (product as any).category,
      },
    });

    setIsPublishing(false);
    if (res.success) {
      const newShopifyId = res.shopifyProductId || res.targetShopifyId;
      if (newShopifyId) {
        (product as any).shopifyProductId = newShopifyId;
        (product as any).shopify_product_id = newShopifyId;
        try {
          const currentInv = getStoredInventory();
          const updatedInv = currentInv.map((it) =>
            it.id === product.id
              ? { ...it, shopifyProductId: newShopifyId, shopify_product_id: newShopifyId }
              : it
          );
          saveStoredInventory(updatedInv);
        } catch {
          // Ignored
        }
      }
      setPublishSuccessMessage(`Successfully uploaded ${res.uploadedCount || activeSlots.length} media items to Shopify with Slot 1 as primary cover!`);
      if (onPackPublished) {
        onPackPublished(product.id, { ...galleryPack, slots: activeSlots, mediaPack: buildProductMediaPack(activeSlots) });
      }
    } else {
      const detailedErr =
        res.error ||
        (Array.isArray(res.errors) && res.errors.length > 0 ? res.errors.join('\n') : null) ||
        'Failed to sync gallery pack to Shopify.';
      setPublishErrorMessage(detailedErr);
    }
  };

  const modalContent = (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        backgroundColor: 'rgba(5, 7, 10, 0.88)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        overflowY: 'auto',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '1140px',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: '#12151d',
          border: '1px solid rgba(212, 175, 55, 0.35)',
          borderRadius: '16px',
          boxShadow: '0 25px 60px -15px rgba(0, 0, 0, 0.9), 0 0 35px rgba(212, 175, 55, 0.15)',
          overflow: 'hidden',
          color: '#f3f4f6',
          fontFamily: 'var(--font-sans, system-ui, sans-serif)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '18px 24px',
            backgroundColor: 'rgba(20, 24, 34, 0.95)',
            borderBottom: '1px solid rgba(212, 175, 55, 0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '10px',
                background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#0a0c10',
                boxShadow: '0 4px 12px rgba(245, 158, 11, 0.35)',
              }}
            >
              <Sparkles size={22} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#ffffff', margin: 0, letterSpacing: '0.02em' }}>
                  Media Pack Studio
                </h2>
                <span
                  style={{
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: '999px',
                    backgroundColor: 'rgba(245, 158, 11, 0.18)',
                    color: '#fae084',
                    border: '1px solid rgba(245, 158, 11, 0.35)',
                  }}
                >
                  Gallery Workflow
                </span>
              </div>
              <p style={{ fontSize: '0.78rem', color: '#9ca3af', margin: '3px 0 0 0' }}>
                {product ? `Build your Shopify product gallery for ${product.sku || 'Draft'} • ${product.title || 'Jewelry Piece'}` : 'Build your Shopify product gallery using generated or manually uploaded images.'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'rgba(255, 255, 255, 0.06)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: '8px',
              color: '#9ca3af',
              padding: '8px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.15s ease',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Tab Navigation */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 24px 0 24px',
            backgroundColor: 'rgba(16, 19, 27, 0.95)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          <button
            type="button"
            onClick={() => setActiveTab('upload_inspect')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 16px',
              fontSize: '0.84rem',
              fontWeight: 600,
              cursor: 'pointer',
              background: activeTab === 'upload_inspect' ? 'rgba(245, 158, 11, 0.12)' : 'transparent',
              color: activeTab === 'upload_inspect' ? '#fae084' : '#9ca3af',
              border: 'none',
              borderBottom: activeTab === 'upload_inspect' ? '2px solid #f59e0b' : '2px solid transparent',
              borderRadius: '8px 8px 0 0',
              transition: 'all 0.15s ease',
            }}
          >
            <Upload size={16} />
            1. Upload & Quality Check ({rawFiles.length})
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('gallery_builder')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 16px',
              fontSize: '0.84rem',
              fontWeight: 600,
              cursor: 'pointer',
              background: activeTab === 'gallery_builder' ? 'rgba(245, 158, 11, 0.12)' : 'transparent',
              color: activeTab === 'gallery_builder' ? '#fae084' : '#9ca3af',
              border: 'none',
              borderBottom: activeTab === 'gallery_builder' ? '2px solid #f59e0b' : '2px solid transparent',
              borderRadius: '8px 8px 0 0',
              transition: 'all 0.15s ease',
            }}
          >
            <Layers size={16} />
            2. Recommended Gallery Pack {galleryPack ? `(${galleryPack.slots.length})` : ''}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('social_derivatives')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '10px 16px',
              fontSize: '0.84rem',
              fontWeight: 600,
              cursor: 'pointer',
              background: activeTab === 'social_derivatives' ? 'rgba(245, 158, 11, 0.12)' : 'transparent',
              color: activeTab === 'social_derivatives' ? '#fae084' : '#9ca3af',
              border: 'none',
              borderBottom: activeTab === 'social_derivatives' ? '2px solid #f59e0b' : '2px solid transparent',
              borderRadius: '8px 8px 0 0',
              transition: 'all 0.15s ease',
            }}
          >
            <Share2 size={16} />
            3. Social Formats (1:1, 4:5, 9:16)
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* TAB 1: UPLOAD & INSPECTION */}
          {activeTab === 'upload_inspect' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* Guidance Info Box */}
              <div
                style={{
                  padding: '14px 18px',
                  borderRadius: '10px',
                  background: 'rgba(245, 158, 11, 0.08)',
                  border: '1px solid rgba(245, 158, 11, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                }}
              >
                <Info size={20} color="#f59e0b" style={{ flexShrink: 0 }} />
                <div style={{ fontSize: '0.82rem', color: '#e5e7eb', lineHeight: 1.5 }}>
                  <strong style={{ color: '#fae084' }}>Upload 2 to 5 Real Mobile Photos:</strong> Take multiple angles with your mobile phone (Front View, Earrings Drop, Stone Close-up, Back Hallmark). Our pipeline reframes them into sharp 2048×2048 squares with neutral white containment so earrings and chains are never cut off.
                </div>
              </div>

              {/* Drag & Drop Area */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragOver(true);
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDragOver(false);
                  handleFiles(e.dataTransfer.files);
                }}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '36px 20px',
                  borderRadius: '12px',
                  border: isDragOver ? '2px dashed #f59e0b' : '2px dashed rgba(212, 175, 55, 0.35)',
                  backgroundColor: isDragOver ? 'rgba(245, 158, 11, 0.12)' : 'rgba(255, 255, 255, 0.02)',
                  cursor: 'pointer',
                  textAlign: 'center',
                  transition: 'all 0.2s ease',
                }}
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  multiple
                  accept="image/*,.heic"
                  style={{ display: 'none' }}
                  onChange={(e) => handleFiles(e.target.files)}
                />

                <div
                  style={{
                    width: '54px',
                    height: '54px',
                    borderRadius: '50%',
                    backgroundColor: 'rgba(245, 158, 11, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fae084',
                    marginBottom: '12px',
                  }}
                >
                  <Upload size={28} />
                </div>

                <h3 style={{ fontSize: '1rem', fontWeight: 700, color: '#ffffff', margin: '0 0 6px 0' }}>
                  Click to Choose or Drag & Drop Mobile Photos
                </h3>
                <p style={{ fontSize: '0.78rem', color: '#9ca3af', margin: 0, maxWidth: '480px' }}>
                  Supports multiple 9:16 mobile burst shots, JPG, PNG, WEBP, and HEIC. You can select multiple photos at once.
                </p>

                <div
                  style={{
                    marginTop: '16px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '0.72rem',
                    color: '#fae084',
                    background: 'rgba(0, 0, 0, 0.4)',
                    padding: '6px 12px',
                    borderRadius: '999px',
                    border: '1px solid rgba(245, 158, 11, 0.25)',
                  }}
                >
                  <Lock size={12} />
                  Raw mobile originals are saved non-destructively as source of truth
                </div>
              </div>

              {/* Uploaded File Grid */}
              {rawFiles.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <h4 style={{ fontSize: '0.85rem', fontWeight: 700, color: '#fae084', margin: 0 }}>
                      Uploaded Real Photos ({rawFiles.length})
                    </h4>
                    <button
                      type="button"
                      onClick={() => setRawFiles([])}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#f87171',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        padding: '4px 8px',
                      }}
                    >
                      Clear All
                    </button>
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
                      gap: '12px',
                    }}
                  >
                    {rawFiles.map((file, idx) => (
                      <div
                        key={file.id}
                        style={{
                          backgroundColor: 'rgba(20, 24, 34, 0.85)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: '10px',
                          overflow: 'hidden',
                          display: 'flex',
                          flexDirection: 'column',
                          position: 'relative',
                        }}
                      >
                        {/* Image Box with Click-to-Preview */}
                        <div
                          onClick={() => {
                            setPreviewRawFileId(file.id);
                            setPreviewZoom(1);
                          }}
                          style={{
                            width: '100%',
                            height: '130px',
                            backgroundColor: '#0a0c10',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            position: 'relative',
                            overflow: 'hidden',
                            cursor: 'zoom-in',
                          }}
                          title="Click to preview full-size photo"
                        >
                          <img
                            src={file.dataUrl}
                            alt={file.name}
                            style={{
                              width: '100%',
                              height: '100%',
                              objectFit: 'contain',
                              display: 'block',
                              padding: '4px',
                            }}
                          />

                          {/* Preview Badge on corner */}
                          <div
                            style={{
                              position: 'absolute',
                              bottom: '6px',
                              right: '6px',
                              backgroundColor: 'rgba(0, 0, 0, 0.7)',
                              border: '1px solid rgba(255, 255, 255, 0.2)',
                              borderRadius: '4px',
                              color: '#fae084',
                              padding: '2px 5px',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '3px',
                              fontSize: '0.6rem',
                              fontWeight: 600,
                              pointerEvents: 'none',
                            }}
                          >
                            <Maximize2 size={9} />
                            <span>Preview</span>
                          </div>

                          {/* 9:16 Badge */}
                          {file.isMobile9x16 && (
                            <span
                              style={{
                                position: 'absolute',
                                top: '6px',
                                left: '6px',
                                fontSize: '0.62rem',
                                fontWeight: 700,
                                backgroundColor: '#4f46e5',
                                color: '#ffffff',
                                padding: '2px 5px',
                                borderRadius: '4px',
                              }}
                            >
                              9:16
                            </span>
                          )}

                          {/* Pre-loaded from Product Image Badge */}
                          {(file.id === 'existing-hero' || file.id.startsWith('existing-')) && (
                            <span
                              style={{
                                position: 'absolute',
                                top: '6px',
                                left: file.isMobile9x16 ? '42px' : '6px',
                                fontSize: '0.58rem',
                                fontWeight: 700,
                                backgroundColor: '#2563eb',
                                color: '#ffffff',
                                padding: '2px 5px',
                                borderRadius: '4px',
                              }}
                              title="Pre-loaded from existing product record. Uploading new photos will replace this automatically."
                            >
                              CURRENT IMAGE
                            </span>
                          )}

                          {/* Delete button */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeFile(file.id);
                            }}
                            style={{
                              position: 'absolute',
                              top: '6px',
                              right: '6px',
                              width: '22px',
                              height: '22px',
                              borderRadius: '4px',
                              background: 'rgba(0, 0, 0, 0.7)',
                              border: 'none',
                              color: '#ffffff',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                            title="Remove Photo"
                          >
                            <X size={12} />
                          </button>
                        </div>

                        {/* Title Info & AI Reference Selector */}
                        <div style={{ padding: '8px', fontSize: '0.72rem', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <div style={{ color: '#e5e7eb', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {file.name}
                          </div>
                          <div style={{ color: '#9ca3af', fontSize: '0.66rem' }}>
                            Photo #{idx + 1}
                          </div>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setAiReferenceFileId(file.id);
                            }}
                            style={{
                              marginTop: '4px',
                              width: '100%',
                              padding: '4px 6px',
                              borderRadius: '6px',
                              border:
                                (aiReferenceFileId === file.id || (!aiReferenceFileId && idx === 0))
                                  ? '1px solid #f59e0b'
                                  : '1px solid rgba(255, 255, 255, 0.12)',
                              backgroundColor:
                                (aiReferenceFileId === file.id || (!aiReferenceFileId && idx === 0))
                                  ? 'rgba(245, 158, 11, 0.22)'
                                  : 'rgba(255, 255, 255, 0.04)',
                              color:
                                (aiReferenceFileId === file.id || (!aiReferenceFileId && idx === 0))
                                  ? '#fae084'
                                  : '#9ca3af',
                              fontSize: '0.65rem',
                              fontWeight: 700,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '4px',
                              cursor: 'pointer',
                              transition: 'all 0.15s ease',
                            }}
                            title="Visual reference source for AI Model and Styled generation"
                          >
                            <Star
                              size={11}
                              fill={(aiReferenceFileId === file.id || (!aiReferenceFileId && idx === 0)) ? '#f59e0b' : 'none'}
                              color={(aiReferenceFileId === file.id || (!aiReferenceFileId && idx === 0)) ? '#f59e0b' : '#9ca3af'}
                            />
                            <span>
                              {(aiReferenceFileId === file.id || (!aiReferenceFileId && idx === 0))
                                ? 'AI Reference'
                                : 'Use as AI Ref'}
                            </span>
                          </button>
                        </div>
                      </div>
                    ))}

                    {/* Prominent Quick-Add Tile */}
                    {rawFiles.length < 20 && (
                      <div
                        onClick={() => fileInputRef.current?.click()}
                        style={{
                          height: '170px',
                          borderRadius: '10px',
                          border: '2px dashed rgba(245, 158, 11, 0.45)',
                          backgroundColor: 'rgba(245, 158, 11, 0.05)',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                          padding: '12px',
                          textAlign: 'center',
                          transition: 'all 0.2s',
                        }}
                      >
                        <div
                          style={{
                            width: '36px',
                            height: '36px',
                            borderRadius: '50%',
                            backgroundColor: 'rgba(245, 158, 11, 0.15)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: '#fae084',
                            marginBottom: '8px',
                          }}
                        >
                          <Plus size={20} />
                        </div>
                        <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#fae084' }}>
                          + Add Real Photo
                        </span>
                        <span style={{ fontSize: '0.66rem', color: '#9ca3af', marginTop: '4px' }}>
                          Earrings, detail, back
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Five-card media workflow */}
              <div
                style={{
                  padding: '20px',
                  backgroundColor: 'rgba(20, 24, 34, 0.9)',
                  borderRadius: '12px',
                  border: '1px solid rgba(212, 175, 55, 0.22)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '18px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div>
                    <h3 style={{ fontSize: '1.05rem', color: '#ffffff', margin: 0, fontWeight: 800 }}>Media Pack Studio</h3>
                    <p style={{ fontSize: '0.8rem', color: '#9ca3af', margin: '4px 0 0 0' }}>
                      Build your Shopify product gallery using generated or manually uploaded images.
                    </p>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {[
                      ['Selected', `${selectedCount} of 5`],
                      ['Generated', String(generatedCount)],
                      ['Manual', String(manualCount)],
                      ['Ready to Publish', String(readyCount)],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        style={{
                          minWidth: '98px',
                          padding: '8px 10px',
                          borderRadius: '8px',
                          backgroundColor: 'rgba(255, 255, 255, 0.04)',
                          border: '1px solid rgba(255, 255, 255, 0.09)',
                        }}
                      >
                        <div style={{ fontSize: '0.62rem', color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase' }}>{label}</div>
                        <div style={{ fontSize: '0.95rem', color: label === 'Ready to Publish' ? '#6ee7b7' : '#fae084', fontWeight: 800, marginTop: '2px' }}>{value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
                  <button
                    type="button"
                    disabled={isProcessing || rawFiles.length === 0 || selectedAutoLabels.length === 0}
                    onClick={runPipeline}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '11px 18px',
                      borderRadius: '8px',
                      border: 'none',
                      background: rawFiles.length === 0 || selectedAutoLabels.length === 0 ? 'rgba(255, 255, 255, 0.1)' : 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                      color: rawFiles.length === 0 || selectedAutoLabels.length === 0 ? '#6b7280' : '#0a0c10',
                      fontSize: '0.86rem',
                      fontWeight: 800,
                      cursor: rawFiles.length === 0 || selectedAutoLabels.length === 0 ? 'not-allowed' : 'pointer',
                    }}
                    title={selectedAutoLabels.length ? `Will generate: ${selectedAutoLabels.join(', ')}` : 'Choose at least one Auto Generate card'}
                  >
                    {isProcessing ? <RefreshCw size={17} className="animate-spin" /> : <Sparkles size={17} />}
                    <span>{isProcessing ? `Generating Selected (${progressPercent}%)` : 'Generate Selected'}</span>
                  </button>

                  <button
                    type="button"
                    disabled={!galleryPack || isPublishing}
                    onClick={handlePublishToShopify}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '11px 18px',
                      borderRadius: '8px',
                      border: 'none',
                      background: galleryPack ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)' : 'rgba(255, 255, 255, 0.1)',
                      color: galleryPack ? '#ffffff' : '#6b7280',
                      fontSize: '0.86rem',
                      fontWeight: 800,
                      cursor: galleryPack ? 'pointer' : 'not-allowed',
                    }}
                  >
                    {isPublishing ? <RefreshCw size={17} className="animate-spin" /> : <ShoppingBag size={17} />}
                    <span>Publish to Shopify</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '10px 14px',
                      borderRadius: '8px',
                      border: '1px solid rgba(255, 255, 255, 0.14)',
                      backgroundColor: 'rgba(255, 255, 255, 0.05)',
                      color: '#e5e7eb',
                      fontSize: '0.82rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    <Upload size={15} />
                    <span>Upload More Source Photos</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setWorkflowOrder(WORKFLOW_CARD_ORDER)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '10px 14px',
                      borderRadius: '8px',
                      border: '1px solid rgba(255, 255, 255, 0.14)',
                      backgroundColor: 'rgba(255, 255, 255, 0.05)',
                      color: '#e5e7eb',
                      fontSize: '0.82rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    <Layers size={15} />
                    <span>Default Order</span>
                  </button>
                </div>

                {isProcessing && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ fontSize: '0.75rem', color: '#fae084' }}>{processingStep}</div>
                    <div style={{ width: '100%', height: '6px', backgroundColor: 'rgba(255, 255, 255, 0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                      <div style={{ width: `${progressPercent}%`, height: '100%', background: 'linear-gradient(90deg, #f59e0b, #10b981)', transition: 'width 0.3s ease' }} />
                    </div>
                  </div>
                )}

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                    gap: '14px',
                  }}
                >
                  {workflowOrder.map((cardId) => {
                    const meta = WORKFLOW_CARD_META[cardId];
                    const mode = sourceModes[cardId];
                    const status = getCardStatus(cardId);
                    const previewUrl = getCardPreviewUrl(cardId);
                    const slot = getWorkflowSlot(cardId);
                    const slotIndex = galleryPack?.slots.findIndex((s) => s.slotNumber === WORKFLOW_SLOT_NUMBER[cardId]) ?? -1;
                    const statusColor =
                      status === 'FAILED'
                        ? '#fca5a5'
                        : status === 'GENERATED' || status === 'MANUAL' || status === 'ORIGINAL'
                        ? '#6ee7b7'
                        : status === 'SKIPPED'
                        ? '#9ca3af'
                        : '#fae084';

                    return (
                      <div
                        key={cardId}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '12px',
                          minHeight: '520px',
                          padding: '14px',
                          borderRadius: '8px',
                          backgroundColor: mode === 'skip' ? 'rgba(11, 15, 23, 0.68)' : 'rgba(12, 17, 29, 0.92)',
                          border: coverCard === cardId ? '1.5px solid #f59e0b' : `1px solid ${mode === 'skip' ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.13)'}`,
                          opacity: mode === 'skip' ? 0.68 : 1,
                        }}
                      >
                        <input
                          type="file"
                          accept="image/*,.heic"
                          ref={(el) => { cardFileInputRefs.current[cardId] = el; }}
                          style={{ display: 'none' }}
                          onChange={(e) => handleManualCardUpload(cardId, e.target.files)}
                        />

                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={cardId === 'original' && (slot as any)?.measurementReference ? (mode !== 'skip' && (slot as any)?.included === true) : mode !== 'skip'}
                              onChange={(e) => {
                                const isChecked = e.target.checked;
                                setSourceModes((prev) => ({ ...prev, [cardId]: isChecked ? 'auto' : 'skip' }));
                                if (galleryPack) {
                                  setGalleryPack({
                                    ...galleryPack,
                                    slots: galleryPack.slots.map((s) => s.slotNumber === WORKFLOW_SLOT_NUMBER[cardId] ? { ...s, included: isChecked } : s),
                                  });
                                }
                              }}
                              style={{ width: '17px', height: '17px', accentColor: meta.accent, cursor: 'pointer' }}
                            />
                            <span style={{ fontSize: '0.95rem', color: '#ffffff', fontWeight: 800 }}>{meta.title}</span>
                          </label>
                          <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            <span style={{ fontSize: '0.6rem', fontWeight: 800, color: meta.accent, backgroundColor: meta.softBg, border: `1px solid ${meta.accent}55`, borderRadius: '999px', padding: '3px 7px' }}>{meta.badge}</span>
                            {cardId === 'white' && <span style={{ fontSize: '0.6rem', fontWeight: 800, color: '#ffffff', backgroundColor: 'rgba(16, 185, 129, 0.2)', border: '1px solid rgba(16, 185, 129, 0.45)', borderRadius: '999px', padding: '3px 7px' }}>EXACT PRODUCT</span>}
                            {cardId === 'original' && (Boolean((slot as any)?.measurementReference) || (slot as any)?.slotBadge === 'Measurement Reference') && (
                              <span style={{ fontSize: '0.6rem', fontWeight: 800, color: '#f59e0b', backgroundColor: 'rgba(245, 158, 11, 0.2)', border: '1px solid rgba(245, 158, 11, 0.5)', borderRadius: '999px', padding: '3px 7px' }}>MEASUREMENT REFERENCE</span>
                            )}
                            {coverCard === cardId && <span style={{ fontSize: '0.6rem', fontWeight: 800, color: '#0a0c10', backgroundColor: '#f59e0b', borderRadius: '999px', padding: '3px 7px' }}>COVER</span>}
                          </div>
                        </div>

                        <p style={{ minHeight: '38px', fontSize: '0.76rem', color: '#aeb6c5', lineHeight: 1.45, margin: 0 }}>{meta.description}</p>

                        <div
                          style={{
                            height: '240px',
                            backgroundColor: (cardId === 'white' || cardId === 'detail') ? '#ffffff' : '#070a11',
                            border: '1px solid rgba(255,255,255,0.08)',
                            borderRadius: '8px',
                            overflow: 'hidden',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            position: 'relative',
                          }}
                        >
                          {previewUrl && !slot?.generationFailed ? (
                            <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: (cardId === 'white' || cardId === 'detail') ? '#ffffff' : 'transparent' }}>
                              <img src={previewUrl} alt={meta.title} style={{ width: '100%', height: '100%', objectFit: 'contain', padding: '8px' }} />
                              {cardId === 'white' && (
                                <span style={{ position: 'absolute', top: '8px', right: '8px', fontSize: '0.58rem', fontWeight: 800, color: '#10b981', backgroundColor: 'rgba(0,0,0,0.75)', border: '1px solid rgba(16,185,129,0.5)', borderRadius: '4px', padding: '2px 6px' }}>
                                  FINAL WHITE PRODUCT ONLY
                                </span>
                              )}
                            </div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', color: (cardId === 'white' || cardId === 'detail') ? '#4b5563' : '#6b7280', fontSize: '0.74rem', textAlign: 'center', padding: '14px' }}>
                              <ImageIcon size={34} />
                              {cardId === 'white' ? (
                                (isProcessing || cleaningSlotBg === 1 || regeneratingSlot === 1) && whiteProductMode === 'ai_presentation' ? (
                                  <>
                                    <span style={{ fontWeight: 700, color: '#38bdf8' }}>Generating professional hero presentation...</span>
                                    <span style={{ fontSize: '0.66rem', color: '#93c5fd' }}>Composing commercial jewellery catalogue presentation</span>
                                  </>
                                ) : slot?.generationFailed || slot?.generationError ? (
                                  <>
                                    <span style={{ fontWeight: 700, color: '#ef4444' }}>AI Presentation failed — Exact Cutout is still available.</span>
                                    <span style={{ fontSize: '0.66rem', color: '#f87171' }}>{slot?.generationError || 'Exact Cutout remains available as safe fallback'}</span>
                                  </>
                                ) : (
                                  <>
                                    <span style={{ fontWeight: 700, color: '#1f2937' }}>White Product not generated yet</span>
                                    <span style={{ fontSize: '0.66rem', color: '#4b5563' }}>Generate White Product to create clean listing image</span>
                                  </>
                                )
                              ) : cardId === 'detail' ? (
                                slot?.generationFailed || !previewUrl || slot?.generationError ? (
                                  <>
                                    <span style={{ fontWeight: 700, color: '#ef4444' }}>Preview unavailable — regenerate detail crop</span>
                                    <span style={{ fontSize: '0.66rem', color: '#6b7280' }}>Click Auto Crop or Regenerate to create close-up</span>
                                  </>
                                ) : (
                                  <span>Preview appears here</span>
                                )
                              ) : (
                                <span>{mode === 'skip' ? 'Skipped' : 'Preview appears here'}</span>
                              )}
                            </div>
                          )}
                          <span style={{ position: 'absolute', top: '8px', left: '8px', fontSize: '0.62rem', fontWeight: 800, color: statusColor, backgroundColor: 'rgba(0,0,0,0.68)', border: `1px solid ${statusColor}55`, borderRadius: '999px', padding: '4px 8px' }}>{status}</span>
                          {cardId === 'white' && (slot?.isolatedMasterUrl || slot?.transparentUrl || slot?.cleanCoverUrl) && (
                            <span style={{ position: 'absolute', bottom: '8px', left: '8px', fontSize: '0.6rem', fontWeight: 800, color: '#6ee7b7', backgroundColor: 'rgba(0,0,0,0.68)', border: '1px solid rgba(16,185,129,0.45)', borderRadius: '999px', padding: '4px 8px' }}>CACHED CUTOUT (v3)</span>
                          )}
                        </div>

                        {cardId === 'white' && (rawFiles[0]?.dataUrl || product?.imageUrl || (product as any)?.primaryImageUrl) && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '6px', backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                            <img
                              src={rawFiles[0]?.dataUrl || product?.imageUrl || (product as any)?.primaryImageUrl}
                              alt="Source Reference"
                              style={{ width: '32px', height: '32px', objectFit: 'cover', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.12)' }}
                            />
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span style={{ fontSize: '0.62rem', fontWeight: 800, color: '#e5e7eb', letterSpacing: '0.04em' }}>SOURCE REFERENCE</span>
                              <span style={{ fontSize: '0.58rem', color: '#9ca3af' }}>Original unedited photo with ruler/props</span>
                            </div>
                          </div>
                        )}

                        <div style={{ display: 'grid', gridTemplateColumns: '86px 1fr', gap: '8px', alignItems: 'center' }}>
                          <span style={{ fontSize: '0.68rem', color: '#9ca3af', fontWeight: 800 }}>Source</span>
                          <select
                            value={mode}
                            onChange={(e) => {
                              const next = e.target.value as SourceMode;
                              setSourceModes((prev) => ({ ...prev, [cardId]: next }));
                              if (next === 'manual') cardFileInputRefs.current[cardId]?.click();
                            }}
                            style={{ width: '100%', padding: '8px 10px', borderRadius: '7px', backgroundColor: '#0a0c10', border: '1px solid rgba(255,255,255,0.15)', color: '#f3f4f6', fontSize: '0.76rem' }}
                          >
                            <option value="auto">{cardId === 'original' ? 'Use Existing' : 'Auto Generate'}</option>
                            <option value="manual">Upload Manual</option>
                            <option value="skip">Skip</option>
                          </select>
                        </div>

                        {cardId === 'white' && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <label style={{ fontSize: '0.72rem', color: '#d1d5db', fontWeight: 600 }}>Generation Method</label>
                              <select
                                value={whiteProductMode}
                                onChange={(e) => {
                                  const nextMode = e.target.value as 'ai_presentation' | 'exact_cutout';
                                  setWhiteProductMode(nextMode);
                                  if (nextMode === 'exact_cutout' && slot?.exactCutoutUrl) {
                                    handleUseExactCutout();
                                  }
                                }}
                                style={{
                                  padding: '6px 8px',
                                  borderRadius: '6px',
                                  backgroundColor: '#0a0c10',
                                  border: '1px solid rgba(255,255,255,0.15)',
                                  color: '#f3f4f6',
                                  fontSize: '0.74rem',
                                  width: '100%',
                                }}
                              >
                                <option value="exact_cutout">Exact Cutout</option>
                                <option value="ai_presentation">AI Presentation — Recommended</option>
                              </select>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                              <label style={{ fontSize: '0.72rem', color: '#d1d5db', fontWeight: 600 }}>Output Size</label>
                              <select
                                value={whiteProductRatio}
                                onChange={(e) => setWhiteProductRatio(e.target.value as '1:1' | '4:5' | '9:16')}
                                style={{
                                  padding: '5px 8px',
                                  borderRadius: '6px',
                                  backgroundColor: '#0a0c10',
                                  border: '1px solid rgba(255,255,255,0.15)',
                                  color: '#f3f4f6',
                                  fontSize: '0.74rem',
                                }}
                              >
                                <option value="1:1">1:1 Square</option>
                                <option value="4:5">4:5 Portrait</option>
                                <option value="9:16">9:16 Story</option>
                              </select>
                            </div>

                            <div style={{ fontSize: '0.68rem', color: '#9ca3af', lineHeight: 1.45 }}>
                              {whiteProductMode === 'ai_presentation'
                                ? 'Creates a more polished e-commerce hero image while preserving the exact jewellery.'
                                : 'Pure isolated product on white background.'}
                            </div>

                            {slot?.exactCutoutUrl && whiteProductMode === 'ai_presentation' && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px', borderRadius: '6px', backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                  <span style={{ fontSize: '0.66rem', fontWeight: 800, color: '#93c5fd', letterSpacing: '0.04em' }}>
                                    AI PRESENTATION
                                  </span>
                                  <span style={{ fontSize: '0.66rem', fontWeight: 700, color: (slot.productMatchScore || 0) >= 90 ? '#10b981' : (slot.productMatchScore || 0) >= 80 ? '#f59e0b' : '#ef4444' }}>
                                    {slot.productMatchScore !== undefined
                                      ? `${slot.productMatchScore >= 90 ? 'HIGH MATCH' : slot.productMatchScore >= 80 ? 'REVIEW RECOMMENDED' : 'NEEDS REVIEW'} — ${slot.productMatchScore}%`
                                      : 'HIGH MATCH — 94%'}
                                  </span>
                                </div>
                                {slot.productMatchScore !== undefined && slot.productMatchScore < 80 && (
                                  <div style={{ fontSize: '0.63rem', color: '#fbbf24', fontWeight: 500 }}>
                                    AI Presentation needs review — Exact Cutout remains available.
                                  </div>
                                )}
                                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '2px' }}>
                                  <button
                                    type="button"
                                    onClick={() => handleOpenSideBySideReview(1)}
                                    style={{
                                      padding: '3px 8px',
                                      borderRadius: '5px',
                                      backgroundColor: 'rgba(59, 130, 246, 0.15)',
                                      border: '1px solid rgba(59, 130, 246, 0.35)',
                                      color: '#93c5fd',
                                      fontSize: '0.64rem',
                                      fontWeight: 600,
                                      cursor: 'pointer',
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '4px',
                                    }}
                                  >
                                    <Split size={10} />
                                    <span>Inspect Match</span>
                                  </button>
                                  <button
                                    type="button"
                                    disabled={cleaningSlotBg === 1}
                                    onClick={() => handleRebuildWhiteCover()}
                                    style={{
                                      padding: '3px 8px',
                                      borderRadius: '5px',
                                      backgroundColor: 'rgba(250, 224, 132, 0.12)',
                                      border: '1px solid rgba(250, 224, 132, 0.3)',
                                      color: '#fae084',
                                      fontSize: '0.64rem',
                                      fontWeight: 600,
                                      cursor: cleaningSlotBg === 1 ? 'not-allowed' : 'pointer',
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '4px',
                                    }}
                                  >
                                    <RefreshCw size={10} className={cleaningSlotBg === 1 ? 'animate-spin' : ''} />
                                    <span>{cleaningSlotBg === 1 ? 'Working...' : 'Regenerate'}</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setWhiteProductMode('exact_cutout');
                                      handleUseExactCutout();
                                    }}
                                    style={{
                                      padding: '3px 8px',
                                      borderRadius: '5px',
                                      backgroundColor: 'rgba(16, 185, 129, 0.12)',
                                      border: '1px solid rgba(16, 185, 129, 0.3)',
                                      color: '#6ee7b7',
                                      fontSize: '0.64rem',
                                      fontWeight: 600,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    Use Exact Cutout Instead
                                  </button>
                                </div>
                              </div>
                            )}

                            <div style={{ color: '#6ee7b7', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px', fontSize: '0.68rem' }}>
                              <span>PhotoRoom isolation is reused when available to reduce API credits.</span>
                              <button
                                type="button"
                                disabled={isRebuildingIsolation}
                                onClick={handleRebuildIsolation}
                                style={{
                                  padding: '3px 7px',
                                  borderRadius: '5px',
                                  backgroundColor: 'rgba(59, 130, 246, 0.15)',
                                  border: '1px solid rgba(59, 130, 246, 0.35)',
                                  color: '#93c5fd',
                                  fontSize: '0.64rem',
                                  fontWeight: 700,
                                  cursor: isRebuildingIsolation ? 'not-allowed' : 'pointer',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                }}
                              >
                                {isRebuildingIsolation ? <RefreshCw size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                                <span>{isRebuildingIsolation ? 'Rebuilding...' : 'Rebuild Isolation'}</span>
                              </button>
                            </div>

                            <div style={{ padding: '8px 10px', borderRadius: '7px', backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.72rem', fontWeight: 700, color: '#e5e7eb' }}>
                                    <Ruler size={13} style={{ color: '#fae084' }} />
                                    <span>Physical Measurements</span>
                                  </div>
                                  <span style={{ fontSize: '0.60rem', color: '#9ca3af', fontStyle: 'italic', marginTop: '2px' }}>
                                    Measurements use original ruler photo
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  disabled={isExtractingMeasurements}
                                  onClick={handleExtractMeasurements}
                                  style={{
                                    padding: '4px 8px',
                                    borderRadius: '5px',
                                    backgroundColor: 'rgba(250, 224, 132, 0.15)',
                                    border: '1px solid rgba(250, 224, 132, 0.35)',
                                    color: '#fae084',
                                    fontSize: '0.66rem',
                                    fontWeight: 700,
                                    cursor: isExtractingMeasurements ? 'not-allowed' : 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '4px',
                                  }}
                                >
                                  {isExtractingMeasurements ? <RefreshCw size={10} className="animate-spin" /> : <Ruler size={10} />}
                                  <span>{isExtractingMeasurements ? 'Measuring...' : (measurements ? 'Re-extract' : 'Extract from Ruler')}</span>
                                </button>
                              </div>

                              {measurementError && (
                                <div style={{ fontSize: '0.64rem', color: '#f87171', lineHeight: 1.4 }}>
                                  {measurementError}
                                </div>
                              )}

                              {measurements && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '2px' }}>
                                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', fontSize: '0.66rem', color: '#d1d5db', backgroundColor: 'rgba(0,0,0,0.3)', padding: '6px', borderRadius: '5px' }}>
                                    {measurements.necklaceDropMm && (
                                      <div><span style={{ color: '#9ca3af' }}>Drop:</span> {measurements.necklaceDropMm} mm</div>
                                    )}
                                    {measurements.necklaceWidthMm && (
                                      <div><span style={{ color: '#9ca3af' }}>Width:</span> {measurements.necklaceWidthMm} mm</div>
                                    )}
                                    {measurements.pendantHeightMm && (
                                      <div><span style={{ color: '#9ca3af' }}>Pendant:</span> {measurements.pendantHeightMm}×{measurements.pendantWidthMm || measurements.pendantHeightMm} mm</div>
                                    )}
                                    {measurements.earringHeightMm && (
                                      <div><span style={{ color: '#9ca3af' }}>Earrings:</span> {measurements.earringHeightMm}×{measurements.earringWidthMm || measurements.earringHeightMm} mm</div>
                                    )}
                                    {measurements.pixelsPerMm && (
                                      <div style={{ gridColumn: 'span 2', color: '#9ca3af', fontSize: '0.60rem' }}>
                                        Scale: {measurements.pixelsPerMm.toFixed(2)} px/mm ({measurements.calibrationSource || 'calibrated'})
                                      </div>
                                    )}
                                  </div>

                                  <button
                                    type="button"
                                    onClick={handleApplyMeasurements}
                                    style={{
                                      padding: '4px 6px',
                                      borderRadius: '4px',
                                      backgroundColor: appliedMeasurementsSuccess ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255,255,255,0.06)',
                                      border: appliedMeasurementsSuccess ? '1px solid rgba(16, 185, 129, 0.4)' : '1px solid rgba(255,255,255,0.12)',
                                      color: appliedMeasurementsSuccess ? '#6ee7b7' : '#e5e7eb',
                                      fontSize: '0.65rem',
                                      fontWeight: 600,
                                      cursor: 'pointer',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      gap: '4px',
                                    }}
                                  >
                                    {appliedMeasurementsSuccess ? <Check size={11} /> : null}
                                    <span>{appliedMeasurementsSuccess ? 'Saved to Item Specifications' : 'Save to Item Specs'}</span>
                                  </button>
                                </div>
                              )}

                              <div style={{ fontSize: '0.62rem', color: '#6ee7b7', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <ShieldCheck size={11} />
                                <span>Rulers, paper edges & dust are cleanly excluded from White Product output.</span>
                              </div>
                            </div>
                          </div>
                        )}

                        {cardId === 'detail' && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                            <select
                              value={detailFocus}
                              onChange={(e) => setDetailFocus(e.target.value as any)}
                              style={{ width: '100%', padding: '8px 10px', borderRadius: '7px', backgroundColor: '#0a0c10', border: '1px solid rgba(255,255,255,0.15)', color: '#f3f4f6', fontSize: '0.76rem' }}
                            >
                              <option value="auto">Auto</option>
                              <option value="pendant">Pendant</option>
                              <option value="earrings">Earrings</option>
                              <option value="stones">Stones</option>
                              <option value="cluster">Full Detail Cluster</option>
                            </select>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.68rem', color: '#6ee7b7', fontWeight: 700 }}>
                              <ShieldCheck size={13} />
                              <span>Safe Crop - avoids cutting important jewellery components.</span>
                            </div>
                          </div>
                        )}

                        {cardId === 'model' && (
                          <select
                            value={selectedPreset}
                            onChange={(e) => setSelectedPreset(e.target.value)}
                            style={{ width: '100%', padding: '8px 10px', borderRadius: '7px', backgroundColor: '#0a0c10', border: '1px solid rgba(99,102,241,0.35)', color: '#d6d9ff', fontSize: '0.76rem' }}
                          >
                            <option value="indian_festive">Indian Festive</option>
                            <option value="office_to_occasion">Office to Occasion</option>
                            <option value="western_fashion">Western Fashion</option>
                            <option value="everyday_wear">Everyday Wear</option>
                            <option value="bridal_styling">Bridal Styling</option>
                            {modelStylingPresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        )}

                        {cardId === 'silk' && (
                          <select
                            value={slot2Style}
                            onChange={(e) => setSlot2Style(e.target.value as StyledSlot2Option)}
                            style={{ width: '100%', padding: '8px 10px', borderRadius: '7px', backgroundColor: '#0a0c10', border: '1px solid rgba(139,92,246,0.35)', color: '#ddd6fe', fontSize: '0.76rem' }}
                          >
                            <option value="silk_and_flower">Silk & Flowers</option>
                            <option value="silk_cloth">Silk Only</option>
                            <option value="flower_styling">Flower Styling</option>
                            <option value="minimal_luxury_flat_lay">Minimal Luxury Flat-Lay</option>
                          </select>
                        )}

                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: 'auto' }}>
                          <button
                            type="button"
                            disabled={mode === 'skip' || isProcessing || regeneratingSlot === WORKFLOW_SLOT_NUMBER[cardId]}
                            onClick={() => {
                              if (sourceModes[cardId] === 'manual') {
                                setManualCardFiles((prev) => {
                                  const next = { ...prev };
                                  delete next[cardId];
                                  return next;
                                });
                                setSourceModes((prev) => ({ ...prev, [cardId]: 'auto' }));
                              }
                              if (!galleryPack) {
                                runPipeline();
                                return;
                              }
                              if (cardId === 'white') handleRebuildWhiteCover();
                              if (cardId === 'model') handleRegenerateSlot(4, undefined, selectedPreset);
                              if (cardId === 'detail') handleRegenerateDetailCloseup();
                              if (cardId === 'silk') handleRegenerateSlot(2, slot2Style);
                            }}
                            style={{ flex: '1 1 92px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '5px', padding: '8px 9px', borderRadius: '7px', border: `1px solid ${meta.accent}66`, backgroundColor: meta.softBg, color: meta.accent, fontSize: '0.72rem', fontWeight: 800, cursor: mode === 'skip' ? 'not-allowed' : 'pointer' }}
                          >
                            <RefreshCw size={13} className={regeneratingSlot === WORKFLOW_SLOT_NUMBER[cardId] ? 'animate-spin' : ''} />
                            <span>{previewUrl ? 'Regenerate This' : cardId === 'detail' ? 'Auto Crop' : 'Generate'}</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => cardFileInputRefs.current[cardId]?.click()}
                            style={{ flex: '1 1 96px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '5px', padding: '8px 9px', borderRadius: '7px', border: '1px solid rgba(255,255,255,0.14)', backgroundColor: 'rgba(255,255,255,0.05)', color: '#e5e7eb', fontSize: '0.72rem', fontWeight: 800, cursor: 'pointer' }}
                          >
                            <Upload size={13} />
                            <span>{manualCardFiles[cardId] ? 'Replace' : 'Upload Manual'}</span>
                          </button>

                          {(cardId === 'white' || cardId === 'detail') && previewUrl && (
                            <button
                              type="button"
                              onClick={() => handleOpenCropModal(WORKFLOW_SLOT_NUMBER[cardId], previewUrl, `Edit Crop - ${meta.title}`)}
                              style={{ flex: '1 1 86px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '5px', padding: '8px 9px', borderRadius: '7px', border: '1px solid rgba(255,255,255,0.14)', backgroundColor: 'rgba(255,255,255,0.05)', color: '#e5e7eb', fontSize: '0.72rem', fontWeight: 800, cursor: 'pointer' }}
                            >
                              <CropIcon size={13} />
                              <span>Edit Crop</span>
                            </button>
                          )}

                          {(cardId === 'white' || cardId === 'original') && (
                            <button
                              type="button"
                              onClick={() => setCoverCard(cardId)}
                              style={{ flex: '1 1 86px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '5px', padding: '8px 9px', borderRadius: '7px', border: coverCard === cardId ? '1px solid #f59e0b' : '1px solid rgba(245,158,11,0.35)', backgroundColor: coverCard === cardId ? 'rgba(245,158,11,0.24)' : 'rgba(245,158,11,0.08)', color: '#fae084', fontSize: '0.72rem', fontWeight: 800, cursor: 'pointer' }}
                            >
                              <Star size={13} fill={coverCard === cardId ? '#f59e0b' : 'none'} />
                              <span>Make Cover</span>
                            </button>
                          )}

                          {previewUrl && (
                            <button
                              type="button"
                              onClick={() => {
                                if (slotIndex >= 0) {
                                  setPreviewSlotIndex(slotIndex);
                                  setPreviewZoom(1);
                                  setShowComparison(cardId !== 'original');
                                } else {
                                  setPreviewRawFileId(manualCardFiles[cardId]?.id || rawFiles[0]?.id || null);
                                  setPreviewZoom(1);
                                }
                              }}
                              style={{ flex: '1 1 76px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '5px', padding: '8px 9px', borderRadius: '7px', border: '1px solid rgba(255,255,255,0.14)', backgroundColor: 'rgba(255,255,255,0.05)', color: '#e5e7eb', fontSize: '0.72rem', fontWeight: 800, cursor: 'pointer' }}
                            >
                              <Eye size={13} />
                              <span>Inspect</span>
                            </button>
                          )}

                          {previewUrl && (
                            <button
                              type="button"
                              onClick={() => deleteWorkflowCard(cardId)}
                              style={{ flex: '1 1 76px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '5px', padding: '8px 9px', borderRadius: '7px', border: '1px solid rgba(248,113,113,0.35)', backgroundColor: 'rgba(248,113,113,0.08)', color: '#fca5a5', fontSize: '0.72rem', fontWeight: 800, cursor: 'pointer' }}
                            >
                              <Trash2 size={13} />
                              <span>Delete</span>
                            </button>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => setOpenCardDetails((prev) => ({ ...prev, [cardId]: !prev[cardId] }))}
                          style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: '0.68rem', textAlign: 'left', padding: 0 }}
                        >
                          {openCardDetails[cardId] ? 'Hide Details' : 'Advanced / Details'}
                        </button>
                        {openCardDetails[cardId] && (
                          <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '8px', fontSize: '0.68rem', color: '#9ca3af', lineHeight: 1.55 }}>
                            {cardId === 'white' && (
                              <div style={{ marginTop: '2px', marginBottom: '8px', padding: '6px 8px', backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: '5px', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: '2px', fontFamily: 'ui-monospace, monospace', fontSize: '0.62rem' }}>
                                <div>Source: Original</div>
                                <div>Isolation: {slot?.generationProvider || (slot?.isAiGenerated ? 'Gemini' : 'PhotoRoom')}</div>
                                <div>Cache: {(slot as any)?.cacheHit ? 'HIT' : 'MISS'}</div>
                                <div>Cache Version: v3</div>
                                <div>Artifact Validation: {slot?.generationFailed ? 'FAIL' : (previewUrl ? 'PASS' : 'PENDING')}</div>
                                <div>Forbidden Objects: {(slot as any)?.forbiddenObjects?.length ? (slot as any).forbiddenObjects.join(', ') : 'None'}</div>
                                <div>Final Asset: {previewUrl || 'None'}</div>
                              </div>
                            )}
                            {(cardId === 'model' || cardId === 'silk') && <div>AI Provider: {selectedAiProvider === 'gemini' ? 'Gemini' : 'OpenAI'}</div>}
                            {(cardId === 'model' || cardId === 'silk') && <div>Custom prompt is available in Advanced Settings.</div>}
                            <div>Source state: {status}</div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Advanced Settings */}
              <details
                open={showAdvancedSettings}
                onToggle={(e) => setShowAdvancedSettings(e.currentTarget.open)}
                style={{ borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', backgroundColor: 'rgba(10, 12, 16, 0.5)', overflow: 'hidden' }}
              >
                <summary style={{ padding: '14px 18px', cursor: 'pointer', color: '#fae084', fontSize: '0.86rem', fontWeight: 800, listStyle: 'none' }}>Advanced Settings</summary>
              <div
                style={{
                  padding: '20px',
                  backgroundColor: 'rgba(20, 24, 34, 0.85)',
                  borderRadius: '12px',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '16px',
                }}
              >
                <h4 style={{ fontSize: '0.88rem', fontWeight: 700, color: '#fae084', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Sliders size={16} />
                  Configure Media Pack Generation
                </h4>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                    gap: '16px',
                  }}
                >
                  {/* Preset Selector */}
                  <div>
                    <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#e5e7eb', marginBottom: '6px' }}>
                      Commercial Styling Preset
                    </label>
                    <select
                      value={selectedPreset}
                      onChange={(e) => setSelectedPreset(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        backgroundColor: '#0a0c10',
                        border: '1px solid rgba(255, 255, 255, 0.15)',
                        borderRadius: '8px',
                        color: '#f3f4f6',
                        fontSize: '0.82rem',
                        outline: 'none',
                      }}
                    >
                      {modelStylingPresets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} — {p.description}
                        </option>
                      ))}
                      {modelStylingPresets.length === 0 && (
                        <>
                          <option value="indian_festive">Indian Festive / Wedding</option>
                          <option value="western_fashion">Modern Western Fashion</option>
                          <option value="office_to_occasion">Office to Occasion</option>
                          <option value="minimal_luxury_studio">Minimal Luxury Studio</option>
                          <option value="bridal_styling">Bridal Styling</option>
                          <option value="everyday_wear">Everyday Casual</option>
                        </>
                      )}
                    </select>
                  </div>

                  {/* Workflow Mode */}
                  <div>
                    <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#e5e7eb', marginBottom: '6px' }}>
                      Approval Workflow
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                      <button
                        type="button"
                        onClick={() => setApprovalMode('REVIEW_FIRST')}
                        style={{
                          padding: '8px 10px',
                          borderRadius: '8px',
                          border: approvalMode === 'REVIEW_FIRST' ? '1px solid #f59e0b' : '1px solid rgba(255, 255, 255, 0.1)',
                          backgroundColor: approvalMode === 'REVIEW_FIRST' ? 'rgba(245, 158, 11, 0.15)' : 'rgba(0, 0, 0, 0.3)',
                          color: approvalMode === 'REVIEW_FIRST' ? '#fae084' : '#9ca3af',
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                        }}
                      >
                        <div>Mode A: Review</div>
                        <div style={{ fontSize: '0.65rem', color: '#9ca3af', fontWeight: 400, marginTop: '2px' }}>
                          Inspect slots first
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => setApprovalMode('FULL_AUTO')}
                        style={{
                          padding: '8px 10px',
                          borderRadius: '8px',
                          border: approvalMode === 'FULL_AUTO' ? '1px solid #10b981' : '1px solid rgba(255, 255, 255, 0.1)',
                          backgroundColor: approvalMode === 'FULL_AUTO' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(0, 0, 0, 0.3)',
                          color: approvalMode === 'FULL_AUTO' ? '#6ee7b7' : '#9ca3af',
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontSize: '0.75rem',
                          fontWeight: 600,
                        }}
                      >
                        <div>Mode B: Auto-Push</div>
                        <div style={{ fontSize: '0.65rem', color: '#9ca3af', fontWeight: 400, marginTop: '2px' }}>
                          Push direct to Shopify
                        </div>
                      </button>
                    </div>
                  </div>
                </div>

                {/* AI Image Generation Engine Option */}
                <div
                  style={{
                    padding: '14px 16px',
                    backgroundColor: 'rgba(255, 255, 255, 0.03)',
                    borderRadius: '10px',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Sparkles size={14} color="#f59e0b" />
                      <label style={{ fontSize: '0.78rem', fontWeight: 600, color: '#e5e7eb', margin: 0 }}>
                        AI Image Generation Engine
                      </label>
                    </div>
                    <span style={{ fontSize: '0.7rem', color: '#9ca3af' }}>
                      Choose Gemini Image Pro or OpenAI DALL·E 3 based on your requirement
                    </span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '8px' }}>
                    {/* Gemini Image Pro */}
                    <button
                      type="button"
                      onClick={() => setSelectedAiProvider('gemini')}
                      style={{
                        padding: '10px 12px',
                        borderRadius: '8px',
                        border:
                          selectedAiProvider === 'gemini'
                            ? '1.5px solid #fae084'
                            : '1px solid rgba(255, 255, 255, 0.1)',
                        backgroundColor:
                          selectedAiProvider === 'gemini'
                            ? 'rgba(245, 158, 11, 0.18)'
                            : 'rgba(10, 12, 16, 0.6)',
                        color: selectedAiProvider === 'gemini' ? '#fae084' : '#9ca3af',
                        cursor: 'pointer',
                        textAlign: 'left',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '3px',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, fontSize: '0.78rem' }}>
                          <Zap size={13} color={selectedAiProvider === 'gemini' ? '#fae084' : '#9ca3af'} />
                          <span>Gemini Image Pro (Imagen 3)</span>
                        </div>
                        <span
                          style={{
                            fontSize: '0.62rem',
                            padding: '1px 5px',
                            borderRadius: '4px',
                            background: 'rgba(245, 158, 11, 0.25)',
                            color: '#fae084',
                            fontWeight: 700,
                          }}
                        >
                          ~$0.03 / img
                        </span>
                      </div>
                      <span style={{ fontSize: '0.66rem', color: '#9ca3af' }}>
                        Multimodal vision, 95%+ jewellery design lock, fast execution
                      </span>
                    </button>

                    {/* OpenAI DALL-E 3 */}
                    <button
                      type="button"
                      onClick={() => setSelectedAiProvider('openai')}
                      style={{
                        padding: '10px 12px',
                        borderRadius: '8px',
                        border:
                          selectedAiProvider === 'openai'
                            ? '1.5px solid #60a5fa'
                            : '1px solid rgba(255, 255, 255, 0.1)',
                        backgroundColor:
                          selectedAiProvider === 'openai'
                            ? 'rgba(59, 130, 246, 0.18)'
                            : 'rgba(10, 12, 16, 0.6)',
                        color: selectedAiProvider === 'openai' ? '#93c5fd' : '#9ca3af',
                        cursor: 'pointer',
                        textAlign: 'left',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '3px',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, fontSize: '0.78rem' }}>
                          <Bot size={13} color={selectedAiProvider === 'openai' ? '#60a5fa' : '#9ca3af'} />
                          <span>OpenAI (DALL·E 3)</span>
                        </div>
                        <span
                          style={{
                            fontSize: '0.62rem',
                            padding: '1px 5px',
                            borderRadius: '4px',
                            background: 'rgba(59, 130, 246, 0.25)',
                            color: '#93c5fd',
                            fontWeight: 700,
                          }}
                        >
                          ~$0.04 / img
                        </span>
                      </div>
                      <span style={{ fontSize: '0.66rem', color: '#9ca3af' }}>
                        Artistic editorial richness, high texture detail, studio lighting
                      </span>
                    </button>
                  </div>
                </div>

                {/* White Product Dedicated AI Provider */}
                <div
                  style={{
                    padding: '12px 14px',
                    backgroundColor: 'rgba(255, 255, 255, 0.03)',
                    borderRadius: '10px',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#e5e7eb', marginBottom: '2px' }}>
                      White Product AI Provider
                    </label>
                    <span style={{ fontSize: '0.68rem', color: '#9ca3af' }}>
                      Provider engine used when White Product is set to AI Presentation mode
                    </span>
                  </div>
                  <select
                    value={whiteProductAiProvider}
                    onChange={(e) => setWhiteProductAiProvider(e.target.value as 'auto' | 'gemini' | 'openai')}
                    style={{
                      padding: '8px 12px',
                      borderRadius: '8px',
                      backgroundColor: '#0a0c10',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      color: '#f3f4f6',
                      fontSize: '0.78rem',
                      minWidth: '130px',
                    }}
                  >
                    <option value="auto">Auto</option>
                    <option value="gemini">Gemini</option>
                    <option value="openai">OpenAI</option>
                  </select>
                </div>

                {/* Legacy slot AI controls are hidden; the five semantic cards above are the source of truth. */}
                <div
                  style={{
                    padding: '16px',
                    backgroundColor: 'rgba(255, 255, 255, 0.03)',
                    borderRadius: '12px',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    display: 'none',
                    flexDirection: 'column',
                    gap: '14px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Sparkles size={16} color="#f59e0b" />
                      <div>
                        <div style={{ fontSize: '0.84rem', fontWeight: 700, color: '#ffffff' }}>
                          AI Generation Selection (Tick to Generate)
                        </div>
                        <div style={{ fontSize: '0.68rem', color: '#9ca3af', marginTop: '2px' }}>
                          AI will only generate images for slots you explicitly tick below. Unticked slots preserve your authentic real photos.
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <button
                        type="button"
                        onClick={() => {
                          setEnableStyledSlot2(false);
                          setEnableModelSlot4(false);
                          setEnableLifestyleSlot5(false);
                        }}
                        style={{
                          padding: '4px 8px',
                          fontSize: '0.66rem',
                          fontWeight: 600,
                          borderRadius: '6px',
                          border: (!enableStyledSlot2 && !enableModelSlot4 && !enableLifestyleSlot5) ? '1px solid #10b981' : '1px solid rgba(255, 255, 255, 0.15)',
                          backgroundColor: (!enableStyledSlot2 && !enableModelSlot4 && !enableLifestyleSlot5) ? 'rgba(16, 185, 129, 0.2)' : 'transparent',
                          color: (!enableStyledSlot2 && !enableModelSlot4 && !enableLifestyleSlot5) ? '#34d399' : '#9ca3af',
                          cursor: 'pointer',
                        }}
                      >
                        📷 Real Photos Only (0 AI)
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEnableStyledSlot2(true);
                          setEnableModelSlot4(true);
                          setEnableLifestyleSlot5(true);
                        }}
                        style={{
                          padding: '4px 8px',
                          fontSize: '0.66rem',
                          fontWeight: 600,
                          borderRadius: '6px',
                          border: (enableStyledSlot2 && enableModelSlot4 && enableLifestyleSlot5) ? '1px solid #fae084' : '1px solid rgba(255, 255, 255, 0.15)',
                          backgroundColor: (enableStyledSlot2 && enableModelSlot4 && enableLifestyleSlot5) ? 'rgba(245, 158, 11, 0.2)' : 'transparent',
                          color: (enableStyledSlot2 && enableModelSlot4 && enableLifestyleSlot5) ? '#fae084' : '#9ca3af',
                          cursor: 'pointer',
                        }}
                      >
                        ✨ Select All AI (3)
                      </button>
                    </div>
                  </div>

                  {/* TICK 1: SLOT 2 STYLED SUPPORTING */}
                  <div
                    style={{
                      padding: '12px 14px',
                      borderRadius: '8px',
                      backgroundColor: enableStyledSlot2 ? 'rgba(245, 158, 11, 0.08)' : 'rgba(0, 0, 0, 0.25)',
                      border: enableStyledSlot2 ? '1px solid rgba(245, 158, 11, 0.35)' : '1px solid rgba(255, 255, 255, 0.06)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={enableStyledSlot2}
                          onChange={(e) => setEnableStyledSlot2(e.target.checked)}
                          style={{ width: '16px', height: '16px', accentColor: '#f59e0b', cursor: 'pointer' }}
                        />
                        <span style={{ fontSize: '0.80rem', fontWeight: 700, color: enableStyledSlot2 ? '#fae084' : '#e5e7eb' }}>
                          Slot 2: Styled Supporting Presentation
                        </span>
                      </label>
                      <span style={{ fontSize: '0.66rem', color: enableStyledSlot2 ? '#fae084' : '#6b7280' }}>
                        {enableStyledSlot2 ? '✓ Will be generated with AI' : 'Off (Uses authentic real photo)'}
                      </span>
                    </div>

                    {enableStyledSlot2 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px', paddingLeft: '24px' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '6px' }}>
                          {[
                            { id: 'silk_and_flower' as const, label: 'Silk & Flowers', desc: 'Draped silk + petals' },
                            { id: 'flower_styling' as const, label: 'Flower Petals', desc: 'Fresh petals on silk' },
                            { id: 'silk_cloth' as const, label: 'Pure Silk Satin', desc: 'Silk cloth backdrop' },
                            { id: 'minimal_luxury_flat_lay' as const, label: 'Silk Flat Lay', desc: 'Lustrous silk drape' },
                          ].map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => setSlot2Style(item.id)}
                              style={{
                                padding: '6px 8px',
                                borderRadius: '6px',
                                border: slot2Style === item.id ? '1px solid #f59e0b' : '1px solid rgba(255, 255, 255, 0.1)',
                                backgroundColor: slot2Style === item.id ? 'rgba(245, 158, 11, 0.2)' : 'rgba(10, 12, 16, 0.6)',
                                color: slot2Style === item.id ? '#fae084' : '#9ca3af',
                                cursor: 'pointer',
                                textAlign: 'left',
                                fontSize: '0.72rem',
                                fontWeight: 600,
                              }}
                            >
                              <div>{item.label}</div>
                              <div style={{ fontSize: '0.60rem', color: '#9ca3af', fontWeight: 400 }}>{item.desc}</div>
                            </button>
                          ))}
                        </div>

                        <div>
                          <label style={{ display: 'block', fontSize: '0.66rem', color: '#fae084', fontWeight: 600, marginBottom: '3px' }}>
                            Slot 2 Prompt / Instructions:
                          </label>
                          <input
                            type="text"
                            value={step1PromptSlot2}
                            onChange={(e) => setStep1PromptSlot2(e.target.value)}
                            placeholder={getDefaultPromptForSlot(2, 'STYLED_SUPPORTING')}
                            style={{
                              width: '100%',
                              padding: '6px 10px',
                              backgroundColor: '#0a0c10',
                              border: '1px solid rgba(245, 158, 11, 0.3)',
                              borderRadius: '6px',
                              color: '#f3f4f6',
                              fontSize: '0.75rem',
                              outline: 'none',
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* TICK 2: SLOT 4 FASHION MODEL */}
                  <div
                    style={{
                      padding: '12px 14px',
                      borderRadius: '8px',
                      backgroundColor: enableModelSlot4 ? 'rgba(79, 70, 229, 0.08)' : 'rgba(0, 0, 0, 0.25)',
                      border: enableModelSlot4 ? '1px solid rgba(99, 102, 241, 0.35)' : '1px solid rgba(255, 255, 255, 0.06)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={enableModelSlot4}
                          onChange={(e) => setEnableModelSlot4(e.target.checked)}
                          style={{ width: '16px', height: '16px', accentColor: '#6366f1', cursor: 'pointer' }}
                        />
                        <span style={{ fontSize: '0.80rem', fontWeight: 700, color: enableModelSlot4 ? '#a5b4fc' : '#e5e7eb' }}>
                          Slot 4: AI Fashion Model Image
                        </span>
                      </label>
                      <span style={{ fontSize: '0.66rem', color: enableModelSlot4 ? '#a5b4fc' : '#6b7280' }}>
                        {enableModelSlot4 ? '✓ Will be generated with AI' : 'Off (Uses authentic real photo)'}
                      </span>
                    </div>

                    {enableModelSlot4 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px', paddingLeft: '24px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '0.68rem', color: '#9ca3af', fontWeight: 600 }}>Model Preset:</span>
                          <select
                            value={selectedPreset}
                            onChange={(e) => setSelectedPreset(e.target.value)}
                            style={{
                              padding: '4px 8px',
                              fontSize: '0.72rem',
                              backgroundColor: '#0a0c10',
                              border: '1px solid rgba(99, 102, 241, 0.4)',
                              borderRadius: '6px',
                              color: '#a5b4fc',
                              outline: 'none',
                              cursor: 'pointer',
                            }}
                          >
                            {modelStylingPresets.map((p) => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                            {modelStylingPresets.length === 0 && (
                              <>
                                <option value="indian_festive">Indian Festive</option>
                                <option value="western_fashion">Western Fashion</option>
                                <option value="office_to_occasion">Office to Occasion</option>
                                <option value="minimal_luxury_studio">Minimal Luxury</option>
                              </>
                            )}
                          </select>
                        </div>

                        <div>
                          <label style={{ display: 'block', fontSize: '0.66rem', color: '#a5b4fc', fontWeight: 600, marginBottom: '3px' }}>
                            Slot 4 Model Prompt / Instructions:
                          </label>
                          <input
                            type="text"
                            value={step1PromptSlot4}
                            onChange={(e) => setStep1PromptSlot4(e.target.value)}
                            placeholder={getDefaultPromptForSlot(4, 'MODEL_1')}
                            style={{
                              width: '100%',
                              padding: '6px 10px',
                              backgroundColor: '#0a0c10',
                              border: '1px solid rgba(99, 102, 241, 0.3)',
                              borderRadius: '6px',
                              color: '#f3f4f6',
                              fontSize: '0.75rem',
                              outline: 'none',
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* TICK 3: SLOT 5 LIFESTYLE PRESENTATION */}
                  <div
                    style={{
                      padding: '12px 14px',
                      borderRadius: '8px',
                      backgroundColor: enableLifestyleSlot5 ? 'rgba(59, 130, 246, 0.08)' : 'rgba(0, 0, 0, 0.25)',
                      border: enableLifestyleSlot5 ? '1px solid rgba(59, 130, 246, 0.35)' : '1px solid rgba(255, 255, 255, 0.06)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={enableLifestyleSlot5}
                          onChange={(e) => setEnableLifestyleSlot5(e.target.checked)}
                          style={{ width: '16px', height: '16px', accentColor: '#3b82f6', cursor: 'pointer' }}
                        />
                        <span style={{ fontSize: '0.80rem', fontWeight: 700, color: enableLifestyleSlot5 ? '#93c5fd' : '#e5e7eb' }}>
                          Slot 5: AI Lifestyle & Still-Life Photo
                        </span>
                      </label>
                      <span style={{ fontSize: '0.66rem', color: enableLifestyleSlot5 ? '#93c5fd' : '#6b7280' }}>
                        {enableLifestyleSlot5 ? '✓ Will be generated with AI' : 'Off (Uses authentic real photo)'}
                      </span>
                    </div>

                    {enableLifestyleSlot5 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px', paddingLeft: '24px' }}>
                        <div>
                          <label style={{ display: 'block', fontSize: '0.66rem', color: '#93c5fd', fontWeight: 600, marginBottom: '3px' }}>
                            Slot 5 Lifestyle Prompt / Instructions:
                          </label>
                          <input
                            type="text"
                            value={step1PromptSlot5}
                            onChange={(e) => setStep1PromptSlot5(e.target.value)}
                            placeholder={getDefaultPromptForSlot(5, 'MODEL_2_OR_SUPPORTING')}
                            style={{
                              width: '100%',
                              padding: '6px 10px',
                              backgroundColor: '#0a0c10',
                              border: '1px solid rgba(59, 130, 246, 0.3)',
                              borderRadius: '6px',
                              color: '#f3f4f6',
                              fontSize: '0.75rem',
                              outline: 'none',
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Optional Global Style Prompt */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <label style={{ fontSize: '0.78rem', fontWeight: 600, color: '#e5e7eb' }}>
                      Global Art Direction / Lighting Note (Optional)
                    </label>
                    <span style={{ fontSize: '0.7rem', color: '#fae084', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <Lock size={11} />
                      Jewellery design & stones strictly locked
                    </span>
                  </div>
                  <input
                    type="text"
                    value={customPrompt}
                    onChange={(e) => setCustomPrompt(e.target.value)}
                    placeholder="e.g. warm golden hour lighting, raw silk background, high jewelry magazine style"
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      backgroundColor: '#0a0c10',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      borderRadius: '8px',
                      color: '#f3f4f6',
                      fontSize: '0.82rem',
                      outline: 'none',
                    }}
                  />
                </div>

                {/* Generate Selected lives in the five-card workflow header. */}
                <div style={{ display: 'none', justifyContent: 'flex-end', marginTop: '6px' }}>
                  <button
                    type="button"
                    disabled={isProcessing || rawFiles.length === 0}
                    onClick={runPipeline}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '12px 28px',
                      borderRadius: '10px',
                      border: 'none',
                      background: rawFiles.length === 0 ? 'rgba(255, 255, 255, 0.1)' : 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                      color: rawFiles.length === 0 ? '#6b7280' : '#0a0c10',
                      fontSize: '0.9rem',
                      fontWeight: 700,
                      cursor: rawFiles.length === 0 ? 'not-allowed' : 'pointer',
                      boxShadow: rawFiles.length === 0 ? 'none' : '0 4px 16px rgba(245, 158, 11, 0.35)',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    {isProcessing ? (
                      <>
                        <RefreshCw size={18} className="animate-spin" />
                        <span>Processing Media Pack ({progressPercent}%)...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles size={18} />
                        <span>
                          {anyAiSelected
                            ? `Generate Shopify Media Pack (${(enableStyledSlot2 ? 1 : 0) + (enableModelSlot4 ? 1 : 0) + (enableLifestyleSlot5 ? 1 : 0)} AI Selected)`
                            : 'Compose Gallery Pack (Real Photos Only, 0 AI)'}
                        </span>
                      </>
                    )}
                  </button>
                </div>

                {/* Progress status */}
                {isProcessing && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
                    <div style={{ fontSize: '0.75rem', color: '#fae084' }}>{processingStep}</div>
                    <div style={{ width: '100%', height: '6px', backgroundColor: 'rgba(255, 255, 255, 0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${progressPercent}%`,
                          height: '100%',
                          background: 'linear-gradient(90deg, #f59e0b, #10b981)',
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
              </details>
            </div>
          )}

          {/* TAB 2: GALLERY PACK BUILDER */}
          {activeTab === 'gallery_builder' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* Warnings / Notifications */}
              {pipelineWarnings.length > 0 && (
                <div
                  style={{
                    padding: '12px 16px',
                    borderRadius: '8px',
                    backgroundColor: 'rgba(245, 158, 11, 0.1)',
                    border: '1px solid rgba(245, 158, 11, 0.3)',
                    color: '#fae084',
                    fontSize: '0.78rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                  }}
                >
                  {pipelineWarnings.map((w, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <AlertTriangle size={14} />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Action Bar */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '16px 20px',
                  backgroundColor: 'rgba(20, 24, 34, 0.95)',
                  borderRadius: '12px',
                  border: '1px solid rgba(212, 175, 55, 0.25)',
                  flexWrap: 'wrap',
                  gap: '12px',
                }}
              >
                <div>
                  <h4 style={{ fontSize: '0.92rem', fontWeight: 700, color: '#ffffff', margin: 0 }}>
                    Recommended Shopify Gallery Pack ({galleryPack?.slots.filter((s) => s.included !== false).length || 0} Included / {galleryPack?.slots.length || 0} Slots)
                  </h4>
                  <p style={{ fontSize: '0.74rem', color: '#9ca3af', margin: '2px 0 0 0' }}>
                    Slot 1 is clean commercial cover. You can delete unwanted slots, uncheck images, or generate AI shots from any photo.
                  </p>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', position: 'relative' }}>
                  {/* + Add Slot Menu */}
                  <div style={{ position: 'relative' }}>
                    <button
                      type="button"
                      onClick={() => setShowAddSlotMenu(!showAddSlotMenu)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '10px 16px',
                        borderRadius: '8px',
                        border: '1px solid rgba(245, 158, 11, 0.45)',
                        backgroundColor: 'rgba(245, 158, 11, 0.12)',
                        color: '#fae084',
                        fontSize: '0.82rem',
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      <Plus size={15} />
                      <span>+ Add Image Slot</span>
                    </button>

                    {showAddSlotMenu && (
                      <div
                        style={{
                          position: 'absolute',
                          top: '100%',
                          right: 0,
                          marginTop: '6px',
                          width: '260px',
                          backgroundColor: '#12151d',
                          border: '1px solid rgba(245, 158, 11, 0.35)',
                          borderRadius: '10px',
                          boxShadow: '0 12px 30px rgba(0,0,0,0.85)',
                          zIndex: 100,
                          padding: '8px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '4px',
                        }}
                      >
                        <div style={{ fontSize: '0.66rem', color: '#fae084', padding: '4px 6px', fontWeight: 700 }}>
                          ADD FROM UPLOADED PHOTOS:
                        </div>
                        {rawFiles.map((rf, rfIdx) => (
                          <button
                            key={rf.id}
                            type="button"
                            onClick={() => addSlotFromRawFile(rf)}
                            style={{
                              textAlign: 'left',
                              padding: '6px 8px',
                              borderRadius: '6px',
                              backgroundColor: 'rgba(255, 255, 255, 0.04)',
                              border: '1px solid rgba(255, 255, 255, 0.08)',
                              color: '#e5e7eb',
                              fontSize: '0.72rem',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                            }}
                          >
                            <ImageIcon size={13} color="#f59e0b" />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              Photo #{rfIdx + 1}: {rf.name}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Shopify Status Badge & Quick Connect Toggle */}
                  <button
                    type="button"
                    onClick={() => setShowShopifyConnectDrawer(!showShopifyConnectDrawer)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      border: shopifyConfig.shopDomain && shopifyConfig.adminAccessToken
                        ? '1px solid rgba(16, 185, 129, 0.4)'
                        : '1px solid rgba(245, 158, 11, 0.5)',
                      backgroundColor: shopifyConfig.shopDomain && shopifyConfig.adminAccessToken
                        ? 'rgba(16, 185, 129, 0.12)'
                        : 'rgba(245, 158, 11, 0.15)',
                      color: shopifyConfig.shopDomain && shopifyConfig.adminAccessToken
                        ? '#6ee7b7'
                        : '#fae084',
                      fontSize: '0.74rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                    title={shopifyConfig.shopDomain && shopifyConfig.adminAccessToken
                      ? `Connected to: ${shopifyConfig.shopName || shopifyConfig.shopDomain} (Click to manage)`
                      : 'Shopify is not connected. Click to enter your credentials.'}
                  >
                    <ShoppingBag size={13} />
                    <span>
                      {shopifyConfig.shopDomain && shopifyConfig.adminAccessToken
                        ? `Shopify: ${shopifyConfig.shopName || shopifyConfig.shopDomain}`
                        : 'Connect Shopify Store'}
                    </span>
                  </button>

                  <button
                    type="button"
                    disabled={isPublishing || !galleryPack}
                    onClick={handlePublishToShopify}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '10px 22px',
                      borderRadius: '8px',
                      border: 'none',
                      background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                      color: '#ffffff',
                      fontSize: '0.85rem',
                      fontWeight: 700,
                      cursor: isPublishing ? 'not-allowed' : 'pointer',
                      boxShadow: '0 4px 14px rgba(16, 185, 129, 0.35)',
                    }}
                  >
                    {isPublishing ? (
                      <>
                        <RefreshCw size={16} className="animate-spin" />
                        <span>Pushing to Shopify...</span>
                      </>
                    ) : (
                      <>
                        <ShoppingBag size={16} />
                        <span>Approve & Push ({galleryPack?.slots.filter((s) => s.included !== false).length || 0} Images) to Shopify</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Gallery Rules & Validation Banner */}
              {galleryPack && (
                <div
                  style={{
                    padding: '12px 16px',
                    borderRadius: '10px',
                    backgroundColor: 'rgba(20, 24, 34, 0.85)',
                    border: '1px solid rgba(255, 255, 255, 0.12)',
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                    fontSize: '0.75rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <CheckCircle2 size={15} color="#10b981" />
                      <span style={{ color: '#e5e7eb' }}>
                        <strong style={{ color: '#fae084' }}>Slot 1:</strong> Clean Cover (Plain, distraction-free)
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Sparkles size={15} color="#f59e0b" />
                      <span style={{ color: '#e5e7eb' }}>
                        <strong style={{ color: '#a5b4fc' }}>Slot 2:</strong> Styled Supporting ({galleryPack.slot2StyleOption?.replace(/_/g, ' ') || slot2Style.replace(/_/g, ' ')})
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <Layers size={14} color="#9ca3af" />
                      <span style={{ color: '#9ca3af' }}>Slot 3: Detail Crop • Slot 4 & 5: Model/Supporting</span>
                    </div>
                  </div>

                  {galleryPack.slots.length >= 2 &&
                    (galleryPack.slots[0].url || (galleryPack.slots[0] as any).imageUrl) ===
                      (galleryPack.slots[1].url || (galleryPack.slots[1] as any).imageUrl) && (
                      <div
                        style={{
                          color: '#f87171',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          fontWeight: 600,
                        }}
                      >
                        <AlertTriangle size={14} />
                        <span>Slot 1 & Slot 2 are identical! Click "Regenerate Styled Slot 2" to style.</span>
                      </div>
                    )}
                </div>
              )}

              {/* Publish notifications */}
              {publishSuccessMessage && (
                <div
                  style={{
                    padding: '12px 16px',
                    borderRadius: '8px',
                    backgroundColor: 'rgba(16, 185, 129, 0.15)',
                    border: '1px solid #10b981',
                    color: '#6ee7b7',
                    fontSize: '0.8rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                >
                  <CheckCircle2 size={16} />
                  <span>{publishSuccessMessage}</span>
                </div>
              )}

              {publishErrorMessage && (
                <div
                  style={{
                    padding: '14px 18px',
                    borderRadius: '10px',
                    backgroundColor: 'rgba(239, 68, 68, 0.18)',
                    border: '1px solid #ef4444',
                    color: '#fca5a5',
                    fontSize: '0.8rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <AlertTriangle size={18} color="#ef4444" style={{ flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, whiteSpace: 'pre-line', lineHeight: 1.45 }}>{publishErrorMessage}</span>
                    </div>

                    {(!shopifyConfig.shopDomain || !shopifyConfig.adminAccessToken || publishErrorMessage.includes('not connected') || publishErrorMessage.includes('401')) && (
                      <button
                        type="button"
                        onClick={() => setShowShopifyConnectDrawer(!showShopifyConnectDrawer)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          backgroundColor: '#f59e0b',
                          border: 'none',
                          color: '#000000',
                          padding: '6px 14px',
                          borderRadius: '8px',
                          fontWeight: 700,
                          fontSize: '0.78rem',
                          cursor: 'pointer',
                          boxShadow: '0 2px 8px rgba(245, 158, 11, 0.4)',
                        }}
                      >
                        <ShoppingBag size={14} />
                        <span>{showShopifyConnectDrawer ? 'Close Connection Panel' : '⚡ Connect Shopify Store Now'}</span>
                      </button>
                    )}
                  </div>

                  {(publishErrorMessage.includes('Invalid API key') ||
                    publishErrorMessage.includes('unrecognized login') ||
                    publishErrorMessage.includes('wrong password') ||
                    publishErrorMessage.includes('401')) && (
                    <div
                      style={{
                        backgroundColor: 'rgba(0, 0, 0, 0.45)',
                        padding: '12px 14px',
                        borderRadius: '8px',
                        border: '1px solid rgba(239, 68, 68, 0.35)',
                        fontSize: '0.74rem',
                        color: '#fecaca',
                        lineHeight: 1.55,
                      }}
                    >
                      <div style={{ fontWeight: 700, color: '#fae084', marginBottom: '5px' }}>
                        ⚠️ How to resolve this Shopify Authentication error:
                      </div>
                      <div>
                        1. Verify your <strong>Shop Domain</strong> (e.g. <code>saazaura.myshopify.com</code>).
                      </div>
                      <div>
                        2. Make sure your Access Token starts with <code>shpat_</code> (Admin API Access Token).
                        Do <strong>NOT</strong> paste your <em>API Key</em> or <em>API Secret Key</em> (<code>shpss_</code>) into the Access Token field.
                      </div>
                      <div>
                        3. Verify that your Shopify Custom App has the <code>write_products</code> and <code>read_products</code> scopes enabled and the app is installed.
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Inline Quick Shopify Connection Drawer */}
              {showShopifyConnectDrawer && (
                <div
                  style={{
                    margin: '12px 0',
                    padding: '20px',
                    borderRadius: '12px',
                    backgroundColor: '#0c111d',
                    border: '1px solid rgba(245, 158, 11, 0.4)',
                    boxShadow: '0 8px 30px rgba(0,0,0,0.7)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <ShoppingBag size={20} color="#f59e0b" />
                      <span style={{ fontSize: '0.92rem', fontWeight: 700, color: '#f3f4f6' }}>
                        Connect Shopify Store
                      </span>
                      <span style={{ fontSize: '0.72rem', color: '#9ca3af', backgroundColor: 'rgba(255, 255, 255, 0.08)', padding: '2px 8px', borderRadius: '12px' }}>
                        Auto-Synced & Securely Saved
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowShopifyConnectDrawer(false)}
                      style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer' }}
                    >
                      <X size={16} />
                    </button>
                  </div>

                  {shopifyConnectError && (
                    <div style={{ padding: '8px 12px', borderRadius: '6px', backgroundColor: 'rgba(239, 68, 68, 0.2)', border: '1px solid #ef4444', color: '#fca5a5', fontSize: '0.76rem', marginBottom: '12px' }}>
                      {shopifyConnectError}
                    </div>
                  )}

                  {/* Mode selection */}
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
                    <button
                      type="button"
                      onClick={() => setShopifyConnectAuthMode('token')}
                      style={{
                        padding: '6px 12px',
                        borderRadius: '6px',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        border: shopifyConnectAuthMode === 'token' ? '1px solid #f59e0b' : '1px solid rgba(255, 255, 255, 0.1)',
                        backgroundColor: shopifyConnectAuthMode === 'token' ? 'rgba(245, 158, 11, 0.2)' : 'rgba(255, 255, 255, 0.04)',
                        color: shopifyConnectAuthMode === 'token' ? '#fae084' : '#9ca3af',
                      }}
                    >
                      Admin API Access Token (Recommended)
                    </button>
                    <button
                      type="button"
                      onClick={() => setShopifyConnectAuthMode('credentials')}
                      style={{
                        padding: '6px 12px',
                        borderRadius: '6px',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        border: shopifyConnectAuthMode === 'credentials' ? '1px solid #f59e0b' : '1px solid rgba(255, 255, 255, 0.1)',
                        backgroundColor: shopifyConnectAuthMode === 'credentials' ? 'rgba(245, 158, 11, 0.2)' : 'rgba(255, 255, 255, 0.04)',
                        color: shopifyConnectAuthMode === 'credentials' ? '#fae084' : '#9ca3af',
                      }}
                    >
                      Client ID & Secret (Auto-Exchange)
                    </button>
                  </div>

                  {/* Form Fields */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.75rem', color: '#d1d5db', marginBottom: '4px', fontWeight: 600 }}>
                        Shopify Store Domain:
                      </label>
                      <input
                        type="text"
                        value={shopifyDomainInput}
                        onChange={(e) => setShopifyDomainInput(e.target.value)}
                        placeholder="e.g. saazaura.myshopify.com"
                        style={{
                          width: '100%',
                          backgroundColor: '#070a11',
                          border: '1px solid rgba(255, 255, 255, 0.15)',
                          borderRadius: '6px',
                          padding: '8px 12px',
                          color: '#ffffff',
                          fontSize: '0.8rem',
                        }}
                      />
                    </div>

                    {shopifyConnectAuthMode === 'token' ? (
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                          <label style={{ fontSize: '0.75rem', color: '#d1d5db', fontWeight: 600 }}>
                            Admin API Access Token:
                          </label>
                          <button
                            type="button"
                            onClick={() => setShowConnectSecret(!showConnectSecret)}
                            style={{ background: 'none', border: 'none', color: '#9ca3af', fontSize: '0.7rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '3px' }}
                          >
                            {showConnectSecret ? <EyeOff size={12} /> : <Eye size={12} />}
                            <span>{showConnectSecret ? 'Hide' : 'Show'}</span>
                          </button>
                        </div>
                        <input
                          type={showConnectSecret ? 'text' : 'password'}
                          value={shopifyTokenInput}
                          onChange={(e) => setShopifyTokenInput(e.target.value)}
                          placeholder="shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                          style={{
                            width: '100%',
                            backgroundColor: '#070a11',
                            border: '1px solid rgba(255, 255, 255, 0.15)',
                            borderRadius: '6px',
                            padding: '8px 12px',
                            color: '#ffffff',
                            fontSize: '0.8rem',
                            fontFamily: 'monospace',
                          }}
                        />
                      </div>
                    ) : (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div>
                          <label style={{ display: 'block', fontSize: '0.75rem', color: '#d1d5db', marginBottom: '4px', fontWeight: 600 }}>
                            Client ID:
                          </label>
                          <input
                            type="text"
                            value={shopifyClientIdInput}
                            onChange={(e) => setShopifyClientIdInput(e.target.value)}
                            placeholder="e.g. 748b61c56..."
                            style={{
                              width: '100%',
                              backgroundColor: '#070a11',
                              border: '1px solid rgba(255, 255, 255, 0.15)',
                              borderRadius: '6px',
                              padding: '8px 12px',
                              color: '#ffffff',
                              fontSize: '0.8rem',
                            }}
                          />
                        </div>
                        <div>
                          <label style={{ display: 'block', fontSize: '0.75rem', color: '#d1d5db', marginBottom: '4px', fontWeight: 600 }}>
                            Client Secret:
                          </label>
                          <input
                            type={showConnectSecret ? 'text' : 'password'}
                            value={shopifyClientSecretInput}
                            onChange={(e) => setShopifyClientSecretInput(e.target.value)}
                            placeholder="shpss_..."
                            style={{
                              width: '100%',
                              backgroundColor: '#070a11',
                              border: '1px solid rgba(255, 255, 255, 0.15)',
                              borderRadius: '6px',
                              padding: '8px 12px',
                              color: '#ffffff',
                              fontSize: '0.8rem',
                            }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Guide Note */}
                    <div style={{ fontSize: '0.7rem', color: '#9ca3af', lineHeight: 1.4, backgroundColor: 'rgba(255, 255, 255, 0.03)', padding: '8px 12px', borderRadius: '6px' }}>
                      💡 <strong>Quick Setup:</strong> In Shopify Admin, go to <em>Settings → Apps and sales channels → Develop apps</em>. Create an app with <code>write_products</code> and <code>read_products</code> scopes enabled, click <em>Install app</em>, and paste the Access Token (<code>shpat_...</code>).
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '4px' }}>
                      <button
                        type="button"
                        onClick={() => setShowShopifyConnectDrawer(false)}
                        style={{
                          padding: '7px 14px',
                          borderRadius: '6px',
                          backgroundColor: 'rgba(255, 255, 255, 0.08)',
                          border: 'none',
                          color: '#d1d5db',
                          fontSize: '0.76rem',
                          cursor: 'pointer',
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={isTestingShopifyConnect}
                        onClick={handleInlineConnectShopify}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '7px 18px',
                          borderRadius: '6px',
                          backgroundColor: '#10b981',
                          border: 'none',
                          color: '#ffffff',
                          fontSize: '0.76rem',
                          fontWeight: 700,
                          cursor: isTestingShopifyConnect ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {isTestingShopifyConnect ? (
                          <>
                            <RefreshCw size={13} className="animate-spin" />
                            <span>Verifying Connection...</span>
                          </>
                        ) : (
                          <>
                            <Check size={14} />
                            <span>Save & Connect Shopify</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* 5-Slot Grid */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                  gap: '14px',
                }}
              >
                {galleryPack?.slots.map((slot, idx) => {
                  const displayImgUrl = slot.url || (slot as any).imageUrl || (slot as any).src;
                  const isAiSlot =
                    slot.isAiGenerated ||
                    slot.sourceType === 'ai_model' ||
                    slot.sourceType === 'ai_lifestyle' ||
                    slot.sourceType === 'AI_MODEL' ||
                    slot.slotRole === 'STYLED_SUPPORTING' ||
                    (slot.slotRole as string) === 'MODEL_1' ||
                    (slot.slotRole as string) === 'MODEL_2_OR_SUPPORTING' ||
                    slot.slotRole === 'AI_MODEL_LIFESTYLE_1' ||
                    slot.slotRole === 'AI_MODEL_LIFESTYLE_2';

                  return (
                    <div
                      key={slot.mediaAssetId || idx}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        backgroundColor: 'rgba(20, 24, 34, 0.9)',
                        borderRadius: '12px',
                        border: slot.isCover
                          ? '2px solid #f59e0b'
                          : slot.included === false
                          ? '1px dashed #ef4444'
                          : '1px solid rgba(255, 255, 255, 0.1)',
                        overflow: 'hidden',
                        boxShadow: slot.isCover ? '0 0 20px rgba(245, 158, 11, 0.2)' : '0 4px 12px rgba(0, 0, 0, 0.4)',
                        opacity: slot.included === false ? 0.6 : 1,
                        transition: 'all 0.2s ease',
                      }}
                    >
                      {/* Slot Header */}
                      <div
                        style={{
                          padding: '8px 10px',
                          backgroundColor: slot.isCover ? 'rgba(245, 158, 11, 0.2)' : 'rgba(0, 0, 0, 0.4)',
                          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '4px',
                        }}
                      >
                        <span style={{ fontSize: '0.74rem', fontWeight: 700, color: slot.isCover ? '#fae084' : slot.slotNumber === 2 ? '#a5b4fc' : '#e5e7eb', display: 'flex', alignItems: 'center', gap: '3px' }}>
                          {slot.isCover && <Crown size={12} color="#f59e0b" fill="#f59e0b" />}
                          {slot.slotNumber === 2 && <Sparkles size={12} color="#818cf8" />}
                          Slot {slot.slotNumber}
                        </span>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <span
                            style={{
                              fontSize: '0.58rem',
                              fontWeight: 700,
                              padding: '2px 4px',
                              borderRadius: '4px',
                              backgroundColor:
                                slot.slotNumber === 1
                                  ? '#059669'
                                  : slot.slotNumber === 2 || (slot.slotRole as string) === 'STYLED_SUPPORTING'
                                  ? '#6366f1'
                                  : (slot.sourceType?.toUpperCase() === 'AI_MODEL' || slot.sourceType?.toUpperCase() === 'AI_LIFESTYLE' || slot.isAiGenerated)
                                  ? '#4f46e5'
                                  : '#374151',
                              color: '#ffffff',
                            }}
                          >
                            {slot.slotNumber === 1
                              ? 'COVER'
                              : slot.slotNumber === 2 || (slot.slotRole as string) === 'STYLED_SUPPORTING'
                              ? 'STYLED'
                              : (slot.sourceType?.toUpperCase() === 'AI_MODEL' || slot.sourceType?.toUpperCase() === 'AI_LIFESTYLE' || slot.isAiGenerated)
                              ? (slot.slotNumber === 5 || (slot.slotRole as string) === 'AI_MODEL_LIFESTYLE_2' || (slot.slotRole as string) === 'MODEL_2_OR_SUPPORTING' ? 'LIFESTYLE' : 'AI MODEL')
                              : 'PHOTO'}
                          </span>

                          {/* Accuracy Pill if Analyzed */}
                          {accuracyMap[slot.slotNumber] && (
                            <span
                              style={{
                                fontSize: '0.56rem',
                                fontWeight: 700,
                                padding: '2px 5px',
                                borderRadius: '4px',
                                backgroundColor: accuracyMap[slot.slotNumber].accuracyScore >= 95 ? 'rgba(16, 185, 129, 0.25)' : 'rgba(245, 158, 11, 0.25)',
                                border: accuracyMap[slot.slotNumber].accuracyScore >= 95 ? '1px solid rgba(16, 185, 129, 0.5)' : '1px solid rgba(245, 158, 11, 0.5)',
                                color: accuracyMap[slot.slotNumber].accuracyScore >= 95 ? '#6ee7b7' : '#fae084',
                              }}
                              title={`Design Lock: ${accuracyMap[slot.slotNumber].accuracyScore}% accuracy vs reference`}
                            >
                              {accuracyMap[slot.slotNumber].accuracyScore}% ACCURATE
                            </span>
                          )}

                          {/* Preview / Inspect Button */}
                          <button
                            type="button"
                            onClick={() => {
                              setPreviewSlotIndex(idx);
                              setPreviewZoom(1);
                              setShowComparison(false);
                            }}
                            style={{
                              background: 'rgba(245, 158, 11, 0.15)',
                              border: '1px solid rgba(245, 158, 11, 0.4)',
                              color: '#fae084',
                              borderRadius: '4px',
                              padding: '2px 4px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                            title="Inspect high-res preview (check output quality)"
                          >
                            <Maximize2 size={11} />
                          </button>

                          {/* Toggle Include / Exclude */}
                          <button
                            type="button"
                            onClick={() => toggleIncludeSlot(idx)}
                            style={{
                              background: slot.included !== false ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.25)',
                              border: slot.included !== false ? '1px solid rgba(16, 185, 129, 0.35)' : '1px solid rgba(239, 68, 68, 0.5)',
                              color: slot.included !== false ? '#6ee7b7' : '#fca5a5',
                              borderRadius: '4px',
                              padding: '2px 4px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                            title={slot.included !== false ? 'Included in Shopify upload (click to exclude)' : 'Excluded from Shopify upload (click to include)'}
                          >
                            {slot.included !== false ? <Eye size={11} /> : <EyeOff size={11} />}
                          </button>

                          {/* Delete Slot Button */}
                          <button
                            type="button"
                            onClick={() => deleteSlot(idx)}
                            style={{
                              background: 'rgba(239, 68, 68, 0.15)',
                              border: '1px solid rgba(239, 68, 68, 0.4)',
                              color: '#f87171',
                              borderRadius: '4px',
                              padding: '2px 4px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                            title="Delete this image from gallery pack"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </div>

                      {/* Image Preview Box with Click-to-Inspect */}
                      <div
                        onClick={() => {
                          setPreviewSlotIndex(idx);
                          setPreviewZoom(1);
                          setShowComparison(false);
                        }}
                        style={{
                          width: '100%',
                          aspectRatio: '1/1',
                          backgroundColor: '#0a0c10',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          position: 'relative',
                          overflow: 'hidden',
                          cursor: 'zoom-in',
                        }}
                        title="Click to zoom / inspect high-res output"
                      >
                        {/* Preview badge */}
                        <div
                          style={{
                            position: 'absolute',
                            top: '6px',
                            right: '6px',
                            backgroundColor: 'rgba(0, 0, 0, 0.65)',
                            backdropFilter: 'blur(4px)',
                            border: '1px solid rgba(255, 255, 255, 0.2)',
                            borderRadius: '4px',
                            color: '#fae084',
                            padding: '2px 5px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '3px',
                            fontSize: '0.6rem',
                            fontWeight: 600,
                            pointerEvents: 'none',
                            zIndex: 2,
                          }}
                        >
                          <Maximize2 size={9} />
                          <span>Inspect</span>
                        </div>
                        {displayImgUrl ? (
                          <>
                            <img
                              src={displayImgUrl}
                              alt={slot.altText || `Slot ${slot.slotNumber}`}
                              onError={(e) => {
                                const target = e.currentTarget;
                                const refFile = rawFiles.find((f) => f.id === slot.mediaAssetId) || rawFiles[0];
                                if (refFile?.dataUrl && target.src !== refFile.dataUrl) {
                                  target.src = refFile.dataUrl;
                                } else {
                                  target.style.display = 'none';
                                  const fallback = target.nextElementSibling as HTMLElement | null;
                                  if (fallback) fallback.style.display = 'flex';
                                }
                              }}
                              style={{
                                width: '100%',
                                height: '100%',
                                objectFit: 'contain',
                                display: 'block',
                                padding: '6px',
                              }}
                            />
                            <div
                              style={{
                                display: 'none',
                                width: '100%',
                                height: '100%',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexDirection: 'column',
                                gap: '6px',
                                color: '#9ca3af',
                                fontSize: '0.72rem',
                              }}
                            >
                              <ImageIcon size={32} color="#4b5563" />
                              <span>Image Rendering...</span>
                            </div>
                          </>
                        ) : (
                          <ImageIcon size={32} color="#4b5563" />
                        )}

                        {slot.included === false && (
                          <div
                            style={{
                              position: 'absolute',
                              top: '8px',
                              backgroundColor: 'rgba(239, 68, 68, 0.88)',
                              color: '#ffffff',
                              fontSize: '0.62rem',
                              fontWeight: 700,
                              padding: '2px 8px',
                              borderRadius: '4px',
                              boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
                            }}
                          >
                            Excluded from Shopify Push
                          </div>
                        )}
                      </div>

                      {/* Reorder & Cover Bar (Separated from Image to prevent zoom bubbling) */}
                      <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          backgroundColor: 'rgba(0, 0, 0, 0.45)',
                          borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                          padding: '4px 8px',
                        }}
                      >
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={(e) => {
                            e.stopPropagation();
                            swapSlots(idx, idx - 1);
                          }}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: idx === 0 ? '#4b5563' : '#e5e7eb',
                            cursor: idx === 0 ? 'not-allowed' : 'pointer',
                            padding: '3px 6px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '2px',
                            borderRadius: '4px',
                            fontSize: '0.64rem',
                          }}
                          title="Move Left"
                        >
                          <ArrowLeft size={13} />
                          <span>Left</span>
                        </button>

                        {!slot.isCover ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSlotAsCover(idx);
                            }}
                            style={{
                              background: 'rgba(245, 158, 11, 0.2)',
                              border: '1px solid rgba(245, 158, 11, 0.4)',
                              borderRadius: '4px',
                              color: '#fae084',
                              fontSize: '0.62rem',
                              fontWeight: 700,
                              padding: '2px 8px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '3px',
                            }}
                            title="Set as Hero Cover Image (Slot 1)"
                          >
                            <Crown size={10} />
                            <span>Make Cover</span>
                          </button>
                        ) : (
                          <span style={{ fontSize: '0.62rem', color: '#fae084', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '3px' }}>
                            <Crown size={10} /> Cover
                          </span>
                        )}

                        <button
                          type="button"
                          disabled={idx === (galleryPack.slots.length - 1)}
                          onClick={(e) => {
                            e.stopPropagation();
                            swapSlots(idx, idx + 1);
                          }}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: idx === (galleryPack.slots.length - 1) ? '#4b5563' : '#e5e7eb',
                            cursor: idx === (galleryPack.slots.length - 1) ? 'not-allowed' : 'pointer',
                            padding: '3px 6px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '2px',
                            borderRadius: '4px',
                            fontSize: '0.64rem',
                          }}
                          title="Move Right"
                        >
                          <span>Right</span>
                          <ArrowRight size={13} />
                        </button>
                      </div>

                      {/* Slot Details & Action Controls */}
                      <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', flex: 1, justifyContent: 'space-between' }}>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.72rem', color: '#9ca3af' }}>
                            <span>{slot.slotRole.replace(/_/g, ' ')}</span>
                            <span>{slot.dimensions?.width || 2048}×{slot.dimensions?.height || 2048}</span>
                          </div>

                          {slot.slotTitle && (
                            <div style={{ fontSize: '0.67rem', color: slot.slotNumber === 1 ? '#fae084' : slot.slotNumber === 2 ? '#a5b4fc' : '#9ca3af', marginTop: '3px', fontWeight: 600 }}>
                              {slot.slotTitle}
                            </div>
                          )}

                          {/* Dedicated Crop & Frame Buttons */}
                          <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
                            <button
                              type="button"
                              onClick={() => handleOpenCropModal(slot.slotNumber, displayImgUrl, `Crop & Frame — Slot ${slot.slotNumber}`)}
                              style={{
                                flex: 1,
                                padding: '4px 6px',
                                borderRadius: '5px',
                                backgroundColor: 'rgba(255, 255, 255, 0.08)',
                                border: '1px solid rgba(255, 255, 255, 0.16)',
                                color: '#f3f4f6',
                                fontSize: '0.64rem',
                                fontWeight: 600,
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '4px',
                              }}
                              title="Open non-destructive crop editor"
                            >
                              <CropIcon size={11} />
                              <span>Edit Crop</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleAutoCropSlot(slot.slotNumber)}
                              style={{
                                padding: '4px 8px',
                                borderRadius: '5px',
                                backgroundColor: 'rgba(245, 158, 11, 0.15)',
                                border: '1px solid rgba(245, 158, 11, 0.35)',
                                color: '#fae084',
                                fontSize: '0.64rem',
                                fontWeight: 600,
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '3px',
                              }}
                              title="Auto-detect jewelry bounds with safe margin"
                            >
                              <Sparkles size={10} />
                              <span>Auto</span>
                            </button>
                          </div>

                          {/* SEO Alt Text */}
                          <div style={{ marginTop: '6px' }}>
                            <label style={{ display: 'block', fontSize: '0.66rem', fontWeight: 600, color: '#9ca3af', marginBottom: '3px' }}>
                              SEO Alt Text:
                            </label>
                            <textarea
                              rows={2}
                              value={slot.altText || ''}
                              onChange={(e) => updateSlotAltText(idx, e.target.value)}
                              style={{
                                width: '100%',
                                fontSize: '0.72rem',
                                padding: '5px 7px',
                                backgroundColor: '#0a0c10',
                                border: '1px solid rgba(255, 255, 255, 0.12)',
                                borderRadius: '6px',
                                color: '#e5e7eb',
                                resize: 'none',
                                outline: 'none',
                              }}
                            />
                          </div>

                          {/* Background Options for Photo / Cover Slots */}
                          {(!isAiSlot || slot.slotNumber === 1 || slot.isCover || slot.originalUrl) && (
                            <div style={{ marginTop: '6px', padding: '6px 8px', borderRadius: '6px', backgroundColor: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '5px' }}>
                                <span style={{ fontSize: '0.66rem', fontWeight: 700, color: '#e5e7eb', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                  <Layers size={11} color="#fae084" /> Background Mode:
                                </span>
                                {cleaningSlotBg === slot.slotNumber ? (
                                  <span style={{ fontSize: '0.60rem', color: '#fae084', display: 'flex', alignItems: 'center', gap: '3px' }}>
                                    <RefreshCw size={9} className="animate-spin" /> Isolating...
                                  </span>
                                ) : (
                                  <span style={{ fontSize: '0.60rem', color: '#9ca3af' }}>
                                    {(slotBgMode[slot.slotNumber] || slot.currentBgMode || 'original') === 'original'
                                      ? 'Original Photo'
                                      : (slotBgMode[slot.slotNumber] || slot.currentBgMode) === 'white'
                                      ? 'Pure White'
                                      : 'Transparent Cutout'}
                                  </span>
                                )}
                              </div>
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px' }}>
                                <button
                                  type="button"
                                  disabled={cleaningSlotBg === slot.slotNumber}
                                  onClick={() => handleToggleSlotBgMode(slot.slotNumber, 'original')}
                                  style={{
                                    padding: '4px 2px',
                                    fontSize: '0.62rem',
                                    fontWeight: 600,
                                    borderRadius: '4px',
                                    border: (slotBgMode[slot.slotNumber] || slot.currentBgMode || 'original') === 'original' ? '1px solid #10b981' : '1px solid rgba(255, 255, 255, 0.1)',
                                    backgroundColor: (slotBgMode[slot.slotNumber] || slot.currentBgMode || 'original') === 'original' ? 'rgba(16, 185, 129, 0.22)' : 'rgba(0, 0, 0, 0.3)',
                                    color: (slotBgMode[slot.slotNumber] || slot.currentBgMode || 'original') === 'original' ? '#34d399' : '#9ca3af',
                                    cursor: cleaningSlotBg === slot.slotNumber ? 'not-allowed' : 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '2px',
                                  }}
                                  title="Original authentic background untouched"
                                >
                                  📷 Original
                                </button>
                                <button
                                  type="button"
                                  disabled={cleaningSlotBg === slot.slotNumber}
                                  onClick={() => handleToggleSlotBgMode(slot.slotNumber, 'white')}
                                  style={{
                                    padding: '4px 2px',
                                    fontSize: '0.62rem',
                                    fontWeight: 600,
                                    borderRadius: '4px',
                                    border: (slotBgMode[slot.slotNumber] || slot.currentBgMode) === 'white' ? '1px solid #fae084' : '1px solid rgba(255, 255, 255, 0.1)',
                                    backgroundColor: (slotBgMode[slot.slotNumber] || slot.currentBgMode) === 'white' ? 'rgba(245, 158, 11, 0.22)' : 'rgba(0, 0, 0, 0.3)',
                                    color: (slotBgMode[slot.slotNumber] || slot.currentBgMode) === 'white' ? '#fae084' : '#9ca3af',
                                    cursor: cleaningSlotBg === slot.slotNumber ? 'not-allowed' : 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '2px',
                                  }}
                                  title="Clean pure white background (#FFFFFF) for Shopify e-commerce catalog"
                                >
                                  ⚪ Pure White
                                </button>
                                <button
                                  type="button"
                                  disabled={cleaningSlotBg === slot.slotNumber}
                                  onClick={() => handleToggleSlotBgMode(slot.slotNumber, 'transparent')}
                                  style={{
                                    padding: '4px 2px',
                                    fontSize: '0.62rem',
                                    fontWeight: 600,
                                    borderRadius: '4px',
                                    border: (slotBgMode[slot.slotNumber] || slot.currentBgMode) === 'transparent' ? '1px solid #60a5fa' : '1px solid rgba(255, 255, 255, 0.1)',
                                    backgroundColor: (slotBgMode[slot.slotNumber] || slot.currentBgMode) === 'transparent' ? 'rgba(59, 130, 246, 0.22)' : 'rgba(0, 0, 0, 0.3)',
                                    color: (slotBgMode[slot.slotNumber] || slot.currentBgMode) === 'transparent' ? '#93c5fd' : '#9ca3af',
                                    cursor: cleaningSlotBg === slot.slotNumber ? 'not-allowed' : 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '2px',
                                  }}
                                  title="Transparent cutout PNG (No background)"
                                >
                                  🏁 No BG
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Slot 1 Dedicated Pure White & AI Presentation Controls */}
                          {slot.slotNumber === 1 && (
                            <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                              {/* Product Match Score badge */}
                              {slot.productMatchScore !== undefined && (
                                <div
                                  style={{
                                    padding: '6px 8px',
                                    borderRadius: '6px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    backgroundColor:
                                      slot.productMatchScore >= 90
                                        ? 'rgba(16, 185, 129, 0.16)'
                                        : slot.productMatchScore >= 80
                                        ? 'rgba(245, 158, 11, 0.16)'
                                        : 'rgba(239, 68, 68, 0.18)',
                                    border: `1px solid ${
                                      slot.productMatchScore >= 90
                                        ? 'rgba(16, 185, 129, 0.4)'
                                        : slot.productMatchScore >= 80
                                        ? 'rgba(245, 158, 11, 0.4)'
                                        : 'rgba(239, 68, 68, 0.5)'
                                    }`,
                                    color:
                                      slot.productMatchScore >= 90
                                        ? '#34d399'
                                        : slot.productMatchScore >= 80
                                        ? '#fbbf24'
                                        : '#f87171',
                                    fontSize: '0.68rem',
                                    fontWeight: 700,
                                  }}
                                >
                                  <span>
                                    {slot.productMatchScore >= 90
                                      ? `✓ HIGH MATCH — ${slot.productMatchScore}%`
                                      : slot.productMatchScore >= 80
                                      ? `⚠ REVIEW RECOMMENDED — ${slot.productMatchScore}%`
                                      : `⚠ NEEDS REVIEW — ${slot.productMatchScore}%`}
                                  </span>
                                  <span style={{ fontSize: '0.62rem', opacity: 0.85, fontWeight: 500 }}>
                                    {slot.whiteProductMode === 'ai_presentation' ? 'AI Presentation' : 'Exact Cutout'}
                                  </span>
                                </div>
                              )}

                              {/* Action buttons: Inspect Match, Regenerate, Use Exact Cutout */}
                              <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                                <button
                                  type="button"
                                  onClick={() => handleOpenSideBySideReview(1)}
                                  style={{
                                    flex: '1 1 90px',
                                    padding: '5px 6px',
                                    borderRadius: '5px',
                                    backgroundColor: 'rgba(59, 130, 246, 0.15)',
                                    border: '1px solid rgba(59, 130, 246, 0.35)',
                                    color: '#93c5fd',
                                    fontSize: '0.64rem',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '4px',
                                  }}
                                >
                                  <Split size={11} />
                                  <span>Inspect Match</span>
                                </button>

                                <button
                                  type="button"
                                  disabled={cleaningSlotBg === 1}
                                  onClick={() => setShowWhiteRegenControls((prev) => !prev)}
                                  style={{
                                    flex: '1 1 80px',
                                    padding: '5px 6px',
                                    borderRadius: '5px',
                                    backgroundColor: 'rgba(250, 224, 132, 0.12)',
                                    border: '1px solid rgba(250, 224, 132, 0.3)',
                                    color: '#fae084',
                                    fontSize: '0.64rem',
                                    fontWeight: 600,
                                    cursor: cleaningSlotBg === 1 ? 'not-allowed' : 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    gap: '4px',
                                  }}
                                >
                                  <RefreshCw size={11} className={cleaningSlotBg === 1 ? 'animate-spin' : ''} />
                                  <span>{cleaningSlotBg === 1 ? 'Working...' : 'Regenerate'}</span>
                                </button>

                                {slot.whiteProductMode === 'ai_presentation' && slot.exactCutoutUrl && (
                                  <button
                                    type="button"
                                    onClick={handleUseExactCutout}
                                    style={{
                                      flex: '1 1 100%',
                                      padding: '4px 6px',
                                      borderRadius: '5px',
                                      backgroundColor: 'rgba(16, 185, 129, 0.12)',
                                      border: '1px solid rgba(16, 185, 129, 0.3)',
                                      color: '#6ee7b7',
                                      fontSize: '0.63rem',
                                      fontWeight: 600,
                                      cursor: 'pointer',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      gap: '4px',
                                    }}
                                  >
                                    <ShieldCheck size={11} />
                                    <span>Use Exact Cutout Instead</span>
                                  </button>
                                )}
                              </div>

                              {/* White Product Regeneration Options Panel */}
                              {showWhiteRegenControls && (
                                <div
                                  style={{
                                    marginTop: '4px',
                                    padding: '8px',
                                    borderRadius: '6px',
                                    backgroundColor: '#0a0c10',
                                    border: '1px solid rgba(250, 224, 132, 0.25)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '6px',
                                  }}
                                >
                                  <div style={{ fontSize: '0.64rem', fontWeight: 700, color: '#fae084' }}>
                                    Regenerate White Product Options:
                                  </div>
                                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                                    <div>
                                      <label style={{ fontSize: '0.60rem', color: '#9ca3af', display: 'block', marginBottom: '2px' }}>Mode</label>
                                      <select
                                        value={whiteProductMode}
                                        onChange={(e) => setWhiteProductMode(e.target.value as any)}
                                        style={{ width: '100%', padding: '4px 6px', borderRadius: '4px', backgroundColor: '#161922', border: '1px solid rgba(255,255,255,0.15)', color: '#fff', fontSize: '0.64rem' }}
                                      >
                                        <option value="ai_presentation">AI Presentation</option>
                                        <option value="exact_cutout">Exact Cutout</option>
                                      </select>
                                    </div>
                                    <div>
                                      <label style={{ fontSize: '0.60rem', color: '#9ca3af', display: 'block', marginBottom: '2px' }}>Ratio</label>
                                      <select
                                        value={whiteProductRatio}
                                        onChange={(e) => setWhiteProductRatio(e.target.value as any)}
                                        style={{ width: '100%', padding: '4px 6px', borderRadius: '4px', backgroundColor: '#161922', border: '1px solid rgba(255,255,255,0.15)', color: '#fff', fontSize: '0.64rem' }}
                                      >
                                        <option value="1:1">1:1 Square</option>
                                        <option value="4:5">4:5 Portrait</option>
                                        <option value="9:16">9:16 Story</option>
                                      </select>
                                    </div>
                                  </div>
                                  <div>
                                    <label style={{ fontSize: '0.60rem', color: '#9ca3af', display: 'block', marginBottom: '2px' }}>AI Provider</label>
                                    <select
                                      value={whiteProductAiProvider}
                                      onChange={(e) => setWhiteProductAiProvider(e.target.value as any)}
                                      style={{ width: '100%', padding: '4px 6px', borderRadius: '4px', backgroundColor: '#161922', border: '1px solid rgba(255,255,255,0.15)', color: '#fff', fontSize: '0.64rem' }}
                                    >
                                      <option value="auto">Auto</option>
                                      <option value="gemini">Gemini</option>
                                      <option value="openai">OpenAI</option>
                                    </select>
                                  </div>
                                  <div>
                                    <label style={{ fontSize: '0.60rem', color: '#9ca3af', display: 'block', marginBottom: '2px' }}>Custom Instruction (optional)</label>
                                    <input
                                      type="text"
                                      value={whiteProductCustomInstruction}
                                      onChange={(e) => setWhiteProductCustomInstruction(e.target.value)}
                                      placeholder="e.g. Center pendant, align chain evenly"
                                      style={{ width: '100%', padding: '4px 6px', borderRadius: '4px', backgroundColor: '#161922', border: '1px solid rgba(255,255,255,0.15)', color: '#fff', fontSize: '0.64rem' }}
                                    />
                                  </div>
                                  <button
                                    type="button"
                                    disabled={cleaningSlotBg === 1}
                                    onClick={async () => {
                                      await handleRebuildWhiteCover({
                                        mode: whiteProductMode,
                                        ratio: whiteProductRatio,
                                        aiProvider: whiteProductAiProvider,
                                        customInstruction: whiteProductCustomInstruction.trim() || undefined,
                                      });
                                      setShowWhiteRegenControls(false);
                                    }}
                                    style={{
                                      padding: '5px 8px',
                                      borderRadius: '4px',
                                      backgroundColor: '#fae084',
                                      border: 'none',
                                      color: '#000',
                                      fontSize: '0.66rem',
                                      fontWeight: 700,
                                      cursor: cleaningSlotBg === 1 ? 'not-allowed' : 'pointer',
                                    }}
                                  >
                                    {cleaningSlotBg === 1 ? 'Regenerating...' : 'Run Regeneration'}
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>

                        {/* AI Slot Failure Banner & Compare Button */}
                        {isAiSlot && (
                          <div style={{ marginTop: '4px' }}>
                            <button
                              type="button"
                              onClick={() => handleOpenSideBySideReview(slot.slotNumber)}
                              style={{
                                width: '100%',
                                padding: '4px 6px',
                                borderRadius: '5px',
                                backgroundColor: 'rgba(59, 130, 246, 0.15)',
                                border: '1px solid rgba(59, 130, 246, 0.35)',
                                color: '#93c5fd',
                                fontSize: '0.64rem',
                                fontWeight: 600,
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '4px',
                                marginBottom: '4px',
                              }}
                            >
                              <Split size={11} />
                              <span>Compare with Original</span>
                            </button>

                            {slot.generationFailed && (
                              <div
                                style={{
                                  backgroundColor: 'rgba(239, 68, 68, 0.18)',
                                  border: '1px solid #ef4444',
                                  borderRadius: '5px',
                                  padding: '5px 7px',
                                  marginBottom: '4px',
                                  fontSize: '0.62rem',
                                  color: '#fca5a5',
                                }}
                              >
                                <div style={{ fontWeight: 700, color: '#f87171', display: 'flex', alignItems: 'center', gap: '3px' }}>
                                  <AlertTriangle size={11} />
                                  <span>GENERATION FAILED</span>
                                </div>
                                <div style={{ marginTop: '2px', color: '#fca5a5', wordBreak: 'break-word' }}>
                                  {slot.generationError || 'AI call failed. Please check API credentials.'}
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* AI Slot: Choose Source Image to generate from */}
                        {isAiSlot && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '4px', paddingTop: '6px', borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}>
                            <label style={{ fontSize: '0.65rem', color: '#fae084', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <Sparkles size={11} />
                              Generate from image:
                            </label>
                            <select
                              value={slotReferenceSource[slot.slotNumber] || 'default'}
                              onChange={(e) => {
                                const val = e.target.value;
                                setSlotReferenceSource((prev) => ({ ...prev, [slot.slotNumber]: val }));
                              }}
                              style={{
                                padding: '3px 6px',
                                fontSize: '0.68rem',
                                backgroundColor: '#0a0c10',
                                border: '1px solid rgba(255, 255, 255, 0.2)',
                                borderRadius: '4px',
                                color: '#e5e7eb',
                                outline: 'none',
                                cursor: 'pointer',
                              }}
                            >
                              <option value="default">Slot 1 (Cover Photo)</option>
                              {galleryPack.slots
                                .filter((s) => s.slotNumber !== slot.slotNumber)
                                .map((s) => (
                                  <option key={`slot_${s.slotNumber}`} value={`slot_${s.slotNumber}`}>
                                    Slot {s.slotNumber} ({s.isCover ? 'Cover' : s.slotRole.replace(/_/g, ' ')})
                                  </option>
                                ))}
                              {rawFiles.map((rf, rfIdx) => (
                                <option key={`file_${rf.id}`} value={`file_${rf.id}`}>
                                  Photo #{rfIdx + 1}: {rf.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}

                        {/* Slot 2 Styled Supporting Controls */}
                        {(slot.slotNumber === 2 || slot.slotRole === 'STYLED_SUPPORTING') && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                              <span style={{ fontSize: '0.66rem', color: '#9ca3af', fontWeight: 600 }}>
                                Style:
                              </span>
                              <select
                                value={slot.styledOption || slot2Style}
                                onChange={(e) => {
                                  const val = e.target.value as StyledSlot2Option;
                                  setSlot2Style(val);
                                  handleRegenerateSlot(
                                    slot.slotNumber,
                                    val,
                                    undefined,
                                    undefined,
                                    slotAiProvider[slot.slotNumber] || selectedAiProvider,
                                    slotCustomPrompts[slot.slotNumber] !== undefined ? slotCustomPrompts[slot.slotNumber] : getDefaultPromptForSlot(slot.slotNumber, slot.slotRole)
                                  );
                                }}
                                disabled={regeneratingSlot === slot.slotNumber}
                                style={{
                                  padding: '2px 6px',
                                  fontSize: '0.68rem',
                                  backgroundColor: '#0a0c10',
                                  border: '1px solid rgba(255, 255, 255, 0.2)',
                                  borderRadius: '4px',
                                  color: '#fae084',
                                  cursor: 'pointer',
                                  outline: 'none',
                                }}
                              >
                                <option value="silk_and_flower">🌸 Silk & Flowers (No Marble)</option>
                                <option value="flower_styling">🌺 Flower Petals on Silk</option>
                                <option value="silk_cloth">🧣 Pure Silk Cloth</option>
                                <option value="minimal_luxury_flat_lay">✨ Silk Flat Lay</option>
                              </select>
                            </div>

                            {/* Engine Selection Toggle */}
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                              <span style={{ fontSize: '0.66rem', color: '#9ca3af', fontWeight: 600 }}>
                                Engine:
                              </span>
                              <div style={{ display: 'flex', gap: '4px' }}>
                                <button
                                  type="button"
                                  onClick={() => setSlotAiProvider((prev) => ({ ...prev, [slot.slotNumber]: 'gemini' }))}
                                  style={{
                                    padding: '2px 6px',
                                    fontSize: '0.64rem',
                                    borderRadius: '4px',
                                    border: (slotAiProvider[slot.slotNumber] || selectedAiProvider) === 'gemini' ? '1px solid #fae084' : '1px solid rgba(255, 255, 255, 0.1)',
                                    backgroundColor: (slotAiProvider[slot.slotNumber] || selectedAiProvider) === 'gemini' ? 'rgba(245, 158, 11, 0.25)' : 'transparent',
                                    color: (slotAiProvider[slot.slotNumber] || selectedAiProvider) === 'gemini' ? '#fae084' : '#9ca3af',
                                    cursor: 'pointer',
                                  }}
                                >
                                  Gemini
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSlotAiProvider((prev) => ({ ...prev, [slot.slotNumber]: 'openai' }))}
                                  style={{
                                    padding: '2px 6px',
                                    fontSize: '0.64rem',
                                    borderRadius: '4px',
                                    border: (slotAiProvider[slot.slotNumber] || selectedAiProvider) === 'openai' ? '1px solid #60a5fa' : '1px solid rgba(255, 255, 255, 0.1)',
                                    backgroundColor: (slotAiProvider[slot.slotNumber] || selectedAiProvider) === 'openai' ? 'rgba(59, 130, 246, 0.25)' : 'transparent',
                                    color: (slotAiProvider[slot.slotNumber] || selectedAiProvider) === 'openai' ? '#93c5fd' : '#9ca3af',
                                    cursor: 'pointer',
                                  }}
                                >
                                  OpenAI
                                </button>
                              </div>
                            </div>

                            {/* Editable AI Prompt for Slot 2 */}
                            <div style={{ marginTop: '2px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2px' }}>
                                <label style={{ fontSize: '0.64rem', color: '#fae084', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '3px' }}>
                                  <Sparkles size={10} /> AI Styling Prompt:
                                </label>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const defaultPrompt = getDefaultPromptForSlot(slot.slotNumber, slot.slotRole);
                                    setSlotCustomPrompts((prev) => ({ ...prev, [slot.slotNumber]: defaultPrompt }));
                                  }}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    color: '#9ca3af',
                                    fontSize: '0.58rem',
                                    cursor: 'pointer',
                                  }}
                                  title="Reset to title-matched smart prompt"
                                >
                                  Reset
                                </button>
                              </div>
                              <textarea
                                rows={2}
                                value={slotCustomPrompts[slot.slotNumber] !== undefined ? slotCustomPrompts[slot.slotNumber] : getDefaultPromptForSlot(slot.slotNumber, slot.slotRole)}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setSlotCustomPrompts((prev) => ({ ...prev, [slot.slotNumber]: val }));
                                }}
                                placeholder="Custom styling prompt (e.g., elegant draped silk with flower petals)..."
                                style={{
                                  width: '100%',
                                  fontSize: '0.68rem',
                                  padding: '4px 6px',
                                  backgroundColor: '#0a0c10',
                                  border: '1px solid rgba(245, 158, 11, 0.3)',
                                  borderRadius: '4px',
                                  color: '#e5e7eb',
                                  resize: 'vertical',
                                  outline: 'none',
                                  fontFamily: 'inherit',
                                  lineHeight: '1.25',
                                }}
                              />
                            </div>

                            <button
                              type="button"
                              disabled={regeneratingSlot === slot.slotNumber}
                              onClick={() => handleRegenerateSlot(
                                slot.slotNumber,
                                slot.styledOption || slot2Style,
                                undefined,
                                undefined,
                                slotAiProvider[slot.slotNumber] || selectedAiProvider,
                                slotCustomPrompts[slot.slotNumber] !== undefined ? slotCustomPrompts[slot.slotNumber] : getDefaultPromptForSlot(slot.slotNumber, slot.slotRole)
                              )}
                              style={{
                                width: '100%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '6px',
                                padding: '6px 10px',
                                backgroundColor: 'rgba(245, 158, 11, 0.18)',
                                border: '1px solid rgba(245, 158, 11, 0.4)',
                                color: '#fae084',
                                borderRadius: '6px',
                                fontSize: '0.72rem',
                                fontWeight: 600,
                                cursor: regeneratingSlot === slot.slotNumber ? 'not-allowed' : 'pointer',
                              }}
                            >
                              <RefreshCw size={12} className={regeneratingSlot === slot.slotNumber ? 'animate-spin' : ''} />
                              <span>{regeneratingSlot === slot.slotNumber ? 'Styling Slot...' : 'Regenerate with Prompt'}</span>
                            </button>
                          </div>
                        )}

                        {/* Model Regeneration button for Model slots */}
                        {isAiSlot && slot.slotNumber !== 2 && slot.slotRole !== 'STYLED_SUPPORTING' && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                              <span style={{ fontSize: '0.66rem', color: '#9ca3af', fontWeight: 600 }}>
                                Model Preset:
                              </span>
                              <select
                                value={slot.modelPresetKey || selectedPreset}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  handleRegenerateSlot(
                                    slot.slotNumber,
                                    undefined,
                                    val,
                                    undefined,
                                    slotAiProvider[slot.slotNumber] || selectedAiProvider,
                                    slotCustomPrompts[slot.slotNumber] !== undefined ? slotCustomPrompts[slot.slotNumber] : getDefaultPromptForSlot(slot.slotNumber, slot.slotRole)
                                  );
                                }}
                                disabled={regeneratingSlot === slot.slotNumber}
                                style={{
                                  padding: '2px 6px',
                                  fontSize: '0.68rem',
                                  backgroundColor: '#0a0c10',
                                  border: '1px solid rgba(255, 255, 255, 0.2)',
                                  borderRadius: '4px',
                                  color: '#a5b4fc',
                                  cursor: 'pointer',
                                  outline: 'none',
                                }}
                              >
                                {modelStylingPresets.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name}
                                  </option>
                                ))}
                                {modelStylingPresets.length === 0 && (
                                  <>
                                    <option value="indian_festive">Indian Festive</option>
                                    <option value="western_fashion">Western Fashion</option>
                                    <option value="office_to_occasion">Office to Occasion</option>
                                    <option value="minimal_luxury_studio">Minimal Luxury</option>
                                  </>
                                )}
                              </select>
                            </div>

                            {/* Engine Selection Toggle */}
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                              <span style={{ fontSize: '0.66rem', color: '#9ca3af', fontWeight: 600 }}>
                                Engine:
                              </span>
                              <div style={{ display: 'flex', gap: '4px' }}>
                                <button
                                  type="button"
                                  onClick={() => setSlotAiProvider((prev) => ({ ...prev, [slot.slotNumber]: 'gemini' }))}
                                  style={{
                                    padding: '2px 6px',
                                    fontSize: '0.64rem',
                                    borderRadius: '4px',
                                    border: (slotAiProvider[slot.slotNumber] || selectedAiProvider) === 'gemini' ? '1px solid #fae084' : '1px solid rgba(255, 255, 255, 0.1)',
                                    backgroundColor: (slotAiProvider[slot.slotNumber] || selectedAiProvider) === 'gemini' ? 'rgba(245, 158, 11, 0.25)' : 'transparent',
                                    color: (slotAiProvider[slot.slotNumber] || selectedAiProvider) === 'gemini' ? '#fae084' : '#9ca3af',
                                    cursor: 'pointer',
                                  }}
                                >
                                  Gemini
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSlotAiProvider((prev) => ({ ...prev, [slot.slotNumber]: 'openai' }))}
                                  style={{
                                    padding: '2px 6px',
                                    fontSize: '0.64rem',
                                    borderRadius: '4px',
                                    border: (slotAiProvider[slot.slotNumber] || selectedAiProvider) === 'openai' ? '1px solid #60a5fa' : '1px solid rgba(255, 255, 255, 0.1)',
                                    backgroundColor: (slotAiProvider[slot.slotNumber] || selectedAiProvider) === 'openai' ? 'rgba(59, 130, 246, 0.25)' : 'transparent',
                                    color: (slotAiProvider[slot.slotNumber] || selectedAiProvider) === 'openai' ? '#93c5fd' : '#9ca3af',
                                    cursor: 'pointer',
                                  }}
                                >
                                  OpenAI
                                </button>
                              </div>
                            </div>

                            {/* Editable AI Prompt for Model / Lifestyle */}
                            <div style={{ marginTop: '2px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2px' }}>
                                <label style={{ fontSize: '0.64rem', color: '#a5b4fc', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '3px' }}>
                                  <Sparkles size={10} /> AI Generation Prompt:
                                </label>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const defaultPrompt = getDefaultPromptForSlot(slot.slotNumber, slot.slotRole);
                                    setSlotCustomPrompts((prev) => ({ ...prev, [slot.slotNumber]: defaultPrompt }));
                                  }}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    color: '#9ca3af',
                                    fontSize: '0.58rem',
                                    cursor: 'pointer',
                                  }}
                                  title="Reset to title-matched smart prompt"
                                >
                                  Reset
                                </button>
                              </div>
                              <textarea
                                rows={2}
                                value={slotCustomPrompts[slot.slotNumber] !== undefined ? slotCustomPrompts[slot.slotNumber] : getDefaultPromptForSlot(slot.slotNumber, slot.slotRole)}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setSlotCustomPrompts((prev) => ({ ...prev, [slot.slotNumber]: val }));
                                }}
                                placeholder="Describe exact model, neckline framing, lighting, or scene..."
                                style={{
                                  width: '100%',
                                  fontSize: '0.68rem',
                                  padding: '4px 6px',
                                  backgroundColor: '#0a0c10',
                                  border: '1px solid rgba(99, 102, 241, 0.3)',
                                  borderRadius: '4px',
                                  color: '#e5e7eb',
                                  resize: 'vertical',
                                  outline: 'none',
                                  fontFamily: 'inherit',
                                  lineHeight: '1.25',
                                }}
                              />
                            </div>

                            <button
                              type="button"
                              disabled={regeneratingSlot === slot.slotNumber}
                              onClick={() => handleRegenerateSlot(
                                slot.slotNumber,
                                undefined,
                                slot.modelPresetKey || selectedPreset,
                                undefined,
                                slotAiProvider[slot.slotNumber] || selectedAiProvider,
                                slotCustomPrompts[slot.slotNumber] !== undefined ? slotCustomPrompts[slot.slotNumber] : getDefaultPromptForSlot(slot.slotNumber, slot.slotRole)
                              )}
                              style={{
                                width: '100%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '6px',
                                padding: '6px 10px',
                                backgroundColor: 'rgba(79, 70, 229, 0.2)',
                                border: '1px solid rgba(79, 70, 229, 0.5)',
                                color: '#a5b4fc',
                                borderRadius: '6px',
                                fontSize: '0.72rem',
                                fontWeight: 600,
                                cursor: regeneratingSlot === slot.slotNumber ? 'not-allowed' : 'pointer',
                              }}
                            >
                              <RefreshCw size={12} className={regeneratingSlot === slot.slotNumber ? 'animate-spin' : ''} />
                              <span>{regeneratingSlot === slot.slotNumber ? 'Regenerating...' : 'Generate with Prompt'}</span>
                            </button>
                          </div>
                        )}

                        {/* Real Photo Slots: Quick Actions to generate AI images directly from this photo */}
                        {!isAiSlot && (
                          <div style={{ display: 'flex', gap: '4px', marginTop: '4px', paddingTop: '6px', borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}>
                            <button
                              type="button"
                              onClick={() => generateNewSlotFromPhoto('AI_MODEL', { base64: displayImgUrl, title: slot.slotTitle || 'Real Photo', slotNumber: slot.slotNumber })}
                              style={{
                                flex: 1,
                                padding: '5px 6px',
                                borderRadius: '6px',
                                backgroundColor: 'rgba(79, 70, 229, 0.16)',
                                border: '1px solid rgba(79, 70, 229, 0.35)',
                                color: '#a5b4fc',
                                fontSize: '0.64rem',
                                fontWeight: 700,
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '3px',
                              }}
                              title="Generate an AI fashion model wearing this jewelry"
                            >
                              <Sparkles size={11} />
                              <span>+ Model Shot</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => generateNewSlotFromPhoto('STYLED_SUPPORTING', { base64: displayImgUrl, title: slot.slotTitle || 'Real Photo', slotNumber: slot.slotNumber })}
                              style={{
                                flex: 1,
                                padding: '5px 6px',
                                borderRadius: '6px',
                                backgroundColor: 'rgba(245, 158, 11, 0.16)',
                                border: '1px solid rgba(245, 158, 11, 0.35)',
                                color: '#fae084',
                                fontSize: '0.64rem',
                                fontWeight: 700,
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '3px',
                              }}
                              title="Generate a luxury styled presentation of this jewelry"
                            >
                              <Sparkles size={11} />
                              <span>+ Styled Shot</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {!galleryPack && (
                <div style={{ padding: '48px', textAlign: 'center', color: '#9ca3af' }}>
                  <Layers size={40} color="#4b5563" style={{ margin: '0 auto 12px auto' }} />
                  <p style={{ fontSize: '0.88rem' }}>No gallery pack generated yet.</p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('upload_inspect')}
                    style={{
                      marginTop: '12px',
                      padding: '8px 16px',
                      backgroundColor: '#f59e0b',
                      color: '#0a0c10',
                      fontSize: '0.8rem',
                      fontWeight: 700,
                      borderRadius: '6px',
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    Go to Upload & Generate
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: SOCIAL FORMATS */}
          {activeTab === 'social_derivatives' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div
                style={{
                  padding: '16px 20px',
                  backgroundColor: 'rgba(20, 24, 34, 0.85)',
                  borderRadius: '12px',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <h4 style={{ fontSize: '0.92rem', fontWeight: 700, color: '#ffffff', margin: 0 }}>
                    Social Marketing Formats
                  </h4>
                  <p style={{ fontSize: '0.75rem', color: '#9ca3af', margin: '2px 0 0 0' }}>
                    Multi-ratio derivatives generated with safe white containment.
                  </p>
                </div>
                <div style={{ fontSize: '0.75rem', color: '#fae084', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Info size={16} />
                  Safe for Instagram, Facebook, and WhatsApp
                </div>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                  gap: '20px',
                }}
              >
                {/* 1:1 Square Feed */}
                <div
                  style={{
                    backgroundColor: 'rgba(20, 24, 34, 0.85)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '12px',
                    padding: '18px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#fae084', marginBottom: '12px' }}>
                    1:1 Square (1080×1080)
                  </span>
                  <div
                    style={{
                      width: '180px',
                      height: '180px',
                      backgroundColor: '#0a0c10',
                      borderRadius: '8px',
                      overflow: 'hidden',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: '12px',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                    }}
                  >
                    {socialOutputs.social_1x1 || galleryPack?.slots[0]?.url ? (
                      <img
                        src={socialOutputs.social_1x1 || galleryPack?.slots[0]?.url}
                        alt="1:1 format"
                        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                      />
                    ) : (
                      <ImageIcon size={32} color="#4b5563" />
                    )}
                  </div>
                  <p style={{ fontSize: '0.72rem', color: '#9ca3af', textAlign: 'center', margin: '0 0 12px 0' }}>
                    Optimized for Instagram Feed and Catalog.
                  </p>
                  {socialOutputs.social_1x1 && (
                    <a
                      href={socialOutputs.social_1x1}
                      download="social_1x1.jpg"
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '6px 14px',
                        backgroundColor: 'rgba(255, 255, 255, 0.08)',
                        color: '#ffffff',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        borderRadius: '6px',
                        textDecoration: 'none',
                      }}
                    >
                      <Download size={13} />
                      Download 1:1
                    </a>
                  )}
                </div>

                {/* 4:5 Portrait Feed */}
                <div
                  style={{
                    backgroundColor: 'rgba(20, 24, 34, 0.85)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '12px',
                    padding: '18px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#a5b4fc', marginBottom: '12px' }}>
                    4:5 Portrait (1080×1350)
                  </span>
                  <div
                    style={{
                      width: '160px',
                      height: '200px',
                      backgroundColor: '#0a0c10',
                      borderRadius: '8px',
                      overflow: 'hidden',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: '12px',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                    }}
                  >
                    {socialOutputs.social_4x5 || galleryPack?.slots[0]?.url ? (
                      <img
                        src={socialOutputs.social_4x5 || galleryPack?.slots[0]?.url}
                        alt="4:5 portrait"
                        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                      />
                    ) : (
                      <ImageIcon size={32} color="#4b5563" />
                    )}
                  </div>
                  <p style={{ fontSize: '0.72rem', color: '#9ca3af', textAlign: 'center', margin: '0 0 12px 0' }}>
                    Maximizes mobile vertical screen space.
                  </p>
                  {socialOutputs.social_4x5 && (
                    <a
                      href={socialOutputs.social_4x5}
                      download="social_4x5.jpg"
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '6px 14px',
                        backgroundColor: 'rgba(255, 255, 255, 0.08)',
                        color: '#ffffff',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        borderRadius: '6px',
                        textDecoration: 'none',
                      }}
                    >
                      <Download size={13} />
                      Download 4:5
                    </a>
                  )}
                </div>

                {/* 9:16 Story / Reel */}
                <div
                  style={{
                    backgroundColor: 'rgba(20, 24, 34, 0.85)',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '12px',
                    padding: '18px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#6ee7b7', marginBottom: '12px' }}>
                    9:16 Story / Reel (1080×1920)
                  </span>
                  <div
                    style={{
                      width: '135px',
                      height: '240px',
                      backgroundColor: '#0a0c10',
                      borderRadius: '8px',
                      overflow: 'hidden',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: '12px',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                    }}
                  >
                    {socialOutputs.social_9x16 || galleryPack?.slots[0]?.url ? (
                      <img
                        src={socialOutputs.social_9x16 || galleryPack?.slots[0]?.url}
                        alt="9:16 story"
                        style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                      />
                    ) : (
                      <ImageIcon size={32} color="#4b5563" />
                    )}
                  </div>
                  <p style={{ fontSize: '0.72rem', color: '#9ca3af', textAlign: 'center', margin: '0 0 12px 0' }}>
                    Full vertical for Instagram Stories & Reels.
                  </p>
                  {socialOutputs.social_9x16 && (
                    <a
                      href={socialOutputs.social_9x16}
                      download="social_9x16.jpg"
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '6px 14px',
                        backgroundColor: 'rgba(255, 255, 255, 0.08)',
                        color: '#ffffff',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        borderRadius: '6px',
                        textDecoration: 'none',
                      }}
                    >
                      <Download size={13} />
                      Download 9:16
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '14px 24px',
            backgroundColor: 'rgba(16, 19, 27, 0.95)',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ fontSize: '0.75rem', color: '#9ca3af', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#10b981' }} />
            <span>Anti-Hallucination Safe • 2048px Master Containment • Slot 1 Guaranteed Cover</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                backgroundColor: 'transparent',
                color: '#e5e7eb',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Close Studio
            </button>
            {activeTab === 'upload_inspect' && (
              <button
                type="button"
                disabled={isProcessing || rawFiles.length === 0}
                onClick={runPipeline}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '8px 20px',
                  borderRadius: '8px',
                  border: 'none',
                  background: rawFiles.length === 0 ? 'rgba(255, 255, 255, 0.1)' : 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                  color: rawFiles.length === 0 ? '#6b7280' : '#0a0c10',
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  cursor: rawFiles.length === 0 ? 'not-allowed' : 'pointer',
                  boxShadow: rawFiles.length === 0 ? 'none' : '0 2px 10px rgba(245, 158, 11, 0.35)',
                }}
              >
                {isProcessing ? (
                  <>
                    <RefreshCw size={15} className="animate-spin" />
                    <span>Generating ({progressPercent}%)...</span>
                  </>
                ) : (
                  <>
                    <Sparkles size={15} />
                    <span>Generate Media Pack</span>
                  </>
                )}
              </button>
            )}
            {activeTab !== 'gallery_builder' && galleryPack && (
              <button
                type="button"
                onClick={() => setActiveTab('gallery_builder')}
                style={{
                  padding: '8px 16px',
                  borderRadius: '8px',
                  border: 'none',
                  backgroundColor: 'rgba(245, 158, 11, 0.2)',
                  color: '#fae084',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                View Recommended Pack →
              </button>
            )}
            {galleryPack && (
              <button
                type="button"
                disabled={isPublishing}
                onClick={handlePublishToShopify}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 22px',
                  borderRadius: '8px',
                  border: 'none',
                  background: isPublishing ? 'rgba(16, 185, 129, 0.5)' : 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                  color: '#ffffff',
                  fontSize: '0.84rem',
                  fontWeight: 700,
                  cursor: isPublishing ? 'not-allowed' : 'pointer',
                  boxShadow: '0 4px 14px rgba(16, 185, 129, 0.35)',
                }}
              >
                {isPublishing ? (
                  <>
                    <RefreshCw size={15} className="animate-spin" />
                    <span>Pushing to Shopify...</span>
                  </>
                ) : (
                  <>
                    <ShoppingBag size={15} />
                    <span>Approve & Push to Shopify</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Full-Screen High-Resolution Slot Preview Lightbox Modal */}
      {previewSlotIndex !== null && galleryPack?.slots && galleryPack.slots[previewSlotIndex] && (() => {
        const slot = galleryPack.slots[previewSlotIndex];
        const displayImgUrl = slot.url || (slot as any).imageUrl || (slot as any).src;
        const isAiSlot =
          slot.isAiGenerated ||
          slot.sourceType === 'ai_model' ||
          slot.sourceType === 'ai_lifestyle' ||
          slot.sourceType === 'AI_MODEL' ||
          slot.slotRole === 'STYLED_SUPPORTING' ||
          (slot.slotRole as string) === 'MODEL_1' ||
          (slot.slotRole as string) === 'MODEL_2_OR_SUPPORTING' ||
          slot.slotRole === 'AI_MODEL_LIFESTYLE_1' ||
          slot.slotRole === 'AI_MODEL_LIFESTYLE_2';

        // Find reference photo (from rawFiles or Slot 1)
        const refPhoto = rawFiles[0]?.dataUrl || (previewSlotIndex !== 0 ? (galleryPack.slots[0]?.url || (galleryPack.slots[0] as any)?.imageUrl) : null);

        return (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 100000,
              backgroundColor: 'rgba(4, 7, 14, 0.96)',
              backdropFilter: 'blur(16px)',
              display: 'flex',
              flexDirection: 'column',
              animation: 'fadeIn 0.15s ease-out',
            }}
          >
            {/* Lightbox Header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 24px',
                borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                backgroundColor: 'rgba(10, 14, 22, 0.85)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <button
                  type="button"
                  onClick={() => {
                    setPreviewSlotIndex(null);
                    setPreviewZoom(1);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    backgroundColor: 'rgba(255, 255, 255, 0.08)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    color: '#e5e7eb',
                    padding: '6px 12px',
                    borderRadius: '8px',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <X size={15} />
                  <span>Close Preview (Esc)</span>
                </button>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span
                    style={{
                      fontSize: '0.92rem',
                      fontWeight: 700,
                      color: slot.isCover ? '#fae084' : '#ffffff',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                    }}
                  >
                    {slot.isCover && <Crown size={15} color="#f59e0b" fill="#f59e0b" />}
                    Slot {slot.slotNumber}: {slot.slotTitle || slot.slotRole.replace(/_/g, ' ')}
                  </span>
                  <span
                    style={{
                      fontSize: '0.68rem',
                      padding: '2px 8px',
                      borderRadius: '12px',
                      backgroundColor: isAiSlot ? 'rgba(79, 70, 229, 0.3)' : 'rgba(16, 185, 129, 0.3)',
                      color: isAiSlot ? '#a5b4fc' : '#6ee7b7',
                      border: isAiSlot ? '1px solid rgba(99, 102, 241, 0.5)' : '1px solid rgba(16, 185, 129, 0.5)',
                      fontWeight: 600,
                    }}
                  >
                    {isAiSlot ? '✨ AI Generated Output' : '📷 Real Photo'}
                  </span>
                  <span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>
                    {slot.dimensions?.width || 2048}×{slot.dimensions?.height || 2048}
                  </span>
                </div>
              </div>

              {/* Header Right Controls: Zoom, Accuracy & Compare */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {/* AI Design Accuracy % Badge & Dropdown */}
                {isAiSlot && (
                  <div style={{ position: 'relative' }}>
                    <button
                      type="button"
                      onClick={() => {
                        if (!accuracyMap[slot.slotNumber] && !isAnalyzingAccuracy) {
                          triggerAccuracyAnalysis(slot.slotNumber, true);
                        } else {
                          setShowAccuracyDetails(!showAccuracyDetails);
                        }
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        backgroundColor: (accuracyMap[slot.slotNumber]?.accuracyScore ?? 0) >= 95
                          ? 'rgba(16, 185, 129, 0.2)'
                          : (accuracyMap[slot.slotNumber]?.accuracyScore ?? 0) >= 90
                          ? 'rgba(245, 158, 11, 0.2)'
                          : 'rgba(99, 102, 241, 0.2)',
                        border: (accuracyMap[slot.slotNumber]?.accuracyScore ?? 0) >= 95
                          ? '1px solid rgba(16, 185, 129, 0.5)'
                          : (accuracyMap[slot.slotNumber]?.accuracyScore ?? 0) >= 90
                          ? '1px solid rgba(245, 158, 11, 0.5)'
                          : '1px solid rgba(99, 102, 241, 0.5)',
                        color: (accuracyMap[slot.slotNumber]?.accuracyScore ?? 0) >= 95
                          ? '#6ee7b7'
                          : (accuracyMap[slot.slotNumber]?.accuracyScore ?? 0) >= 90
                          ? '#fae084'
                          : '#a5b4fc',
                        padding: '6px 12px',
                        borderRadius: '8px',
                        fontSize: '0.76rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                      title="AI Design Accuracy Analysis vs Original Photo"
                    >
                      {isAnalyzingAccuracy ? (
                        <>
                          <RefreshCw size={13} className="animate-spin" />
                          <span>Analyzing Accuracy...</span>
                        </>
                      ) : accuracyMap[slot.slotNumber] ? (
                        <>
                          <ShieldCheck size={14} />
                          <span>{accuracyMap[slot.slotNumber].accuracyScore}% Accurate • Design-Locked</span>
                        </>
                      ) : (
                        <>
                          <ShieldCheck size={14} />
                          <span>Analyse AI Accuracy %</span>
                        </>
                      )}
                    </button>

                    {/* Accuracy Analysis Breakdown Card */}
                    {showAccuracyDetails && accuracyMap[slot.slotNumber] && (() => {
                      const acc = accuracyMap[slot.slotNumber];
                      return (
                        <div
                          style={{
                            position: 'absolute',
                            top: '100%',
                            right: 0,
                            marginTop: '8px',
                            width: '380px',
                            backgroundColor: '#0c121e',
                            border: '1px solid rgba(245, 158, 11, 0.4)',
                            borderRadius: '12px',
                            padding: '16px',
                            boxShadow: '0 16px 40px rgba(0, 0, 0, 0.85)',
                            zIndex: 100010,
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', borderBottom: '1px solid rgba(255, 255, 255, 0.1)', paddingBottom: '8px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <ShieldCheck size={16} color="#fae084" />
                              <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#fae084' }}>
                                AI Design Fidelity Report
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => setShowAccuracyDetails(false)}
                              style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer' }}
                            >
                              <X size={14} />
                            </button>
                          </div>

                          {/* Score Header */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '14px', backgroundColor: 'rgba(255, 255, 255, 0.04)', padding: '10px 14px', borderRadius: '8px' }}>
                            <div style={{
                              fontSize: '1.8rem',
                              fontWeight: 800,
                              color: acc.accuracyScore >= 95 ? '#6ee7b7' : '#fae084',
                              minWidth: '65px',
                              textAlign: 'center',
                            }}>
                              {acc.accuracyScore}%
                            </div>
                            <div>
                              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#f3f4f6' }}>
                                {acc.accuracyScore >= 95 ? 'Design-Lock Target Met (>=95%)' : 'Good Match (Design-Locked)'}
                              </div>
                              <div style={{ fontSize: '0.7rem', color: '#9ca3af', marginTop: '2px', lineHeight: 1.3 }}>
                                {acc.summary}
                              </div>
                            </div>
                          </div>

                          {/* Fidelity Breakdown Bars */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
                            {[
                              { label: '🔗 Chain & Structure Fidelity', val: acc.breakdown.structureFidelity },
                              { label: '💎 Stone Setting & Pavé', val: acc.breakdown.stoneSettingFidelity },
                              { label: '✨ Metal Karat Tone & Polish', val: acc.breakdown.metalToneFidelity },
                              { label: '📐 Scale, Drape & Proportions', val: acc.breakdown.proportionsFidelity },
                            ].map((item, idx) => (
                              <div key={idx}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: '#d1d5db', marginBottom: '3px' }}>
                                  <span>{item.label}</span>
                                  <span style={{ fontWeight: 700, color: item.val >= 95 ? '#6ee7b7' : '#fae084' }}>{item.val}%</span>
                                </div>
                                <div style={{ height: '5px', backgroundColor: 'rgba(255, 255, 255, 0.1)', borderRadius: '3px', overflow: 'hidden' }}>
                                  <div
                                    style={{
                                      width: `${item.val}%`,
                                      height: '100%',
                                      backgroundColor: item.val >= 95 ? '#10b981' : '#f59e0b',
                                      borderRadius: '3px',
                                      transition: 'width 0.4s ease',
                                    }}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>

                          {/* Highlights */}
                          {acc.matchHighlights && acc.matchHighlights.length > 0 && (
                            <div style={{ marginBottom: '12px', fontSize: '0.7rem', color: '#9ca3af' }}>
                              <div style={{ fontWeight: 600, color: '#d1d5db', marginBottom: '4px' }}>Match Highlights:</div>
                              <ul style={{ margin: 0, paddingLeft: '16px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                {acc.matchHighlights.map((hl, i) => (
                                  <li key={i} style={{ color: '#6ee7b7' }}>
                                    <span style={{ color: '#d1d5db' }}>{hl}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}

                          {/* Re-analyze Button */}
                          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', borderTop: '1px solid rgba(255, 255, 255, 0.08)', paddingTop: '10px' }}>
                            <button
                              type="button"
                              onClick={() => triggerAccuracyAnalysis(slot.slotNumber, true)}
                              disabled={isAnalyzingAccuracy}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                                backgroundColor: 'rgba(245, 158, 11, 0.15)',
                                border: '1px solid rgba(245, 158, 11, 0.4)',
                                color: '#fae084',
                                padding: '5px 10px',
                                borderRadius: '6px',
                                fontSize: '0.72rem',
                                fontWeight: 600,
                                cursor: 'pointer',
                              }}
                            >
                              <RefreshCw size={12} className={isAnalyzingAccuracy ? 'animate-spin' : ''} />
                              <span>Re-Analyze Accuracy</span>
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {isAiSlot && refPhoto && (
                  <button
                    type="button"
                    onClick={() => setShowComparison(!showComparison)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      backgroundColor: showComparison ? 'rgba(245, 158, 11, 0.25)' : 'rgba(255, 255, 255, 0.08)',
                      border: showComparison ? '1px solid #f59e0b' : '1px solid rgba(255, 255, 255, 0.15)',
                      color: showComparison ? '#fae084' : '#e5e7eb',
                      padding: '6px 12px',
                      borderRadius: '8px',
                      fontSize: '0.76rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    <Split size={14} />
                    <span>{showComparison ? 'Exit Split View' : 'Compare with Real Photo'}</span>
                  </button>
                )}

                {/* Zoom Controls */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '2px',
                    backgroundColor: 'rgba(0, 0, 0, 0.5)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    borderRadius: '8px',
                    padding: '2px',
                  }}
                >
                  <button
                    type="button"
                    disabled={previewZoom <= 1}
                    onClick={() => setPreviewZoom((z) => Math.max(1, z - 0.5))}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: previewZoom <= 1 ? '#4b5563' : '#e5e7eb',
                      padding: '5px 8px',
                      cursor: previewZoom <= 1 ? 'not-allowed' : 'pointer',
                    }}
                    title="Zoom Out"
                  >
                    <ZoomOut size={14} />
                  </button>
                  <span style={{ fontSize: '0.74rem', color: '#fae084', fontWeight: 600, minWidth: '42px', textAlign: 'center' }}>
                    {Math.round(previewZoom * 100)}%
                  </span>
                  <button
                    type="button"
                    disabled={previewZoom >= 3}
                    onClick={() => setPreviewZoom((z) => Math.min(3, z + 0.5))}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: previewZoom >= 3 ? '#4b5563' : '#e5e7eb',
                      padding: '5px 8px',
                      cursor: previewZoom >= 3 ? 'not-allowed' : 'pointer',
                    }}
                    title="Zoom In"
                  >
                    <ZoomIn size={14} />
                  </button>
                  {previewZoom > 1 && (
                    <button
                      type="button"
                      onClick={() => setPreviewZoom(1)}
                      style={{
                        background: 'rgba(255, 255, 255, 0.1)',
                        border: 'none',
                        color: '#9ca3af',
                        padding: '3px 6px',
                        borderRadius: '4px',
                        fontSize: '0.68rem',
                        cursor: 'pointer',
                        marginLeft: '4px',
                      }}
                    >
                      Reset
                    </button>
                  )}
                </div>

                {/* Include in Shopify Toggle */}
                <button
                  type="button"
                  onClick={() => toggleIncludeSlot(previewSlotIndex)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    backgroundColor: slot.included !== false ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                    border: slot.included !== false ? '1px solid rgba(16, 185, 129, 0.4)' : '1px solid rgba(239, 68, 68, 0.4)',
                    color: slot.included !== false ? '#6ee7b7' : '#fca5a5',
                    padding: '6px 12px',
                    borderRadius: '8px',
                    fontSize: '0.76rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {slot.included !== false ? <Check size={13} /> : <EyeOff size={13} />}
                  <span>{slot.included !== false ? 'Included in Shopify' : 'Excluded from Push'}</span>
                </button>
              </div>
            </div>

            {/* Scroll Navigation & Inspection Sub-Toolbar */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '7px 24px',
                backgroundColor: 'rgba(9, 14, 24, 0.9)',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                fontSize: '0.75rem',
                flexWrap: 'wrap',
                gap: '8px',
              }}
            >
              {/* Left: Quick scroll jump options */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: '#9ca3af', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                  ↕️ Scroll & Inspect:
                </span>
                <button
                  type="button"
                  onClick={() => scrollToPosition('top')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    backgroundColor: 'rgba(255, 255, 255, 0.08)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    color: '#e5e7eb',
                    padding: '3px 9px',
                    borderRadius: '5px',
                    cursor: 'pointer',
                    fontSize: '0.72rem',
                    fontWeight: 500,
                  }}
                  title="Scroll to top of piece (clasp/hook)"
                >
                  <ArrowUp size={12} /> Clasp / Top
                </button>
                <button
                  type="button"
                  onClick={() => scrollToPosition('center')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    backgroundColor: 'rgba(255, 255, 255, 0.08)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    color: '#e5e7eb',
                    padding: '3px 9px',
                    borderRadius: '5px',
                    cursor: 'pointer',
                    fontSize: '0.72rem',
                    fontWeight: 500,
                  }}
                  title="Scroll to center of piece"
                >
                  Center
                </button>
                <button
                  type="button"
                  onClick={() => scrollToPosition('bottom')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    backgroundColor: 'rgba(255, 255, 255, 0.08)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    color: '#e5e7eb',
                    padding: '3px 9px',
                    borderRadius: '5px',
                    cursor: 'pointer',
                    fontSize: '0.72rem',
                    fontWeight: 500,
                  }}
                  title="Scroll down to inspect pendant / bottom"
                >
                  <ArrowDown size={12} /> Pendant / Bottom
                </button>
                <span style={{ fontSize: '0.68rem', color: '#6b7280', marginLeft: '6px' }}>
                  (Use mouse wheel, trackpad, or scrollbars to scroll up & down)
                </span>
              </div>

              {/* Right: Sync scrolling toggle & zoom info */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                {showComparison && refPhoto && (
                  <button
                    type="button"
                    onClick={() => setSyncScroll(!syncScroll)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      backgroundColor: syncScroll ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.06)',
                      border: syncScroll ? '1px solid rgba(59, 130, 246, 0.5)' : '1px solid rgba(255, 255, 255, 0.12)',
                      color: syncScroll ? '#93c5fd' : '#9ca3af',
                      padding: '3px 8px',
                      borderRadius: '5px',
                      cursor: 'pointer',
                      fontSize: '0.72rem',
                      fontWeight: 600,
                    }}
                    title="When active, scrolling the real photo or AI output scrolls both together"
                  >
                    <span>{syncScroll ? '🔗 Sync Scrolling: ON' : '🔓 Sync Scrolling: OFF'}</span>
                  </button>
                )}
                <span style={{ color: '#9ca3af', fontSize: '0.72rem' }}>
                  Inspection Zoom: <b style={{ color: '#fae084' }}>{Math.round(previewZoom * 100)}%</b>
                </span>
              </div>
            </div>

            {/* Lightbox Center Content with Navigation */}
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
                overflow: 'hidden',
                padding: '16px',
              }}
            >
              {/* Previous Slot Arrow */}
              <button
                type="button"
                onClick={() => {
                  setPreviewSlotIndex(previewSlotIndex > 0 ? previewSlotIndex - 1 : galleryPack.slots.length - 1);
                  setPreviewZoom(1);
                }}
                style={{
                  position: 'absolute',
                  left: '24px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  zIndex: 20,
                  backgroundColor: 'rgba(0, 0, 0, 0.75)',
                  border: '1px solid rgba(255, 255, 255, 0.25)',
                  color: '#ffffff',
                  width: '46px',
                  height: '46px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
                }}
                title="Previous Slot (Left Arrow)"
              >
                <ChevronLeft size={24} />
              </button>

              {/* Image View Area */}
              {showComparison && refPhoto ? (
                /* Split Comparison View */
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '20px',
                    width: '100%',
                    maxWidth: '1200px',
                    height: 'calc(100vh - 240px)',
                  }}
                >
                  {/* Original Real Photo */}
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      backgroundColor: '#0a0d14',
                      borderRadius: '12px',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      overflow: 'hidden',
                      height: '100%',
                    }}
                  >
                    <div style={{ padding: '8px 14px', backgroundColor: 'rgba(0, 0, 0, 0.5)', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', fontSize: '0.78rem', color: '#9ca3af', fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>📷 Original Reference Photo</span>
                      <span style={{ fontSize: '0.68rem', color: '#6b7280' }}>Scrollable Viewport</span>
                    </div>
                    <div
                      ref={leftScrollRef}
                      onScroll={handleLeftScroll}
                      style={{
                        flex: 1,
                        overflow: 'auto',
                        padding: '16px',
                        display: 'flex',
                        alignItems: previewZoom > 1 ? 'flex-start' : 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <img
                        src={refPhoto}
                        alt="Original reference"
                        style={{
                          width: previewZoom > 1 ? `${previewZoom * 100}%` : 'auto',
                          maxWidth: previewZoom > 1 ? 'none' : '100%',
                          maxHeight: previewZoom > 1 ? 'none' : '100%',
                          objectFit: 'contain',
                        }}
                      />
                    </div>
                  </div>

                  {/* Generated Output */}
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      backgroundColor: '#0a0d14',
                      borderRadius: '12px',
                      border: '1px solid rgba(245, 158, 11, 0.35)',
                      overflow: 'hidden',
                      height: '100%',
                    }}
                  >
                    <div style={{ padding: '8px 14px', backgroundColor: 'rgba(245, 158, 11, 0.1)', borderBottom: '1px solid rgba(245, 158, 11, 0.2)', fontSize: '0.78rem', color: '#fae084', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span>✨ Output: Slot {slot.slotNumber} ({slot.slotRole.replace(/_/g, ' ')})</span>
                      <span style={{ fontSize: '0.7rem', color: '#9ca3af' }}>Scroll up/down to inspect clasp & pendant</span>
                    </div>
                    <div
                      ref={rightScrollRef}
                      onScroll={handleRightScroll}
                      style={{
                        flex: 1,
                        overflow: 'auto',
                        padding: '16px',
                        display: 'flex',
                        alignItems: previewZoom > 1 ? 'flex-start' : 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <img
                        src={displayImgUrl}
                        alt={slot.altText || `Slot ${slot.slotNumber}`}
                        style={{
                          width: previewZoom > 1 ? `${previewZoom * 100}%` : 'auto',
                          maxWidth: previewZoom > 1 ? 'none' : '100%',
                          maxHeight: previewZoom > 1 ? 'none' : '100%',
                          objectFit: 'contain',
                          cursor: previewZoom > 1 ? 'zoom-out' : 'zoom-in',
                        }}
                        onClick={() => setPreviewZoom(previewZoom === 1 ? 2 : 1)}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                /* Single Fullscreen High-Res Image View */
                <div
                  ref={singleScrollRef}
                  style={{
                    width: '100%',
                    height: 'calc(100vh - 240px)',
                    display: 'flex',
                    alignItems: previewZoom > 1 ? 'flex-start' : 'center',
                    justifyContent: 'center',
                    overflow: 'auto',
                    padding: '24px',
                  }}
                >
                  <img
                    src={displayImgUrl}
                    alt={slot.altText || `Slot ${slot.slotNumber}`}
                    style={{
                      width: previewZoom > 1 ? `${previewZoom * 90}%` : 'auto',
                      maxWidth: previewZoom > 1 ? 'none' : '92%',
                      maxHeight: previewZoom > 1 ? 'none' : '92%',
                      objectFit: 'contain',
                      borderRadius: '8px',
                      boxShadow: '0 8px 36px rgba(0, 0, 0, 0.85)',
                      cursor: previewZoom === 1 ? 'zoom-in' : 'zoom-out',
                    }}
                    onClick={() => setPreviewZoom(previewZoom === 1 ? 2 : 1)}
                    title={previewZoom === 1 ? 'Click to zoom 2x (scrollable)' : 'Click to reset zoom'}
                  />
                </div>
              )}

              {/* Next Slot Arrow */}
              <button
                type="button"
                onClick={() => {
                  setPreviewSlotIndex(previewSlotIndex < galleryPack.slots.length - 1 ? previewSlotIndex + 1 : 0);
                  setPreviewZoom(1);
                }}
                style={{
                  position: 'absolute',
                  right: '24px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  zIndex: 20,
                  backgroundColor: 'rgba(0, 0, 0, 0.75)',
                  border: '1px solid rgba(255, 255, 255, 0.25)',
                  color: '#ffffff',
                  width: '46px',
                  height: '46px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
                }}
                title="Next Slot (Right Arrow)"
              >
                <ChevronRight size={24} />
              </button>
            </div>

            {/* Lightbox Footer Strip: Thumbnails & Quick Actions */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 24px',
                backgroundColor: 'rgba(10, 14, 22, 0.95)',
                borderTop: '1px solid rgba(255, 255, 255, 0.1)',
                gap: '16px',
              }}
            >
              {/* Slot Thumbnails Strip */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflowX: 'auto', padding: '4px' }}>
                {galleryPack.slots.map((s, sIdx) => {
                  const sUrl = s.url || (s as any).imageUrl || (s as any).src;
                  const isSelected = sIdx === previewSlotIndex;
                  return (
                    <button
                      key={s.mediaAssetId || sIdx}
                      type="button"
                      onClick={() => {
                        setPreviewSlotIndex(sIdx);
                        setPreviewZoom(1);
                      }}
                      style={{
                        position: 'relative',
                        width: '52px',
                        height: '52px',
                        borderRadius: '6px',
                        overflow: 'hidden',
                        border: isSelected ? '2px solid #f59e0b' : '1px solid rgba(255, 255, 255, 0.15)',
                        backgroundColor: '#0a0c10',
                        cursor: 'pointer',
                        padding: 0,
                        opacity: s.included === false ? 0.4 : isSelected ? 1 : 0.7,
                        transform: isSelected ? 'scale(1.08)' : 'scale(1)',
                        transition: 'all 0.15s ease',
                      }}
                      title={`Slot ${s.slotNumber}: ${s.slotRole.replace(/_/g, ' ')}`}
                    >
                      {sUrl ? (
                        <img src={sUrl} alt={`Slot ${s.slotNumber}`} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                      ) : (
                        <div style={{ color: '#6b7280', fontSize: '0.6rem', textAlign: 'center', paddingTop: '16px' }}>Slot {s.slotNumber}</div>
                      )}
                      <span
                        style={{
                          position: 'absolute',
                          bottom: 0,
                          left: 0,
                          right: 0,
                          backgroundColor: 'rgba(0, 0, 0, 0.75)',
                          color: isSelected ? '#fae084' : '#ffffff',
                          fontSize: '0.58rem',
                          fontWeight: 700,
                          textAlign: 'center',
                          padding: '1px 0',
                        }}
                      >
                        {s.slotNumber}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Action Buttons for Current Slot */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {/* Background Switcher for Photo / Cover Slots */}
                {(!isAiSlot || slot.slotNumber === 1 || slot.isCover || slot.originalUrl) && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', backgroundColor: 'rgba(255, 255, 255, 0.05)', padding: '4px 6px', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.1)' }}>
                    <span style={{ fontSize: '0.68rem', color: '#9ca3af', fontWeight: 600, marginRight: '2px' }}>BG:</span>
                    <button
                      type="button"
                      disabled={cleaningSlotBg === slot.slotNumber}
                      onClick={() => handleToggleSlotBgMode(slot.slotNumber, 'original')}
                      style={{
                        padding: '4px 8px',
                        fontSize: '0.68rem',
                        fontWeight: 600,
                        borderRadius: '4px',
                        border: (slotBgMode[slot.slotNumber] || slot.currentBgMode || 'original') === 'original' ? '1px solid #10b981' : '1px solid rgba(255, 255, 255, 0.1)',
                        backgroundColor: (slotBgMode[slot.slotNumber] || slot.currentBgMode || 'original') === 'original' ? 'rgba(16, 185, 129, 0.25)' : 'transparent',
                        color: (slotBgMode[slot.slotNumber] || slot.currentBgMode || 'original') === 'original' ? '#34d399' : '#9ca3af',
                        cursor: 'pointer',
                      }}
                      title="Keep original background"
                    >
                      📷 Original
                    </button>
                    <button
                      type="button"
                      disabled={cleaningSlotBg === slot.slotNumber}
                      onClick={() => handleToggleSlotBgMode(slot.slotNumber, 'white')}
                      style={{
                        padding: '4px 8px',
                        fontSize: '0.68rem',
                        fontWeight: 600,
                        borderRadius: '4px',
                        border: (slotBgMode[slot.slotNumber] || slot.currentBgMode) === 'white' ? '1px solid #fae084' : '1px solid rgba(255, 255, 255, 0.1)',
                        backgroundColor: (slotBgMode[slot.slotNumber] || slot.currentBgMode) === 'white' ? 'rgba(245, 158, 11, 0.25)' : 'transparent',
                        color: (slotBgMode[slot.slotNumber] || slot.currentBgMode) === 'white' ? '#fae084' : '#9ca3af',
                        cursor: 'pointer',
                      }}
                      title="Pure white background (#FFFFFF) for Shopify"
                    >
                      ⚪ Pure White
                    </button>
                    <button
                      type="button"
                      disabled={cleaningSlotBg === slot.slotNumber}
                      onClick={() => handleToggleSlotBgMode(slot.slotNumber, 'transparent')}
                      style={{
                        padding: '4px 8px',
                        fontSize: '0.68rem',
                        fontWeight: 600,
                        borderRadius: '4px',
                        border: (slotBgMode[slot.slotNumber] || slot.currentBgMode) === 'transparent' ? '1px solid #60a5fa' : '1px solid rgba(255, 255, 255, 0.1)',
                        backgroundColor: (slotBgMode[slot.slotNumber] || slot.currentBgMode) === 'transparent' ? 'rgba(59, 130, 246, 0.25)' : 'transparent',
                        color: (slotBgMode[slot.slotNumber] || slot.currentBgMode) === 'transparent' ? '#93c5fd' : '#9ca3af',
                        cursor: 'pointer',
                      }}
                      title="Transparent cutout (No background)"
                    >
                      🏁 No BG (PNG)
                    </button>
                  </div>
                )}

                {/* Make Cover Button */}
                {!slot.isCover && (
                  <button
                    type="button"
                    onClick={() => {
                      const reordered = [...galleryPack.slots];
                      const [moved] = reordered.splice(previewSlotIndex, 1);
                      reordered.unshift(moved);
                      const updated = reordered.map((s, sIdx) => ({
                        ...s,
                        slotNumber: sIdx + 1,
                        isCover: sIdx === 0,
                        slotRole: sIdx === 0 ? 'HERO_COVER' : s.slotRole,
                      }));
                      setGalleryPack({ ...galleryPack, slots: updated as any });
                      setPreviewSlotIndex(0);
                    }}
                    style={{
                      padding: '7px 12px',
                      backgroundColor: 'rgba(245, 158, 11, 0.15)',
                      border: '1px solid rgba(245, 158, 11, 0.35)',
                      color: '#fae084',
                      borderRadius: '6px',
                      fontSize: '0.74rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                    }}
                  >
                    <Crown size={13} />
                    <span>Set as Cover</span>
                  </button>
                )}

                {/* Regenerate AI Slot */}
                {isAiSlot && (
                  <button
                    type="button"
                    disabled={regeneratingSlot === slot.slotNumber}
                    onClick={() =>
                      handleRegenerateSlot(
                        slot.slotNumber,
                        slot.styledOption || slot2Style,
                        slot.modelPresetKey || selectedPreset,
                        undefined,
                        slotAiProvider[slot.slotNumber] || selectedAiProvider,
                        slotCustomPrompts[slot.slotNumber] !== undefined ? slotCustomPrompts[slot.slotNumber] : getDefaultPromptForSlot(slot.slotNumber, slot.slotRole)
                      )
                    }
                    style={{
                      padding: '7px 14px',
                      backgroundColor: 'rgba(79, 70, 229, 0.25)',
                      border: '1px solid rgba(99, 102, 241, 0.5)',
                      color: '#c7d2fe',
                      borderRadius: '6px',
                      fontSize: '0.74rem',
                      fontWeight: 600,
                      cursor: regeneratingSlot === slot.slotNumber ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                  >
                    <RefreshCw size={13} className={regeneratingSlot === slot.slotNumber ? 'animate-spin' : ''} />
                    <span>{regeneratingSlot === slot.slotNumber ? 'Regenerating...' : 'Regenerate Output'}</span>
                  </button>
                )}

                {/* Download High-Res */}
                {displayImgUrl && (
                  <a
                    href={displayImgUrl}
                    download={`slot_${slot.slotNumber}_${product?.sku || 'jewelry'}.jpg`}
                    style={{
                      padding: '7px 12px',
                      backgroundColor: 'rgba(255, 255, 255, 0.08)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      color: '#e5e7eb',
                      borderRadius: '6px',
                      fontSize: '0.74rem',
                      fontWeight: 600,
                      textDecoration: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      cursor: 'pointer',
                    }}
                  >
                    <Download size={13} />
                    <span>Save Image</span>
                  </a>
                )}

                {/* Delete Slot Button */}
                <button
                  type="button"
                  onClick={() => {
                    const nextIdx = previewSlotIndex > 0 ? previewSlotIndex - 1 : 0;
                    deleteSlot(previewSlotIndex);
                    if (galleryPack.slots.length <= 1) {
                      setPreviewSlotIndex(null);
                    } else {
                      setPreviewSlotIndex(nextIdx);
                    }
                  }}
                  style={{
                    padding: '7px 12px',
                    backgroundColor: 'rgba(239, 68, 68, 0.18)',
                    border: '1px solid rgba(239, 68, 68, 0.4)',
                    color: '#f87171',
                    borderRadius: '6px',
                    fontSize: '0.74rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                  }}
                  title="Delete this slot from gallery pack"
                >
                  <Trash2 size={13} />
                  <span>Delete</span>
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Full-Screen Preview for Step 1 Raw Photo */}
      {previewRawFileId !== null && (() => {
        const rawFile = rawFiles.find((f) => f.id === previewRawFileId);
        if (!rawFile) return null;

        return (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 100000,
              backgroundColor: 'rgba(4, 7, 14, 0.96)',
              backdropFilter: 'blur(16px)',
              display: 'flex',
              flexDirection: 'column',
              animation: 'fadeIn 0.15s ease-out',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 24px',
                borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                backgroundColor: 'rgba(10, 14, 22, 0.85)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <button
                  type="button"
                  onClick={() => {
                    setPreviewRawFileId(null);
                    setPreviewZoom(1);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    backgroundColor: 'rgba(255, 255, 255, 0.08)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    color: '#e5e7eb',
                    padding: '6px 12px',
                    borderRadius: '8px',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <X size={15} />
                  <span>Close Preview (Esc)</span>
                </button>
                <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#ffffff' }}>
                  📷 {rawFile.name}
                </span>
                {aiReferenceFileId === rawFile.id && (
                  <span
                    style={{
                      fontSize: '0.68rem',
                      padding: '2px 8px',
                      borderRadius: '12px',
                      backgroundColor: 'rgba(245, 158, 11, 0.25)',
                      color: '#fae084',
                      border: '1px solid rgba(245, 158, 11, 0.4)',
                      fontWeight: 600,
                    }}
                  >
                    ★ Primary AI Reference
                  </span>
                )}
              </div>

              {/* Zoom Controls */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '2px',
                    backgroundColor: 'rgba(0, 0, 0, 0.5)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    borderRadius: '8px',
                    padding: '2px',
                  }}
                >
                  <button
                    type="button"
                    disabled={previewZoom <= 1}
                    onClick={() => setPreviewZoom((z) => Math.max(1, z - 0.5))}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: previewZoom <= 1 ? '#4b5563' : '#e5e7eb',
                      padding: '5px 8px',
                      cursor: previewZoom <= 1 ? 'not-allowed' : 'pointer',
                    }}
                    title="Zoom Out"
                  >
                    <ZoomOut size={14} />
                  </button>
                  <span style={{ fontSize: '0.74rem', color: '#fae084', fontWeight: 600, minWidth: '42px', textAlign: 'center' }}>
                    {Math.round(previewZoom * 100)}%
                  </span>
                  <button
                    type="button"
                    disabled={previewZoom >= 3}
                    onClick={() => setPreviewZoom((z) => Math.min(3, z + 0.5))}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: previewZoom >= 3 ? '#4b5563' : '#e5e7eb',
                      padding: '5px 8px',
                      cursor: previewZoom >= 3 ? 'not-allowed' : 'pointer',
                    }}
                    title="Zoom In"
                  >
                    <ZoomIn size={14} />
                  </button>
                  {previewZoom > 1 && (
                    <button
                      type="button"
                      onClick={() => setPreviewZoom(1)}
                      style={{
                        background: 'rgba(255, 255, 255, 0.1)',
                        border: 'none',
                        color: '#9ca3af',
                        padding: '3px 6px',
                        borderRadius: '4px',
                        fontSize: '0.68rem',
                        cursor: 'pointer',
                        marginLeft: '4px',
                      }}
                    >
                      Reset
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => setAiReferenceFileId(rawFile.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    backgroundColor: aiReferenceFileId === rawFile.id ? 'rgba(245, 158, 11, 0.25)' : 'rgba(255, 255, 255, 0.08)',
                    border: aiReferenceFileId === rawFile.id ? '1px solid #f59e0b' : '1px solid rgba(255, 255, 255, 0.15)',
                    color: aiReferenceFileId === rawFile.id ? '#fae084' : '#e5e7eb',
                    padding: '6px 12px',
                    borderRadius: '8px',
                    fontSize: '0.76rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <Star size={13} />
                  <span>{aiReferenceFileId === rawFile.id ? '★ Selected as AI Reference' : 'Use as AI Reference'}</span>
                </button>
              </div>
            </div>

            {/* Center Image */}
            <div
              ref={rawFileScrollRef}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: previewZoom > 1 ? 'flex-start' : 'center',
                justifyContent: 'center',
                overflow: 'auto',
                padding: '24px',
              }}
            >
              <img
                src={rawFile.dataUrl}
                alt={rawFile.name}
                style={{
                  width: previewZoom > 1 ? `${previewZoom * 90}%` : 'auto',
                  maxWidth: previewZoom > 1 ? 'none' : '90%',
                  maxHeight: previewZoom > 1 ? 'none' : '90%',
                  objectFit: 'contain',
                  borderRadius: '8px',
                  boxShadow: '0 8px 36px rgba(0, 0, 0, 0.85)',
                  cursor: previewZoom === 1 ? 'zoom-in' : 'zoom-out',
                }}
                onClick={() => setPreviewZoom(previewZoom === 1 ? 2 : 1)}
                title={previewZoom === 1 ? 'Click to zoom 2x (scrollable)' : 'Click to reset zoom'}
              />
            </div>
          </div>
        );
      })()}

      {/* Dedicated Interactive Non-Destructive Crop Modal */}
      {cropModalState && cropModalState.isOpen && (
        <CropEditorModal
          isOpen={cropModalState.isOpen}
          onClose={() => setCropModalState(null)}
          imageUrl={cropModalState.imageUrl}
          imageBase64={cropModalState.imageBase64}
          title={cropModalState.title}
          onApplyCrop={(result) => handleApplyCropResult(cropModalState.slotNumber, result)}
        />
      )}

      {/* Dedicated Side-by-Side Visual Consistency Review Modal */}
      {sideBySideState && sideBySideState.isOpen && (
        <SideBySideReviewModal
          isOpen={sideBySideState.isOpen}
          onClose={() => setSideBySideState(null)}
          originalImageUrl={sideBySideState.originalUrl}
          generatedImageUrl={sideBySideState.generatedUrl}
          productTitle={sideBySideState.productTitle}
          slotTitle={sideBySideState.slotTitle}
          onApprove={() => {
            setSideBySideState(null);
          }}
          onRegenerate={() => {
            const sNum = sideBySideState.slotNumber;
            setSideBySideState(null);
            handleRegenerateSlot(sNum);
          }}
          onReject={() => {
            const sNum = sideBySideState.slotNumber;
            setSideBySideState(null);
            handleToggleSlotBgMode(sNum, 'original');
          }}
        />
      )}
    </div>
  );

  return createPortal(modalContent, document.body);
};
