import React, { useState, useEffect, useRef } from 'react';
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
  Info
} from 'lucide-react';
import type { JewelryItem } from '../types/inventory';
import type { GalleryPack, StylingPreset } from '../types/media';
import {
  fetchMediaPresets,
  generateMediaPack,
  regeneratePackSlot,
  publishPackToShopify,
  fetchMediaJobStatus,
} from '../services/mediaService';

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
        // Probe image aspect ratio
        const img = new Image();
        img.onload = () => {
          const is9x16 = img.height > img.width && (img.height / img.width >= 1.6);
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
      alert('Please upload at least 1 product photo.');
      return;
    }

    setIsProcessing(true);
    setProcessingStep('Analyzing mobile images, calculating blur score & perceptual hashes...');
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
      customPrompt: customPrompt.trim() || undefined,
      approvalMode,
      autoPushShopify: approvalMode === 'FULL_AUTO',
    };

    const res = await generateMediaPack(payload);

    if (!res.success) {
      setIsProcessing(false);
      alert(res.message || 'Media Pack generation failed');
      return;
    }

    if (res.jobId) {
      setActiveJobId(res.jobId);
      // Poll job status until complete
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
      setIsProcessing(false);
      setGalleryPack(res.galleryPack);
      setPipelineWarnings(res.galleryPack.warnings || []);
      if (res.galleryPack.socialDerivatives) {
        setSocialOutputs(res.galleryPack.socialDerivatives);
      }
      setActiveTab('gallery_builder');
    }
  };

  // Move Slot Left/Right to rearrange order
  const swapSlots = (indexA: number, indexB: number) => {
    if (!galleryPack) return;
    const slots = [...galleryPack.slots];
    if (indexA < 0 || indexA >= slots.length || indexB < 0 || indexB >= slots.length) return;

    const temp = slots[indexA];
    slots[indexA] = slots[indexB];
    slots[indexB] = temp;

    // Recalculate slot numbers and cover flag
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

  // Update SEO Alt text for slot
  const updateSlotAltText = (slotIdx: number, newAlt: string) => {
    if (!galleryPack) return;
    const slots = [...galleryPack.slots];
    slots[slotIdx] = { ...slots[slotIdx], altText: newAlt };
    setGalleryPack({ ...galleryPack, slots });
  };

  // Single-slot Model Regeneration
  const handleRegenerateSlot = async (slotNumber: number) => {
    if (!galleryPack) return;
    setRegeneratingSlot(slotNumber);

    try {
      const res = await regeneratePackSlot({
        jobId: activeJobId || undefined,
        galleryPack,
        slotNumber,
        stylingPreset: selectedPreset,
        customPrompt: customPrompt.trim() || undefined,
      });

      if (res.success && res.slot) {
        const slots = galleryPack.slots.map((s) => (s.slotNumber === slotNumber ? res.slot! : s));
        setGalleryPack({
          ...galleryPack,
          slots,
        });
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

    setIsPublishing(true);
    setPublishErrorMessage(null);
    setPublishSuccessMessage(null);

    const res = await publishPackToShopify({
      productId: product.id,
      shopifyProductId: (product as any).shopifyProductId || (product as any).shopify_product_id,
      gallerySlots: galleryPack.slots,
    });

    setIsPublishing(false);
    if (res.success) {
      setPublishSuccessMessage(`Successfully uploaded ${res.uploadedCount || galleryPack.slots.length} media items to Shopify with Slot 1 as primary cover!`);
      if (onPackPublished) {
        onPackPublished(product.id, galleryPack);
      }
    } else {
      setPublishErrorMessage(res.error || 'Failed to sync gallery pack to Shopify.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/80 backdrop-blur-md overflow-y-auto">
      <div className="relative w-full max-w-6xl bg-slate-900 border border-slate-700/60 rounded-2xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden text-slate-100">
        {/* Header */}
        <div className="px-6 py-4 bg-slate-800/80 border-b border-slate-700/60 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-tr from-amber-500 to-amber-300 rounded-xl text-slate-950 font-bold shadow-lg shadow-amber-500/20">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold tracking-tight text-white">Automated Shopify Media Pack Studio</h2>
                <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  AI Pipeline 2.0
                </span>
              </div>
              <p className="text-xs text-slate-400">
                {product ? `SKU: ${product.sku || 'Draft'} • ${product.title || 'Untitled Item'}` : 'Mobile Multi-Upload + Sharp Non-Destructive Squares + AI Styling'}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-700/60 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center gap-2 px-6 pt-3 bg-slate-800/40 border-b border-slate-700/40">
          <button
            onClick={() => setActiveTab('upload_inspect')}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'upload_inspect'
                ? 'border-amber-400 text-amber-300 bg-slate-800/50 rounded-t-lg'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Upload className="w-4 h-4" />
            1. Upload & Quality Check ({rawFiles.length})
          </button>

          <button
            onClick={() => setActiveTab('gallery_builder')}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'gallery_builder'
                ? 'border-amber-400 text-amber-300 bg-slate-800/50 rounded-t-lg'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="w-4 h-4" />
            2. Recommended Gallery Pack {galleryPack ? `(${galleryPack.slots.length})` : ''}
          </button>

          <button
            onClick={() => setActiveTab('social_derivatives')}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'social_derivatives'
                ? 'border-amber-400 text-amber-300 bg-slate-800/50 rounded-t-lg'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Share2 className="w-4 h-4" />
            3. Social Formats (1:1, 4:5, 9:16)
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* TAB 1: UPLOAD & INSPECTION */}
          {activeTab === 'upload_inspect' && (
            <div className="space-y-6">
              {/* Drag & Drop Box */}
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
                className={`relative flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-2xl cursor-pointer transition-all ${
                  isDragOver
                    ? 'border-amber-400 bg-amber-500/10'
                    : 'border-slate-700 bg-slate-800/30 hover:bg-slate-800/60 hover:border-slate-600'
                }`}
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  multiple
                  accept="image/*,.heic"
                  className="hidden"
                  onChange={(e) => handleFiles(e.target.files)}
                />
                <div className="p-4 bg-slate-800 rounded-full text-amber-400 shadow-md mb-3">
                  <Upload className="w-8 h-8" />
                </div>
                <h3 className="text-base font-semibold text-white mb-1">
                  Drop 1–20 Mobile Jewellery Photos Here
                </h3>
                <p className="text-xs text-slate-400 max-w-md text-center">
                  Supports 9:16 Mobile Portals, JPG, PNG, WEBP, and HEIC. Images will be reframed into 2048×2048 square masters with zero pendant/chain clipping.
                </p>
                <div className="mt-4 flex items-center gap-2 text-xs text-amber-300/80 bg-amber-950/40 px-3 py-1.5 rounded-full border border-amber-500/20">
                  <Lock className="w-3.5 h-3.5" />
                  Source raw photos are saved non-destructively as immutable originals
                </div>
              </div>

              {/* Uploaded File Grid */}
              {rawFiles.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-slate-300">
                      Uploaded Source Photos ({rawFiles.length})
                    </h4>
                    <button
                      onClick={() => setRawFiles([])}
                      className="text-xs text-rose-400 hover:text-rose-300 transition-colors"
                    >
                      Clear All
                    </button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3">
                    {rawFiles.map((file, idx) => (
                      <div
                        key={file.id}
                        className="relative group rounded-xl bg-slate-800/80 border border-slate-700/80 overflow-hidden shadow-md flex flex-col"
                      >
                        <div className="relative aspect-square bg-black/40 flex items-center justify-center overflow-hidden">
                          <img
                            src={file.dataUrl}
                            alt={file.name}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                          />
                          {/* 9:16 Badge */}
                          {file.isMobile9x16 && (
                            <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 text-[10px] font-bold bg-indigo-600/90 text-white rounded shadow">
                              9:16 Mobile
                            </span>
                          )}
                          {/* Delete button */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              removeFile(file.id);
                            }}
                            className="absolute top-1.5 right-1.5 p-1 bg-black/60 hover:bg-rose-600 text-white rounded-md transition-colors"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="p-2 text-[11px] text-slate-300 truncate">
                          <p className="truncate font-medium">{file.name}</p>
                          <p className="text-slate-500 text-[10px]">Photo #{idx + 1}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Pipeline Configuration Bar */}
              <div className="p-5 bg-slate-800/60 rounded-xl border border-slate-700/60 space-y-4">
                <h4 className="text-sm font-semibold text-amber-300 flex items-center gap-2">
                  <Sliders className="w-4 h-4" />
                  Configure Media Pack Generation
                </h4>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Preset Selection */}
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      Commercial Styling Preset
                    </label>
                    <select
                      value={selectedPreset}
                      onChange={(e) => setSelectedPreset(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-amber-400"
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

                  {/* Mode Selector */}
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      Approval & Publishing Workflow
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setApprovalMode('REVIEW_FIRST')}
                        className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-all text-left flex flex-col ${
                          approvalMode === 'REVIEW_FIRST'
                            ? 'bg-amber-500/15 border-amber-400 text-amber-300'
                            : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <span>Mode A: Review First</span>
                        <span className="text-[10px] text-slate-400 font-normal">Inspect gallery before publishing</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setApprovalMode('FULL_AUTO')}
                        className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-all text-left flex flex-col ${
                          approvalMode === 'FULL_AUTO'
                            ? 'bg-emerald-500/15 border-emerald-400 text-emerald-300'
                            : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <span>Mode B: Full Auto</span>
                        <span className="text-[10px] text-slate-400 font-normal">Generate & push direct to Shopify</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Custom Art Direction prompt */}
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5 flex items-center justify-between">
                    <span>Custom Art Direction / Lighting Note (Optional)</span>
                    <span className="text-[11px] text-slate-400 flex items-center gap-1">
                      <Lock className="w-3 h-3 text-amber-400" />
                      Jewellery design & stones are strictly locked
                    </span>
                  </label>
                  <input
                    type="text"
                    value={customPrompt}
                    onChange={(e) => setCustomPrompt(e.target.value)}
                    placeholder="e.g. warm golden hour backlight, raw silk beige drape, subtle bokeh"
                    className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-amber-400"
                  />
                </div>

                {/* Submit button */}
                <div className="pt-2 flex justify-end">
                  <button
                    disabled={isProcessing || rawFiles.length === 0}
                    onClick={runPipeline}
                    className="flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 disabled:opacity-50 text-slate-950 font-bold text-sm rounded-xl shadow-lg shadow-amber-500/20 transition-all cursor-pointer"
                  >
                    {isProcessing ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Generating Pack...
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4" />
                        Generate 5-Slot Media Pack
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Live Progress Bar */}
              {isProcessing && (
                <div className="p-4 bg-slate-800/90 rounded-xl border border-amber-500/30 space-y-2 animate-pulse">
                  <div className="flex items-center justify-between text-xs text-amber-300 font-medium">
                    <span>{processingStep}</span>
                    <span>{progressPercent}%</span>
                  </div>
                  <div className="w-full h-2 bg-slate-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-amber-400 to-amber-500 transition-all duration-300"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: RECOMMENDED GALLERY BUILDER */}
          {activeTab === 'gallery_builder' && (
            <div className="space-y-6">
              {/* Warnings Banner */}
              {pipelineWarnings.length > 0 && (
                <div className="p-4 bg-amber-950/40 border border-amber-500/40 rounded-xl text-amber-200 text-xs space-y-1">
                  <div className="flex items-center gap-1.5 font-bold">
                    <AlertTriangle className="w-4 h-4 text-amber-400" />
                    Notice from Media Recommendation Engine:
                  </div>
                  <ul className="list-disc list-inside space-y-0.5 text-amber-300/90">
                    {pipelineWarnings.map((w, idx) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Gallery Pack Summary & Stats */}
              <div className="flex flex-wrap items-center justify-between gap-3 p-4 bg-slate-800/60 rounded-xl border border-slate-700/60">
                <div className="flex items-center gap-4 text-xs">
                  <div>
                    <span className="text-slate-400">Total Pack Slots: </span>
                    <span className="font-bold text-white">{galleryPack?.slots.length || 0}</span>
                  </div>
                  <div className="h-4 w-px bg-slate-700" />
                  <div>
                    <span className="text-slate-400">Real Product Photos: </span>
                    <span className="font-bold text-emerald-400">{galleryPack?.realPhotoCount || 0} (Min 3 guaranteed)</span>
                  </div>
                  <div className="h-4 w-px bg-slate-700" />
                  <div>
                    <span className="text-slate-400">AI Fashion Models: </span>
                    <span className="font-bold text-indigo-400">{galleryPack?.aiModelCount || 0}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setActiveTab('upload_inspect')}
                    className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors text-slate-200"
                  >
                    Back to Uploads
                  </button>
                  <button
                    disabled={isPublishing || !galleryPack}
                    onClick={handlePublishToShopify}
                    className="flex items-center gap-2 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-xs rounded-lg shadow transition-all cursor-pointer"
                  >
                    {isPublishing ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Uploading to Shopify...
                      </>
                    ) : (
                      <>
                        <ShoppingBag className="w-3.5 h-3.5" />
                        Approve & Push to Shopify
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Publish notifications */}
              {publishSuccessMessage && (
                <div className="p-3 bg-emerald-950/50 border border-emerald-500/50 rounded-xl text-emerald-300 text-xs flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                  {publishSuccessMessage}
                </div>
              )}
              {publishErrorMessage && (
                <div className="p-3 bg-rose-950/50 border border-rose-500/50 rounded-xl text-rose-300 text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
                  {publishErrorMessage}
                </div>
              )}

              {/* 5-Slot Grid */}
              <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                {galleryPack?.slots.map((slot, idx) => (
                  <div
                    key={slot.mediaAssetId || idx}
                    className={`flex flex-col bg-slate-800/80 rounded-2xl border transition-all overflow-hidden shadow-lg ${
                      slot.isCover
                        ? 'border-amber-400/80 ring-2 ring-amber-400/20'
                        : 'border-slate-700/80'
                    }`}
                  >
                    {/* Header Slot Title */}
                    <div className="px-3 py-2 bg-slate-900/80 border-b border-slate-700/60 flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                        {slot.isCover ? (
                          <span className="flex items-center gap-1 text-amber-300">
                            <Crown className="w-3.5 h-3.5 fill-amber-400" />
                            Slot 1 (Cover)
                          </span>
                        ) : (
                          `Slot ${slot.slotNumber}`
                        )}
                      </span>

                      {/* Source Type Tag */}
                      <span
                        className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                          slot.sourceType === 'AI_MODEL'
                            ? 'bg-indigo-600/80 text-white'
                            : slot.sourceType === 'DERIVATIVE'
                            ? 'bg-amber-600/80 text-white'
                            : 'bg-emerald-600/80 text-white'
                        }`}
                      >
                        {slot.sourceType === 'AI_MODEL' ? 'AI MODEL' : 'REAL PHOTO'}
                      </span>
                    </div>

                    {/* Image Preview Box */}
                    <div className="relative aspect-square bg-black/40 flex items-center justify-center overflow-hidden group">
                      <img
                        src={slot.url}
                        alt={slot.altText || `Slot ${slot.slotNumber}`}
                        className="w-full h-full object-contain p-2"
                      />

                      {/* Reorder Arrows on Hover */}
                      <div className="absolute inset-x-0 bottom-2 px-2 flex items-center justify-between opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          disabled={idx === 0}
                          onClick={() => swapSlots(idx, idx - 1)}
                          className="p-1.5 bg-black/70 hover:bg-slate-700 disabled:opacity-30 text-white rounded-lg transition-colors"
                          title="Move Left"
                        >
                          <ArrowLeft className="w-3.5 h-3.5" />
                        </button>
                        {!slot.isCover && (
                          <button
                            onClick={() => setSlotAsCover(idx)}
                            className="px-2 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-[10px] rounded-md shadow transition-colors flex items-center gap-1"
                          >
                            <Crown className="w-3 h-3" />
                            Make Cover
                          </button>
                        )}
                        <button
                          disabled={idx === (galleryPack.slots.length - 1)}
                          onClick={() => swapSlots(idx, idx + 1)}
                          className="p-1.5 bg-black/70 hover:bg-slate-700 disabled:opacity-30 text-white rounded-lg transition-colors"
                          title="Move Right"
                        >
                          <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Slot Details */}
                    <div className="p-3 space-y-2.5 flex-1 flex flex-col justify-between">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-slate-400 font-medium">{slot.slotRole.replace(/_/g, ' ')}</span>
                          <span className="text-slate-500">
                            {slot.dimensions.width}×{slot.dimensions.height}
                          </span>
                        </div>

                        {/* Editable SEO Alt Text */}
                        <div>
                          <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                            SEO Alt Text
                          </label>
                          <textarea
                            rows={2}
                            value={slot.altText}
                            onChange={(e) => updateSlotAltText(idx, e.target.value)}
                            className="w-full text-xs px-2 py-1 bg-slate-900 border border-slate-700 rounded-md text-slate-300 focus:outline-none focus:border-amber-400 resize-none"
                          />
                        </div>
                      </div>

                      {/* Model Regeneration / Fallback Actions */}
                      {slot.sourceType === 'AI_MODEL' && (
                        <div className="pt-2 border-t border-slate-700/60">
                          <button
                            disabled={regeneratingSlot === slot.slotNumber}
                            onClick={() => handleRegenerateSlot(slot.slotNumber)}
                            className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 bg-indigo-950/60 hover:bg-indigo-900/60 border border-indigo-500/40 text-indigo-300 hover:text-white rounded-lg text-xs font-semibold transition-colors"
                          >
                            <RefreshCw
                              className={`w-3 h-3 ${regeneratingSlot === slot.slotNumber ? 'animate-spin' : ''}`}
                            />
                            {regeneratingSlot === slot.slotNumber ? 'Regenerating...' : 'Regenerate Model'}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {!galleryPack && (
                <div className="p-12 text-center text-slate-400">
                  <Layers className="w-12 h-12 mx-auto text-slate-600 mb-3" />
                  <p className="text-sm">No gallery pack generated yet.</p>
                  <button
                    onClick={() => setActiveTab('upload_inspect')}
                    className="mt-3 px-4 py-2 bg-amber-500 text-slate-950 text-xs font-bold rounded-lg"
                  >
                    Go to Upload & Generate
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: SOCIAL FORMATS */}
          {activeTab === 'social_derivatives' && (
            <div className="space-y-6">
              <div className="p-4 bg-slate-800/60 rounded-xl border border-slate-700/60 flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-semibold text-white">Social Marketing Formats</h4>
                  <p className="text-xs text-slate-400">
                    Pre-scaled derivatives generated directly from your hero product asset.
                  </p>
                </div>
                <div className="text-xs text-slate-400 flex items-center gap-1">
                  <Info className="w-4 h-4 text-amber-400" />
                  Auto-formatted with neutral background containment
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                {/* 1:1 Square Feed */}
                <div className="bg-slate-800/70 border border-slate-700/70 rounded-2xl p-4 flex flex-col items-center">
                  <span className="text-xs font-bold text-amber-300 mb-2">1:1 Square (1080×1080)</span>
                  <div className="w-48 h-48 bg-black/40 rounded-xl overflow-hidden flex items-center justify-center p-2 mb-3 border border-slate-700">
                    {socialOutputs.social_1x1 || galleryPack?.slots[0]?.url ? (
                      <img
                        src={socialOutputs.social_1x1 || galleryPack?.slots[0]?.url}
                        alt="1:1 format"
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <ImageIcon className="w-8 h-8 text-slate-600" />
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400 mb-3 text-center">
                    Optimized for Instagram Feed, Facebook Post, and Shopify Catalog.
                  </p>
                  {socialOutputs.social_1x1 && (
                    <a
                      href={socialOutputs.social_1x1}
                      download="social_1x1.jpg"
                      target="_blank"
                      rel="noreferrer"
                      className="mt-auto flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-xs text-white rounded-lg transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download 1:1
                    </a>
                  )}
                </div>

                {/* 4:5 Portrait Feed */}
                <div className="bg-slate-800/70 border border-slate-700/70 rounded-2xl p-4 flex flex-col items-center">
                  <span className="text-xs font-bold text-indigo-300 mb-2">4:5 Portrait (1080×1350)</span>
                  <div className="w-44 h-56 bg-black/40 rounded-xl overflow-hidden flex items-center justify-center p-2 mb-3 border border-slate-700">
                    {socialOutputs.social_4x5 || galleryPack?.slots[0]?.url ? (
                      <img
                        src={socialOutputs.social_4x5 || galleryPack?.slots[0]?.url}
                        alt="4:5 portrait"
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <ImageIcon className="w-8 h-8 text-slate-600" />
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400 mb-3 text-center">
                    Maximizes mobile screen real estate on Instagram & Pinterest feeds.
                  </p>
                  {socialOutputs.social_4x5 && (
                    <a
                      href={socialOutputs.social_4x5}
                      download="social_4x5.jpg"
                      target="_blank"
                      rel="noreferrer"
                      className="mt-auto flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-xs text-white rounded-lg transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download 4:5
                    </a>
                  )}
                </div>

                {/* 9:16 Story / Reel */}
                <div className="bg-slate-800/70 border border-slate-700/70 rounded-2xl p-4 flex flex-col items-center">
                  <span className="text-xs font-bold text-emerald-300 mb-2">9:16 Story / Reels (1080×1920)</span>
                  <div className="w-36 h-64 bg-black/40 rounded-xl overflow-hidden flex items-center justify-center p-2 mb-3 border border-slate-700">
                    {socialOutputs.social_9x16 || galleryPack?.slots[0]?.url ? (
                      <img
                        src={socialOutputs.social_9x16 || galleryPack?.slots[0]?.url}
                        alt="9:16 vertical"
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <ImageIcon className="w-8 h-8 text-slate-600" />
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400 mb-3 text-center">
                    Full-bleed vertical story format for Instagram Stories, TikTok, & Reels.
                  </p>
                  {socialOutputs.social_9x16 && (
                    <a
                      href={socialOutputs.social_9x16}
                      download="social_9x16.jpg"
                      target="_blank"
                      rel="noreferrer"
                      className="mt-auto flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-xs text-white rounded-lg transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download 9:16
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 bg-slate-800/90 border-t border-slate-700/60 flex items-center justify-between">
          <div className="text-xs text-slate-400 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            <span>Ready • Anti-Hallucination Safe • Sharp 2048px Containment</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white rounded-lg transition-colors"
            >
              Close Studio
            </button>
            {activeTab !== 'gallery_builder' && galleryPack && (
              <button
                onClick={() => setActiveTab('gallery_builder')}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-white rounded-lg transition-colors"
              >
                View Recommended Pack →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
