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
} from 'lucide-react';
import type { JewelryItem } from '../types/inventory';
import type { GalleryPack, StylingPreset, StyledSlot2Option } from '../types/media';
import {
  fetchMediaPresets,
  generateMediaPack,
  regeneratePackSlot,
  publishPackToShopify,
  fetchMediaJobStatus,
  analyzeMediaAccuracy,
  type AiAccuracyAnalysis,
} from '../services/mediaService';
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

  // Load presets on open
  useEffect(() => {
    if (isOpen) {
      fetchMediaPresets().then((list) => {
        if (list && list.length > 0) {
          setPresets(list);
          if (!selectedPreset) setSelectedPreset(list[0].id);
        }
      });
      // If product has existing images, pre-populate if empty
      if (product && rawFiles.length === 0 && (product.imageUrl || (product as any).primaryImageUrl)) {
        const primary = product.imageUrl || (product as any).primaryImageUrl;
        if (primary) {
          setRawFiles([
            {
              id: 'existing-hero',
              name: `${product.sku || 'product'}-hero.jpg`,
              size: 0,
              dataUrl: primary,
              isMobile9x16: false,
            },
          ]);
          setAiReferenceFileId('existing-hero');
        }
      }
    }
  }, [isOpen, product]);

  if (!isOpen) return null;

  // File drop / select handler
  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const maxFiles = 20;
    const countToTake = Math.min(files.length, maxFiles - rawFiles.length);

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
            if (!aiReferenceFileId && prev.length === 0) {
              setAiReferenceFileId(newId);
            }
            return [
              ...prev,
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

  const anyAiSelected = enableStyledSlot2 || enableModelSlot4 || enableLifestyleSlot5;

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
      enableStyledSlot2,
      enableModelGeneration: anyAiSelected,
      enableModelSlot4,
      enableLifestyleSlot5,
      customPrompt: customPrompt.trim() || undefined,
      customPromptSlot2: step1PromptSlot2.trim() || undefined,
      customPromptSlot4: step1PromptSlot4.trim() || undefined,
      customPromptSlot5: step1PromptSlot5.trim() || undefined,
      approvalMode,
      autoPushShopify: approvalMode === 'FULL_AUTO',
      aiReferenceFileId: aiReferenceFileId || rawFiles[0]?.id,
      aiProvider: selectedAiProvider,
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
          setProcessingStep(enableStyledSlot2 ? 'Styling Slot 2 supporting presentation...' : 'Processing real photo angles...');
          return 65;
        } else if (prev < 85) {
          setProcessingStep(enableModelSlot4 ? 'Generating fashion model fit...' : 'Composing multi-angle views...');
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
                setGalleryPack(job.result_summary.galleryPack);
                setPipelineWarnings(job.result_summary.galleryPack.warnings || []);
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
        setGalleryPack(res.galleryPack);
        setPipelineWarnings(res.galleryPack.warnings || []);
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

    const temp = slots[indexA];
    slots[indexA] = slots[indexB];
    slots[indexB] = temp;

    const updated = slots.map((s, idx) => ({
      ...s,
      slotNumber: idx + 1,
      isCover: idx === 0,
      slotRole: idx === 0 ? ('HERO_COVER' as const) : s.slotRole === 'HERO_COVER' ? ('ALT_ANGLE' as const) : s.slotRole,
    }));

    setGalleryPack({
      ...galleryPack,
      slots: updated,
    });
  };

  // Set explicit slot as Hero Cover (moves to slot 1)
  const setSlotAsCover = (slotIdx: number) => {
    if (!galleryPack || slotIdx === 0) return;
    const slots = [...galleryPack.slots];
    const [picked] = slots.splice(slotIdx, 1);
    slots.unshift(picked);

    const updated = slots.map((s, idx) => ({
      ...s,
      slotNumber: idx + 1,
      isCover: idx === 0,
      slotRole: idx === 0 ? ('HERO_COVER' as const) : s.slotRole === 'HERO_COVER' ? ('ALT_ANGLE' as const) : s.slotRole,
    }));

    setGalleryPack({
      ...galleryPack,
      slots: updated,
    });
  };

  // Update SEO Alt text
  const updateSlotAltText = (slotIdx: number, newAlt: string) => {
    if (!galleryPack) return;
    const slots = [...galleryPack.slots];
    slots[slotIdx] = { ...slots[slotIdx], altText: newAlt };
    setGalleryPack({ ...galleryPack, slots });
  };

  // Delete slot from gallery pack
  const deleteSlot = (slotIdx: number) => {
    if (!galleryPack) return;
    if (galleryPack.slots.length <= 1) {
      alert('You must keep at least 1 image in the gallery pack.');
      return;
    }
    const remaining = galleryPack.slots.filter((_, idx) => idx !== slotIdx);
    const updated = remaining.map((s, idx) => ({
      ...s,
      slotNumber: idx + 1,
      isCover: idx === 0,
      slotRole: idx === 0 ? ('HERO_COVER' as const) : s.slotRole === 'HERO_COVER' ? ('ALT_ANGLE' as const) : s.slotRole,
    }));
    setGalleryPack({
      ...galleryPack,
      slots: updated,
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
      setGalleryPack({ ...galleryPack, slots: updated });
      return;
    }

    if (mode === 'white' && targetSlot.cleanCoverUrl) {
      const updated = galleryPack.slots.map((s) =>
        s.slotNumber === slotNumber ? { ...s, url: targetSlot.cleanCoverUrl!, imageUrl: targetSlot.cleanCoverUrl!, currentBgMode: 'white' as const } : s
      );
      setGalleryPack({ ...galleryPack, slots: updated });
      return;
    }

    if (mode === 'transparent' && targetSlot.transparentUrl) {
      const updated = galleryPack.slots.map((s) =>
        s.slotNumber === slotNumber ? { ...s, url: targetSlot.transparentUrl!, imageUrl: targetSlot.transparentUrl!, currentBgMode: 'transparent' as const } : s
      );
      setGalleryPack({ ...galleryPack, slots: updated });
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
                currentBgMode: mode,
              }
            : s
        );
        setGalleryPack({ ...galleryPack, slots: updated });
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

    // Filter to only included slots
    const activeSlots = galleryPack.slots.filter((s) => s.included !== false);
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
          'Warning: Slot 1 (Cover) and Slot 2 (Styled) currently share identical images.\n\nSlot 1 must be a clean commercial cover and Slot 2 should be an elegant styled supporting image (silk cloth / flowers / flat lay).\n\nDo you want to proceed and publish anyway?'
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
        onPackPublished(product.id, galleryPack);
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
                  Automated Shopify Media Pack Studio
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
                  AI Pipeline 2.0
                </span>
              </div>
              <p style={{ fontSize: '0.78rem', color: '#9ca3af', margin: '3px 0 0 0' }}>
                {product ? `SKU: ${product.sku || 'Draft'} • ${product.title || 'Jewelry Piece'}` : 'Mobile Multi-Photo Upload + 2048px Square Containment + AI Model Styling'}
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

              {/* Pipeline Configuration Panel */}
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
                      {presets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} — {p.description}
                        </option>
                      ))}
                      {presets.length === 0 && (
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

                {/* AI Generative Images (Choose with Tick: AI only generates what you tick) */}
                <div
                  style={{
                    padding: '16px',
                    backgroundColor: 'rgba(255, 255, 255, 0.03)',
                    borderRadius: '12px',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    display: 'flex',
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
                            {presets.map((p) => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                            {presets.length === 0 && (
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

                {/* Trigger Button */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '6px' }}>
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
                        </div>

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
                                {presets.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name}
                                  </option>
                                ))}
                                {presets.length === 0 && (
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
    </div>
  );

  return createPortal(modalContent, document.body);
};
