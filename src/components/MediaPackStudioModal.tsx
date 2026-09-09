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
  Plus
} from 'lucide-react';
import type { JewelryItem } from '../types/inventory';
import type { GalleryPack, StylingPreset, StyledSlot2Option } from '../types/media';
import {
  fetchMediaPresets,
  generateMediaPack,
  regeneratePackSlot,
  publishPackToShopify,
  fetchMediaJobStatus,
} from '../services/mediaService';
import { getStoredShopifyConfig } from '../services/shopifyService';
import { getStoredInventory, saveStoredInventory } from '../services/storage';

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
  const [slot2Style, setSlot2Style] = useState<StyledSlot2Option>('silk_cloth');
  const [enableStyledSlot2, setEnableStyledSlot2] = useState<boolean>(true);
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

  // Regeneration per slot
  const [regeneratingSlot, setRegeneratingSlot] = useState<number | null>(null);

  // Shopify sync state
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishSuccessMessage, setPublishSuccessMessage] = useState<string | null>(null);
  const [publishErrorMessage, setPublishErrorMessage] = useState<string | null>(null);

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
        const dataUrl = e.target?.result as string;
        const img = new Image();
        img.onload = () => {
          const is9x16 = img.height > img.width && img.height / img.width >= 1.6;
          setRawFiles((prev) => [
            ...prev,
            {
              id: `upload-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
              name: file.name,
              size: file.size,
              dataUrl,
              isMobile9x16: is9x16,
            },
          ]);
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    });
  };

  const removeFile = (id: string) => {
    setRawFiles((prev) => prev.filter((f) => f.id !== id));
  };

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
        filename: f.name,
        base64Data: f.dataUrl,
      })),
      stylingPreset: selectedPreset,
      slot2StyleOption: slot2Style,
      enableStyledSlot2,
      customPrompt: customPrompt.trim() || undefined,
      approvalMode,
      autoPushShopify: approvalMode === 'FULL_AUTO',
    };

    const stepTimer = setInterval(() => {
      setProgressPercent((prev) => {
        if (prev < 35) {
          setProcessingStep('Isolating jewelry & generating studio clean cover...');
          return 35;
        } else if (prev < 65) {
          setProcessingStep('Styling supporting presentation & luxury satin backdrop...');
          return 65;
        } else if (prev < 85) {
          setProcessingStep('Generating fashion model fit & lifestyle still-life...');
          return 85;
        } else if (prev < 95) {
          setProcessingStep('Composing recommended 5-slot Shopify gallery pack...');
          return 95;
        }
        return prev;
      });
    }, 1400);

    try {
      const res = await generateMediaPack(payload);
      clearInterval(stepTimer);

      if (!res.success) {
        setIsProcessing(false);
        setPublishErrorMessage(res.message || 'Media Pack generation failed');
        alert(res.message || 'Media Pack generation failed');
        return;
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

  // Single-slot Model or Styled Supporting Regeneration
  const handleRegenerateSlot = async (slotNumber: number, overrideSlot2Style?: StyledSlot2Option) => {
    if (!galleryPack) return;
    setRegeneratingSlot(slotNumber);

    try {
      const activeSlot2Style = overrideSlot2Style || slot2Style;
      const res = await regeneratePackSlot({
        jobId: activeJobId || undefined,
        galleryPack,
        slotNumber,
        stylingPreset: selectedPreset,
        slot2StyleOption: activeSlot2Style,
        newSlot2StyleOption: activeSlot2Style,
        customPrompt: customPrompt.trim() || undefined,
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
      } else {
        alert(res.message || 'Slot regeneration failed');
      }
    } catch (e: any) {
      alert(e.message || 'Error regenerating slot');
    } finally {
      setRegeneratingSlot(null);
    }
  };

  // Publish to Shopify
  const handlePublishToShopify = async () => {
    if (!galleryPack || !product) {
      alert('Missing active gallery pack or product reference.');
      return;
    }

    const shopifyConfig = getStoredShopifyConfig();
    if (!shopifyConfig.shopDomain || !shopifyConfig.adminAccessToken) {
      setPublishErrorMessage('Shopify is not connected. Please open Shopify Integration from the navigation bar to enter your store domain and Admin API Access Token.');
      return;
    }

    // Validation check for Slot 1 and Slot 2
    if (galleryPack.slots.length >= 2) {
      const slot1 = galleryPack.slots[0];
      const slot2 = galleryPack.slots[1];
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

    const res = await publishPackToShopify({
      productId: product.id,
      shopifyProductId: (product as any).shopifyProductId || (product as any).shopify_product_id,
      gallerySlots: galleryPack.slots,
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
      setPublishSuccessMessage(`Successfully uploaded ${res.uploadedCount || galleryPack.slots.length} media items to Shopify with Slot 1 as primary cover!`);
      if (onPackPublished) {
        onPackPublished(product.id, galleryPack);
      }
    } else {
      setPublishErrorMessage(res.error || 'Failed to sync gallery pack to Shopify.');
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
                        {/* Image Box */}
                        <div
                          style={{
                            width: '100%',
                            height: '130px',
                            backgroundColor: '#0a0c10',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            position: 'relative',
                            overflow: 'hidden',
                          }}
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

                        {/* Title Info */}
                        <div style={{ padding: '8px', fontSize: '0.72rem' }}>
                          <div style={{ color: '#e5e7eb', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {file.name}
                          </div>
                          <div style={{ color: '#9ca3af', fontSize: '0.66rem', marginTop: '2px' }}>
                            Photo #{idx + 1}
                          </div>
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

                {/* Slot 2 Styled Supporting Image Preference */}
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
                        Styled Supporting Image (Slot 2 Preference)
                      </label>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <label
                        style={{
                          fontSize: '0.72rem',
                          color: enableStyledSlot2 ? '#fae084' : '#9ca3af',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={enableStyledSlot2}
                          onChange={(e) => setEnableStyledSlot2(e.target.checked)}
                          style={{ cursor: 'pointer', accentColor: '#f59e0b' }}
                        />
                        <span>Enable Styled Slot 2</span>
                      </label>
                    </div>
                  </div>

                  <p style={{ fontSize: '0.7rem', color: '#9ca3af', margin: 0 }}>
                    Slot 1 is clean commercial cover. Slot 2 provides an elegant styled supporting presentation (props gently support without overpowering jewellery design).
                  </p>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: '8px' }}>
                    {[
                      { id: 'silk_cloth' as const, label: 'Silk Cloth', desc: 'Ivory & blush silk satin' },
                      { id: 'flower_styling' as const, label: 'Flower Styling', desc: 'Subtle soft-focus floral' },
                      { id: 'silk_and_flower' as const, label: 'Silk + Flower', desc: 'Silk fabric + blossom' },
                      { id: 'minimal_luxury_flat_lay' as const, label: 'Minimal Luxury', desc: 'Warm travertine stone' },
                    ].map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        disabled={!enableStyledSlot2}
                        onClick={() => setSlot2Style(item.id)}
                        style={{
                          padding: '8px 10px',
                          borderRadius: '8px',
                          border:
                            slot2Style === item.id && enableStyledSlot2
                              ? '1px solid #f59e0b'
                              : '1px solid rgba(255, 255, 255, 0.1)',
                          backgroundColor:
                            slot2Style === item.id && enableStyledSlot2
                              ? 'rgba(245, 158, 11, 0.18)'
                              : 'rgba(10, 12, 16, 0.6)',
                          color: slot2Style === item.id && enableStyledSlot2 ? '#fae084' : '#9ca3af',
                          cursor: enableStyledSlot2 ? 'pointer' : 'not-allowed',
                          opacity: enableStyledSlot2 ? 1 : 0.45,
                          textAlign: 'left',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '2px',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>
                          {item.label}
                        </span>
                        <span style={{ fontSize: '0.64rem', color: '#9ca3af' }}>
                          {item.desc}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Custom Art Prompt */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <label style={{ fontSize: '0.78rem', fontWeight: 600, color: '#e5e7eb' }}>
                      Custom Art Direction / Lighting (Optional)
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
                        <span>Generate 5-Slot Shopify Media Pack</span>
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
                }}
              >
                <div>
                  <h4 style={{ fontSize: '0.92rem', fontWeight: 700, color: '#ffffff', margin: 0 }}>
                    Recommended 5-Slot Shopify Gallery Pack
                  </h4>
                  <p style={{ fontSize: '0.74rem', color: '#9ca3af', margin: '2px 0 0 0' }}>
                    Slot 1 is clean commercial cover. Slot 2 is styled presentation. Reorder slots anytime.
                  </p>
                </div>

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
                      <span>Approve & Push to Shopify</span>
                    </>
                  )}
                </button>
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
                    padding: '12px 16px',
                    borderRadius: '8px',
                    backgroundColor: 'rgba(239, 68, 68, 0.15)',
                    border: '1px solid #ef4444',
                    color: '#fca5a5',
                    fontSize: '0.8rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                >
                  <AlertTriangle size={16} />
                  <span>{publishErrorMessage}</span>
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
                  return (
                    <div
                      key={slot.mediaAssetId || idx}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        backgroundColor: 'rgba(20, 24, 34, 0.9)',
                        borderRadius: '12px',
                        border: slot.isCover ? '2px solid #f59e0b' : '1px solid rgba(255, 255, 255, 0.1)',
                        overflow: 'hidden',
                        boxShadow: slot.isCover ? '0 0 20px rgba(245, 158, 11, 0.2)' : '0 4px 12px rgba(0, 0, 0, 0.4)',
                      }}
                    >
                      {/* Slot Header */}
                      <div
                        style={{
                          padding: '8px 12px',
                          backgroundColor: slot.isCover ? 'rgba(245, 158, 11, 0.2)' : 'rgba(0, 0, 0, 0.4)',
                          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        }}
                      >
                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: slot.isCover ? '#fae084' : slot.slotNumber === 2 ? '#a5b4fc' : '#e5e7eb', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          {slot.isCover && <Crown size={13} color="#f59e0b" fill="#f59e0b" />}
                          {slot.slotNumber === 2 && <Sparkles size={13} color="#818cf8" />}
                          Slot {slot.slotNumber} {slot.isCover ? '(Cover)' : slot.slotNumber === 2 ? '(Styled)' : ''}
                        </span>

                        <span
                          style={{
                            fontSize: '0.62rem',
                            fontWeight: 700,
                            padding: '2px 5px',
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
                            ? 'CLEAN COVER'
                            : slot.slotNumber === 2 || (slot.slotRole as string) === 'STYLED_SUPPORTING'
                            ? 'STYLED'
                            : (slot.sourceType?.toUpperCase() === 'AI_MODEL' || slot.sourceType?.toUpperCase() === 'AI_LIFESTYLE' || slot.isAiGenerated)
                            ? (slot.slotNumber === 5 || (slot.slotRole as string) === 'AI_MODEL_LIFESTYLE_2' || (slot.slotRole as string) === 'MODEL_2_OR_SUPPORTING' ? 'LIFESTYLE' : 'AI MODEL')
                            : 'REAL PHOTO'}
                        </span>
                      </div>

                      {/* Image Preview Box */}
                      <div
                        style={{
                          width: '100%',
                          aspectRatio: '1/1',
                          backgroundColor: '#0a0c10',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          position: 'relative',
                          overflow: 'hidden',
                        }}
                      >
                        {displayImgUrl ? (
                          <img
                            src={displayImgUrl}
                            alt={slot.altText || `Slot ${slot.slotNumber}`}
                            style={{
                              width: '100%',
                              height: '100%',
                              objectFit: 'contain',
                              display: 'block',
                              padding: '6px',
                            }}
                          />
                        ) : (
                          <ImageIcon size={32} color="#4b5563" />
                        )}

                        {/* Reorder Arrows on Hover / Always visible on bottom */}
                        <div
                          style={{
                            position: 'absolute',
                            bottom: '6px',
                            left: '6px',
                            right: '6px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            background: 'rgba(0, 0, 0, 0.65)',
                            backdropFilter: 'blur(4px)',
                            padding: '4px 6px',
                            borderRadius: '6px',
                          }}
                        >
                          <button
                            type="button"
                            disabled={idx === 0}
                            onClick={() => swapSlots(idx, idx - 1)}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: idx === 0 ? '#4b5563' : '#ffffff',
                              cursor: idx === 0 ? 'not-allowed' : 'pointer',
                              padding: '2px',
                            }}
                            title="Move Left"
                          >
                            <ArrowLeft size={14} />
                          </button>

                          {!slot.isCover && (
                            <button
                              type="button"
                              onClick={() => setSlotAsCover(idx)}
                              style={{
                                background: '#f59e0b',
                                border: 'none',
                                borderRadius: '4px',
                                color: '#0a0c10',
                                fontSize: '0.62rem',
                                fontWeight: 700,
                                padding: '2px 6px',
                                cursor: 'pointer',
                              }}
                            >
                              Make Cover
                            </button>
                          )}

                          <button
                            type="button"
                            disabled={idx === (galleryPack.slots.length - 1)}
                            onClick={() => swapSlots(idx, idx + 1)}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: idx === (galleryPack.slots.length - 1) ? '#4b5563' : '#ffffff',
                              cursor: idx === (galleryPack.slots.length - 1) ? 'not-allowed' : 'pointer',
                              padding: '2px',
                            }}
                            title="Move Right"
                          >
                            <ArrowRight size={14} />
                          </button>
                        </div>
                      </div>

                      {/* Slot Details */}
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
                        </div>

                        {/* Slot 2 Styled Supporting Regeneration Controls */}
                        {(slot.slotNumber === 2 || slot.slotRole === 'STYLED_SUPPORTING') && (
                          <div style={{ paddingTop: '8px', borderTop: '1px solid rgba(255, 255, 255, 0.08)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                              <span style={{ fontSize: '0.66rem', color: '#9ca3af', fontWeight: 600 }}>
                                Style:
                              </span>
                              <select
                                value={slot.styledOption || slot2Style}
                                onChange={(e) => {
                                  const val = e.target.value as StyledSlot2Option;
                                  setSlot2Style(val);
                                  handleRegenerateSlot(2, val);
                                }}
                                disabled={regeneratingSlot === 2}
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
                                <option value="silk_cloth">Silk Cloth</option>
                                <option value="flower_styling">Flower Styling</option>
                                <option value="silk_and_flower">Silk + Flower</option>
                                <option value="minimal_luxury_flat_lay">Minimal Luxury</option>
                              </select>
                            </div>
                            <button
                              type="button"
                              disabled={regeneratingSlot === 2}
                              onClick={() => handleRegenerateSlot(2, slot.styledOption || slot2Style)}
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
                                cursor: regeneratingSlot === 2 ? 'not-allowed' : 'pointer',
                              }}
                            >
                              <RefreshCw size={12} className={regeneratingSlot === 2 ? 'animate-spin' : ''} />
                              <span>{regeneratingSlot === 2 ? 'Styling Slot 2...' : 'Regenerate Styled Slot 2'}</span>
                            </button>
                          </div>
                        )}

                        {/* Standard Model Regeneration button for other model slots */}
                        {slot.sourceType === 'AI_MODEL' && slot.slotNumber !== 2 && slot.slotRole !== 'STYLED_SUPPORTING' && (
                          <div style={{ paddingTop: '6px', borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}>
                            <button
                              type="button"
                              disabled={regeneratingSlot === slot.slotNumber}
                              onClick={() => handleRegenerateSlot(slot.slotNumber)}
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
                              <span>{regeneratingSlot === slot.slotNumber ? 'Regenerating...' : 'Regenerate Model'}</span>
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
    </div>
  );

  return createPortal(modalContent, document.body);
};
