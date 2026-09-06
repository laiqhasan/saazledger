import React, { useState, useEffect, useRef } from 'react';
import type { JewelryItem, CodeTables, DuplicateCheckResult, VendorItem } from '../types/inventory';
import {
  getNextSerialForCombo,
  calculateItemFinancials,
  formatCurrency,
  generateClientImageHash,
} from '../services/skuEngine';
import {
  analyzeJewelryPhoto,
  getStoredAiConfig,
} from '../services/aiVisionService';
import type { DetectedAttributeItem } from '../services/aiVisionService';
import { SkuTagBadge } from './SkuTagBadge';
import { DuplicateWarningModal } from './DuplicateWarningModal';
import { AiSettingsModal } from './AiSettingsModal';
import { MediaLibraryModal } from './MediaLibraryModal';
import { uploadPhotoToBackend, allocateBackendGlobalSku } from '../services/apiService';
import {
  X,
  Upload,
  Sparkles,
  AlertCircle,
  Check,
  Loader2,
  Key,
  FileText,
  ChevronDown,
  ChevronUp,
  Sliders,
  Bot,
  Zap,
  Users,
  FolderOpen,
} from 'lucide-react';
import confetti from 'canvas-confetti';

interface AddItemModalProps {
  codeTables: CodeTables;
  inventory: JewelryItem[];
  vendors?: VendorItem[];
  itemToEdit?: JewelryItem | null;
  onSaveItem: (item: JewelryItem) => void;
  onSaveAndPrint?: (item: JewelryItem) => void;
  onRestockExisting: (existingItem: JewelryItem, addedQty: number) => void;
  onQuickAddVendor?: (vendor: VendorItem) => void;
  onClose: () => void;
}

export const AddItemModal: React.FC<AddItemModalProps> = ({
  codeTables,
  inventory,
  vendors = [],
  itemToEdit,
  onSaveItem,
  onSaveAndPrint,
  onRestockExisting,
  onQuickAddVendor,
  onClose,
}) => {
  // Form State
  const [title, setTitle] = useState(itemToEdit?.title || '');
  const [typeCode, setTypeCode] = useState(itemToEdit?.typeCode || (codeTables.types[0]?.code || 'PD'));
  const [stoneCode, setStoneCode] = useState(itemToEdit?.stoneCode || (codeTables.stones[0]?.code || 'D'));
  const [colorCode, setColorCode] = useState(itemToEdit?.colorCode || (codeTables.colors[0]?.code || '01'));
  const [serial, setSerial] = useState(itemToEdit?.serial || '00001');

  const [buyingPrice, setBuyingPrice] = useState<number | ''>(itemToEdit ? itemToEdit.buyingPrice : 450);
  const [sellingPrice, setSellingPrice] = useState<number | ''>(itemToEdit ? itemToEdit.sellingPrice : 1200);
  const [quantity, setQuantity] = useState<number | ''>(itemToEdit ? itemToEdit.quantity : 10);
  const [reorderLevel, setReorderLevel] = useState<number | ''>(itemToEdit ? itemToEdit.reorderLevel : 3);
  const [vendor, setVendor] = useState(itemToEdit?.vendor || 'Aura Creations Jaipur');
  const [notes, setNotes] = useState(itemToEdit?.notes || '');
  const [imageUrl, setImageUrl] = useState(itemToEdit?.imageUrl || '');
  const [imageHash, setImageHash] = useState(itemToEdit?.imageHash || '');

  // Multi-Channel Marketplace State
  const [isListedOnAmazon, setIsListedOnAmazon] = useState(itemToEdit?.isListedOnAmazon || false);
  const [amazonAsin, setAmazonAsin] = useState(itemToEdit?.amazonAsin || '');
  const [isListedOnMyntra, setIsListedOnMyntra] = useState(itemToEdit?.isListedOnMyntra || false);
  const [myntraStyleId, setMyntraStyleId] = useState(itemToEdit?.myntraStyleId || '');
  const [safetyReserve, setSafetyReserve] = useState<number | ''>(itemToEdit?.safetyReserve ?? 0);
  const [showMarketplacesSection, setShowMarketplacesSection] = useState(
    Boolean(itemToEdit?.isListedOnAmazon || itemToEdit?.isListedOnMyntra || itemToEdit?.safetyReserve)
  );

  // Cloud Media Picker State
  const [isMediaPickerOpen, setIsMediaPickerOpen] = useState(false);

  // AI Suggestion & Correction Box State
  const [suggestionText, setSuggestionText] = useState('');
  const [detectedAttributes, setDetectedAttributes] = useState<DetectedAttributeItem[]>([]);
  const [showAttributesTable, setShowAttributesTable] = useState(true);

  // User confirmed / modified fields tracking to prevent AI from overwriting verified piece facts
  const userModifiedFields = useRef<Set<string>>(
    new Set(itemToEdit ? ['title', 'notes', 'typeCode', 'stoneCode', 'colorCode', 'serial'] : [])
  );

  // Inline Quick Artisan Creator State
  const [showQuickAddVendor, setShowQuickAddVendor] = useState(false);
  const [quickVendorCode, setQuickVendorCode] = useState('');
  const [quickVendorName, setQuickVendorName] = useState('');
  const [quickVendorCity, setQuickVendorCity] = useState('Jaipur');
  const [quickVendorPhone, setQuickVendorPhone] = useState('');

  const handleCreateQuickVendor = () => {
    if (!quickVendorName.trim()) {
      alert('Please enter an artisan or vendor name.');
      return;
    }
    const code = quickVendorCode.trim().toUpperCase() || quickVendorName.slice(0, 3).toUpperCase();
    const newV: VendorItem = {
      id: `vendor-${Date.now()}`,
      code,
      name: quickVendorName.trim(),
      city: quickVendorCity.trim() || 'Jaipur',
      phone: quickVendorPhone.trim() || undefined,
      status: 'active',
      createdAt: new Date().toISOString().split('T')[0],
    };
    if (onQuickAddVendor) {
      onQuickAddVendor(newV);
    }
    setVendor(newV.name);
    setShowQuickAddVendor(false);
    setQuickVendorName('');
    setQuickVendorCode('');
    setQuickVendorPhone('');
  };

  // AI Analysis State
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [aiStatusMsg, setAiStatusMsg] = useState<string | null>(null);
  const [isAiSettingsOpen, setIsAiSettingsOpen] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(Boolean(getStoredAiConfig().apiKey));

  // Validation / Duplicate State
  const [exactError, setExactError] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<DuplicateCheckResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const shouldPrintRef = useRef<boolean>(false);

  // Re-calculate next serial when (typeCode, stoneCode, colorCode) changes (only for new item)
  useEffect(() => {
    if (!itemToEdit) {
      const nextFree = getNextSerialForCombo(typeCode, stoneCode, colorCode, inventory);
      setSerial(nextFree);
    }
  }, [typeCode, stoneCode, colorCode, inventory, itemToEdit]);

  // Current computed SKU (Permanent for itemToEdit, Preview for new pieces)
  const currentSku = itemToEdit
    ? itemToEdit.sku
    : `${(typeCode || 'PD').trim().toUpperCase()}${(stoneCode || 'J').trim().toUpperCase()}${(colorCode || '01').trim().toUpperCase()}-XXXXX`;

  // Live financial metrics
  const financials = calculateItemFinancials(
    Number(buyingPrice) || 0,
    Number(sellingPrice) || 0,
    Number(quantity) || 0
  );

  // Track which AI engine last analyzed
  const [activeEngine, setActiveEngine] = useState<'gemini' | 'openai' | 'local'>('gemini');

  // Handle Photo Upload & Trigger Initial Vision Analysis with Gemini (by default)
  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const dataUrl = event.target?.result as string;
      setImageUrl(dataUrl);

      // Compute quick visual signature hash for duplicate detection
      const img = new Image();
      img.src = dataUrl;
      img.onload = async () => {
        const hash = await generateClientImageHash(img);
        setImageHash(hash);
      };

      // 1st time: Analyze with Gemini AI by default
      await runAnalysis(dataUrl, suggestionText, 'gemini');
    };
    reader.readAsDataURL(file);
  };

  const runAnalysis = async (
    imgData: string,
    instructions?: string,
    provider: 'gemini' | 'openai' = 'gemini'
  ) => {
    if (!imgData) return;

    // Check if OpenAI key is missing when ChatGPT requested
    const currentConfig = getStoredAiConfig();
    if (provider === 'openai') {
      const hasOpenAiKey = Boolean(currentConfig.openaiApiKey || (currentConfig.provider === 'openai' && currentConfig.apiKey));
      if (!hasOpenAiKey) {
        setIsAiSettingsOpen(true);
        setAiStatusMsg('Please enter your OpenAI (ChatGPT) API key below to analyze with ChatGPT.');
        return;
      }
    }

    setIsAnalyzing(true);
    const engineLabel = provider === 'openai' ? 'ChatGPT (GPT-4o)' : 'Google Gemini';
    setAiStatusMsg(
      instructions?.trim()
        ? `Refining attributes with ${engineLabel} based on your suggestions...`
        : `Optical AI (${engineLabel}): Examining piece structure, stones, and plating...`
    );

    try {
      const analysis = await analyzeJewelryPhoto(imgData, codeTables, instructions, provider);

      if (analysis.error === 'missing_openai_key') {
        setIsAiSettingsOpen(true);
        setAiStatusMsg(analysis.confidenceNotes);
        return;
      }

      let preservedFactCount = 0;
      if (analysis.title) {
        if (!userModifiedFields.current.has('title') && !itemToEdit) {
          setTitle(analysis.title);
        } else {
          preservedFactCount++;
        }
      }
      if (analysis.description) {
        if (!userModifiedFields.current.has('notes') && !itemToEdit) {
          setNotes(analysis.description);
        } else {
          preservedFactCount++;
        }
      }
      if (analysis.typeCode) {
        if (!userModifiedFields.current.has('typeCode') && !itemToEdit) {
          setTypeCode(analysis.typeCode);
        } else {
          preservedFactCount++;
        }
      }
      if (analysis.stoneCode) {
        if (!userModifiedFields.current.has('stoneCode') && !itemToEdit) {
          setStoneCode(analysis.stoneCode);
        } else {
          preservedFactCount++;
        }
      }
      if (analysis.colorCode) {
        if (!userModifiedFields.current.has('colorCode') && !itemToEdit) {
          setColorCode(analysis.colorCode);
        } else {
          preservedFactCount++;
        }
      }
      if (analysis.detectedAttributes) setDetectedAttributes(analysis.detectedAttributes);

      setActiveEngine(analysis.usedProvider || provider);
      setAiStatusMsg(
        preservedFactCount > 0
          ? `${analysis.confidenceNotes} (${preservedFactCount} user-confirmed fields preserved)`
          : analysis.confidenceNotes
      );
    } catch (err: any) {
      console.error('Vision analysis error:', err);
      setAiStatusMsg('Photo loaded. You can verify and adjust codes below.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Quick Action: Add Pill to Suggestion Box and Trigger Fix (defaults to ChatGPT on re-analysis)
  const handleApplyQuickSuggestion = (pillText: string) => {
    const newText = suggestionText.trim()
      ? `${suggestionText.trim()}, ${pillText}`
      : pillText;
    setSuggestionText(newText);
    if (imageUrl) {
      // Re-analysis with ChatGPT on subsequent fixes
      runAnalysis(imageUrl, newText, 'openai');
    }
  };

  // Submit Suggestion Box (uses ChatGPT on re-analysis)
  const handleFixOnSuggestion = (e: React.FormEvent, provider: 'gemini' | 'openai' = 'openai') => {
    e.preventDefault();
    if (!imageUrl) {
      alert('Please upload a jewelry piece photo first.');
      return;
    }
    runAnalysis(imageUrl, suggestionText, provider);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setExactError(null);

    if (!title.trim()) {
      setExactError('Please provide a piece title or description.');
      return;
    }

    if (itemToEdit) {
      finalizeSave(itemToEdit.sku, itemToEdit.serial);
      return;
    }

    try {
      // Allocate permanent 5-digit global SKU atomically on backend
      const allocated = await allocateBackendGlobalSku(typeCode, stoneCode, colorCode);
      finalizeSave(allocated.sku, allocated.formattedSerial);
    } catch (err: any) {
      console.warn('Backend sequence allocation error, using offline sequence fallback:', err);
      const maxSerial = inventory.reduce((max, it) => {
        if (it.sku && it.sku.includes('-')) {
          const num = parseInt(it.sku.split('-')[1], 10);
          return !isNaN(num) && num > max ? num : max;
        }
        return max;
      }, inventory.length);
      const nextNum = maxSerial + 1;
      const formatted = String(nextNum).padStart(5, '0');
      const fallbackSku = `${typeCode.trim().toUpperCase()}${stoneCode.trim().toUpperCase()}${colorCode.trim().toUpperCase()}-${formatted}`;
      finalizeSave(fallbackSku, formatted);
    }
  };

  const finalizeSave = async (skuToSave: string, serialToSave: string) => {
    let finalImageUrl = imageUrl;
    let finalImageHash = imageHash;

    if (imageUrl && imageUrl.startsWith('data:')) {
      try {
        const uploadResult = await uploadPhotoToBackend(imageUrl);
        if (uploadResult?.url) {
          finalImageUrl = uploadResult.url;
          finalImageHash = uploadResult.hash || imageHash;
        }
      } catch (err) {
        console.warn('Backend photo upload deferred:', err);
      }
    }

    const newItem: JewelryItem = {
      id: itemToEdit ? itemToEdit.id : `item-${Date.now()}`,
      sku: skuToSave,
      title: title.trim(),
      typeCode,
      stoneCode,
      colorCode,
      serial: serialToSave,
      buyingPrice: Number(buyingPrice) || 0,
      sellingPrice: Number(sellingPrice) || 0,
      quantity: Number(quantity) || 0,
      reorderLevel: Number(reorderLevel) || 0,
      vendor: vendor.trim() || 'Aura Creations',
      notes: notes.trim(),
      imageUrl: finalImageUrl,
      imageHash: finalImageHash,
      dateAdded: itemToEdit ? itemToEdit.dateAdded : new Date().toISOString().split('T')[0],
      lastRestocked: new Date().toISOString().split('T')[0],
      shopifyProductId: itemToEdit?.shopifyProductId,
      shopifyVariantId: itemToEdit?.shopifyVariantId,
      shopifySyncedAt: itemToEdit?.shopifySyncedAt,
      isListedOnShopify: itemToEdit?.isListedOnShopify !== false,
      isListedOnAmazon,
      amazonAsin: amazonAsin.trim() || undefined,
      isListedOnMyntra,
      myntraStyleId: myntraStyleId.trim() || undefined,
      safetyReserve: Math.max(0, Number(safetyReserve) || 0),
    };

    onSaveItem(newItem);

    try {
      confetti({
        particleCount: 40,
        spread: 60,
        origin: { y: 0.7 },
        colors: ['#d4af37', '#fae084', '#10b981'],
      });
    } catch {
      // pass
    }

    if (shouldPrintRef.current && onSaveAndPrint) {
      onSaveAndPrint(newItem);
    } else {
      onClose();
    }
  };

  return (
    <>
      <div className="modal-overlay">
        <div className="modal-content" style={{ maxWidth: '820px' }}>
          {/* Modal Header */}
          <div
            style={{
              padding: '20px 24px',
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <h2
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: '1.3rem',
                  fontWeight: 700,
                  color: '#ffffff',
                  margin: 0,
                }}
              >
                {itemToEdit ? 'Edit Jewelry Piece' : 'Register New Jewelry Piece'}
              </h2>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
                AI Visual Recognition &bull; Suggestion Box &bull; SEO/AEO/GEO Descriptions
              </p>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setIsAiSettingsOpen(true)}
                style={{ padding: '6px 12px', fontSize: '0.78rem', gap: '6px' }}
                title="Configure Google Gemini or OpenAI API Key"
              >
                <Key size={14} color={hasApiKey ? '#10b981' : '#f59e0b'} />
                <span>{hasApiKey ? 'AI Connected' : 'Connect AI Key'}</span>
              </button>

              <button
                type="button"
                onClick={onClose}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-dim)',
                  cursor: 'pointer',
                  padding: '4px',
                }}
              >
                <X size={20} />
              </button>
            </div>
          </div>

          <form onSubmit={handleSubmit} style={{ padding: '24px' }}>
            {/* Error Alert */}
            {exactError && (
              <div
                style={{
                  marginBottom: '20px',
                  padding: '12px 16px',
                  borderRadius: '8px',
                  background: 'rgba(244, 63, 94, 0.15)',
                  border: '1px solid rgba(244, 63, 94, 0.4)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  color: '#f87171',
                  fontSize: '0.85rem',
                }}
              >
                <AlertCircle size={18} style={{ flexShrink: 0 }} />
                <span>{exactError}</span>
              </div>
            )}

            {/* Photo Upload & Live Hallmark Banner */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '150px 1fr',
                gap: '16px',
                marginBottom: '18px',
                padding: '16px',
                borderRadius: '12px',
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid var(--border-subtle)',
                alignItems: 'center',
              }}
            >
              {/* Photo Box */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center' }}>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  style={{
                    width: '150px',
                    height: '150px',
                    borderRadius: '10px',
                    border: '2px dashed rgba(212, 175, 55, 0.4)',
                    background: imageUrl
                      ? `url(${imageUrl}) center/cover no-repeat`
                      : 'rgba(0, 0, 0, 0.4)',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    position: 'relative',
                    overflow: 'hidden',
                    transition: 'border-color 0.2s',
                  }}
                  title="Click to upload piece photo"
                >
                  {!imageUrl && (
                    <>
                      <Upload size={24} color="#d4af37" style={{ marginBottom: '6px' }} />
                      <span style={{ fontSize: '0.74rem', color: '#fae084', fontWeight: 600 }}>
                        Upload Photo
                      </span>
                      <span style={{ fontSize: '0.66rem', color: 'var(--text-dim)' }}>
                        or drag & drop
                      </span>
                    </>
                  )}

                  {/* Analyzing Overlay Spinner */}
                  {isAnalyzing && (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'rgba(10, 11, 14, 0.85)',
                        backdropFilter: 'blur(4px)',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '8px',
                        padding: '10px',
                        textAlign: 'center',
                      }}
                    >
                      <Loader2 size={24} color="#fae084" className="animate-spin" />
                      <span style={{ fontSize: '0.68rem', color: '#fae084', fontWeight: 600 }}>
                        AI Analyzing...
                      </span>
                    </div>
                  )}

                  <input
                    type="file"
                    ref={fileInputRef}
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={handlePhotoUpload}
                  />
                </div>

                <button
                  type="button"
                  onClick={() => setIsMediaPickerOpen(true)}
                  style={{
                    background: 'rgba(212, 175, 55, 0.08)',
                    border: '1px solid rgba(212, 175, 55, 0.3)',
                    borderRadius: '6px',
                    color: '#fae084',
                    fontSize: '0.72rem',
                    fontWeight: 500,
                    padding: '5px 8px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '5px',
                    width: '150px',
                    transition: 'all 0.2s',
                  }}
                  title="Choose from Cloud Media Library"
                >
                  <FolderOpen size={12} />
                  <span>Choose from Library</span>
                </button>
              </div>

              {/* SKU Hallmark Live Stamp Display & AI Banner */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Auto-Assembled Jewelry Tag (SKU)
                  </div>
                  {imageUrl && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <button
                        type="button"
                        onClick={() => runAnalysis(imageUrl, suggestionText, 'openai')}
                        disabled={isAnalyzing}
                        style={{
                          background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.2) 0%, rgba(59, 130, 246, 0.08) 100%)',
                          border: '1px solid rgba(59, 130, 246, 0.45)',
                          borderRadius: '6px',
                          color: '#93c5fd',
                          fontSize: '0.74rem',
                          fontWeight: 600,
                          padding: '4px 9px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '5px',
                        }}
                        title="Analyze again with ChatGPT AI (OpenAI GPT-4o)"
                      >
                        <Bot size={13} color="#60a5fa" />
                        <span>Analyze Again (with ChatGPT)</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => runAnalysis(imageUrl, suggestionText, 'gemini')}
                        disabled={isAnalyzing}
                        style={{
                          background: 'rgba(212, 175, 55, 0.1)',
                          border: '1px solid rgba(212, 175, 55, 0.3)',
                          borderRadius: '6px',
                          color: '#fae084',
                          fontSize: '0.74rem',
                          fontWeight: 500,
                          padding: '4px 8px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                        title="Re-run with Google Gemini"
                      >
                        <Zap size={12} color="#fae084" />
                        <span>Gemini</span>
                      </button>
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  <SkuTagBadge sku={currentSku} size="lg" showBarcode />
                  <span
                    style={{
                      fontSize: '0.78rem',
                      color: '#10b981',
                      background: 'rgba(16, 185, 129, 0.12)',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      border: '1px solid rgba(16, 185, 129, 0.3)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                    }}
                  >
                    <Check size={12} />
                    {itemToEdit ? `Serial #${itemToEdit.serial}` : `Serial #${serial} allocated (5-Digit Sequence)`}
                  </span>
                </div>

                {/* AI Status / Confidence Feedback */}
                {aiStatusMsg && (
                  <div
                    style={{
                      marginTop: '4px',
                      padding: '8px 12px',
                      background: 'rgba(212, 175, 55, 0.08)',
                      border: '1px solid rgba(212, 175, 55, 0.25)',
                      borderRadius: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      fontSize: '0.78rem',
                      color: '#fae084',
                    }}
                  >
                    <Sparkles size={14} color="#fae084" style={{ flexShrink: 0 }} />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span
                        style={{
                          fontSize: '0.68rem',
                          fontWeight: 700,
                          padding: '1px 6px',
                          borderRadius: '4px',
                          background:
                            activeEngine === 'openai'
                              ? 'rgba(59, 130, 246, 0.2)'
                              : 'rgba(212, 175, 55, 0.2)',
                          color: activeEngine === 'openai' ? '#93c5fd' : '#fae084',
                          border: `1px solid ${
                            activeEngine === 'openai'
                              ? 'rgba(59, 130, 246, 0.4)'
                              : 'rgba(212, 175, 55, 0.4)'
                          }`,
                        }}
                      >
                        {activeEngine === 'openai'
                          ? 'ChatGPT (GPT-4o)'
                          : activeEngine === 'gemini'
                          ? 'Google Gemini'
                          : 'Local Vision'}
                      </span>
                      <span style={{ lineHeight: 1.4 }}>{aiStatusMsg}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* AI SUGGESTION & CORRECTION BOX */}
            <div
              style={{
                marginBottom: '20px',
                padding: '14px 16px',
                borderRadius: '12px',
                background: 'linear-gradient(135deg, rgba(212, 175, 55, 0.08) 0%, rgba(59, 130, 246, 0.04) 100%)',
                border: '1px solid rgba(212, 175, 55, 0.35)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '8px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Sparkles size={16} color="#fae084" />
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#fae084' }}>
                    AI Suggestion & Guidance Box
                  </span>
                </div>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                  Give instructions or corrections to refine classification & copy
                </span>
              </div>

              {/* Input + Action */}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
                <input
                  type="text"
                  className="input-field"
                  placeholder="e.g. Silver-tone rhodium finish, accent stones are American Diamond, center stone is oval emerald simulant"
                  value={suggestionText}
                  onChange={(e) => setSuggestionText(e.target.value)}
                  style={{
                    flex: 1,
                    fontSize: '0.86rem',
                    background: 'rgba(0, 0, 0, 0.4)',
                    border: '1px solid rgba(212, 175, 55, 0.3)',
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      if (imageUrl) runAnalysis(imageUrl, suggestionText);
                    }
                  }}
                />
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={(e) => handleFixOnSuggestion(e, 'openai')}
                    disabled={isAnalyzing || !imageUrl}
                    style={{
                      padding: '8px 14px',
                      fontSize: '0.82rem',
                      whiteSpace: 'nowrap',
                      gap: '6px',
                    }}
                    title="Fix and re-analyze with ChatGPT AI (OpenAI GPT-4o)"
                  >
                    {isAnalyzing ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Bot size={14} />
                    )}
                    <span>Fix with ChatGPT</span>
                  </button>

                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={(e) => handleFixOnSuggestion(e, 'gemini')}
                    disabled={isAnalyzing || !imageUrl}
                    style={{
                      padding: '8px 10px',
                      fontSize: '0.82rem',
                      whiteSpace: 'nowrap',
                      gap: '4px',
                    }}
                    title="Fix with Google Gemini"
                  >
                    <Zap size={13} color="#fae084" />
                    <span>Gemini</span>
                  </button>
                </div>
              </div>

              {/* Quick Suggestion Pills */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginRight: '2px' }}>
                  Quick fixes:
                </span>
                {[
                  { label: 'Silver-tone Rhodium', val: 'Metal appearance is Silver-tone rhodium finish' },
                  { label: 'American Diamond Accents', val: 'Accent stones are American Diamond (CZ)' },
                  { label: 'Oval Emerald Center', val: 'Centre-stone is oval emerald green simulant' },
                  { label: '22K Gold Plating', val: 'Plating is 22K Gold Plated' },
                  { label: 'Ornate Statement', val: 'Design style is ornate statement design' },
                  { label: 'Code under [E] Emerald', val: 'Set stone code to [E] Emerald Simulant' },
                  { label: 'Code under [D] Diamond', val: 'Set stone code to [D] American Diamond' },
                ].map((pill, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleApplyQuickSuggestion(pill.val)}
                    style={{
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid rgba(212, 175, 55, 0.25)',
                      borderRadius: '14px',
                      padding: '3px 9px',
                      fontSize: '0.72rem',
                      color: '#fae084',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(212, 175, 55, 0.15)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
                    }}
                  >
                    + {pill.label}
                  </button>
                ))}
              </div>
            </div>

            {/* VISUAL EVIDENCE & ATTRIBUTE BREAKDOWN TABLE */}
            {detectedAttributes.length > 0 && (
              <div
                style={{
                  marginBottom: '20px',
                  borderRadius: '10px',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  background: 'rgba(0, 0, 0, 0.25)',
                  overflow: 'hidden',
                }}
              >
                <div
                  onClick={() => setShowAttributesTable(!showAttributesTable)}
                  style={{
                    padding: '10px 14px',
                    background: 'rgba(255, 255, 255, 0.03)',
                    borderBottom: showAttributesTable ? '1px solid rgba(255, 255, 255, 0.08)' : 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Sliders size={14} color="#fae084" />
                    <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#ffffff' }}>
                      Attribute Verification & Optical Evidence ({detectedAttributes.length} Attributes)
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-dim)' }}>
                    <span style={{ fontSize: '0.72rem' }}>
                      {showAttributesTable ? 'Hide Table' : 'Show Table'}
                    </span>
                    {showAttributesTable ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </div>
                </div>

                {showAttributesTable && (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                      <thead>
                        <tr
                          style={{
                            borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                            background: 'rgba(255, 255, 255, 0.02)',
                            color: 'var(--text-dim)',
                            fontSize: '0.72rem',
                            textTransform: 'uppercase',
                          }}
                        >
                          <th style={{ padding: '8px 12px', textAlign: 'left', width: '25%' }}>Attribute</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left', width: '45%' }}>Detected / Value</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left', width: '30%' }}>Evidence & Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detectedAttributes.map((attr, idx) => {
                          const isConfirmed = attr.status === 'confirmed' || attr.evidence.toLowerCase().includes('seller');
                          const isReq = attr.status === 'confirmation_required' || attr.evidence.toLowerCase().includes('cannot');

                          return (
                            <tr
                              key={idx}
                              style={{
                                borderBottom: '1px solid rgba(255, 255, 255, 0.03)',
                              }}
                            >
                              <td style={{ padding: '7px 12px', color: 'var(--text-muted)', fontWeight: 500 }}>
                                {attr.attribute}
                              </td>
                              <td style={{ padding: '7px 12px', color: '#ffffff', fontWeight: 600 }}>
                                {attr.value}
                              </td>
                              <td style={{ padding: '7px 12px' }}>
                                <span
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '4px',
                                    padding: '2px 7px',
                                    borderRadius: '4px',
                                    fontSize: '0.7rem',
                                    fontWeight: 500,
                                    background: isConfirmed
                                      ? 'rgba(212, 175, 55, 0.15)'
                                      : isReq
                                      ? 'rgba(245, 158, 11, 0.15)'
                                      : 'rgba(16, 185, 129, 0.12)',
                                    color: isConfirmed
                                      ? '#fae084'
                                      : isReq
                                      ? '#fbbf24'
                                      : '#34d399',
                                    border: `1px solid ${
                                      isConfirmed
                                        ? 'rgba(212, 175, 55, 0.3)'
                                        : isReq
                                        ? 'rgba(245, 158, 11, 0.3)'
                                        : 'rgba(16, 185, 129, 0.25)'
                                    }`,
                                  }}
                                >
                                  {attr.evidence}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Piece Name / Title (SEO-Ready) */}
            <div style={{ marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                <label className="input-label" style={{ margin: 0 }}>
                  Piece Title (SEO & E-Commerce Ready) *
                </label>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                  Auto-generated &bull; Fully editable
                </span>
              </div>
              <input
                type="text"
                className="input-field"
                placeholder="e.g. Emerald Green & CZ Rhodium Plated Ornate Pendant Set with Earrings"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            {/* Coding Scheme Selectors: Type + Stone + Color + Serial */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '12px',
                marginBottom: '20px',
              }}
            >
              {/* Product Type */}
              <div>
                <label className="input-label">Product Type Code</label>
                <select
                  className="select-field"
                  value={typeCode}
                  onChange={(e) => setTypeCode(e.target.value)}
                >
                  {codeTables.types.map((t) => (
                    <option key={t.code} value={t.code}>
                      [{t.code}] {t.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Stone / Material */}
              <div>
                <label className="input-label">Stone / Material Code</label>
                <select
                  className="select-field"
                  value={stoneCode}
                  onChange={(e) => setStoneCode(e.target.value)}
                >
                  {codeTables.stones.map((s) => (
                    <option key={s.code} value={s.code}>
                      [{s.code}] {s.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Color / Tone */}
              <div>
                <label className="input-label">Color / Tone Code</label>
                <select
                  className="select-field"
                  value={colorCode}
                  onChange={(e) => setColorCode(e.target.value)}
                >
                  {codeTables.colors.map((c) => (
                    <option key={c.code} value={c.code}>
                      [{c.code}] {c.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Serial Number */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <label className="input-label" style={{ margin: 0 }}>Serial Sequence (5 Digits)</label>
                  <span style={{ fontSize: '0.68rem', color: '#10b981', fontWeight: 600 }}>Auto-Assigned</span>
                </div>
                <input
                  type="text"
                  className="input-field"
                  value={serial}
                  onChange={(e) => setSerial(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))}
                  placeholder="00001"
                  title="5-digit sequential hallmark number. Auto-assigned on save."
                />
              </div>
            </div>

            {/* Specifications & Notes (SEO / AEO / GEO Formatted) */}
            <div style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                <label className="input-label" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <FileText size={14} color="#fae084" />
                  <span>Product Specifications & Description (SEO, AEO & GEO Formatted)</span>
                </label>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                  Auto-formatted for Search Engines, Voice & AI Assistants
                </span>
              </div>
              <textarea
                className="textarea-field"
                rows={5}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Product Overview, Inclusions, Gemstones, Metal Plating, Occasion, and Care Tips..."
                style={{ resize: 'vertical', fontFamily: 'var(--font-sans)', fontSize: '0.86rem', lineHeight: 1.5 }}
              />
            </div>

            {/* Financial & Inventory Fields */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: '12px',
                marginBottom: '16px',
              }}
            >
              {/* Buying Price */}
              <div>
                <label className="input-label">Cost / Buying (₹)</label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  className="input-field"
                  value={buyingPrice}
                  onChange={(e) => setBuyingPrice(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder="0.00"
                />
              </div>

              {/* Selling Price */}
              <div>
                <label className="input-label">Retail / Selling (₹)</label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  className="input-field"
                  value={sellingPrice}
                  onChange={(e) => setSellingPrice(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder="0.00"
                />
              </div>

              {/* Quantity */}
              <div>
                <label className="input-label">Stock Quantity</label>
                <input
                  type="number"
                  min="0"
                  className="input-field"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder="0"
                />
              </div>

              {/* Reorder Level */}
              <div>
                <label className="input-label">Reorder Level</label>
                <input
                  type="number"
                  min="0"
                  className="input-field"
                  value={reorderLevel}
                  onChange={(e) => setReorderLevel(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder="3"
                />
              </div>
            </div>

            {/* Live Financial Health Ribbon */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: '10px',
                padding: '12px 14px',
                borderRadius: '10px',
                background: 'rgba(212, 175, 55, 0.08)',
                border: '1px solid rgba(212, 175, 55, 0.25)',
                marginBottom: '18px',
              }}
            >
              <div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Unit Profit</div>
                <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#34d399' }}>
                  {formatCurrency(financials.unitProfit)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Profit Margin</div>
                <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#fae084' }}>
                  {financials.marginPercent}%
                </div>
              </div>
              <div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Markup %</div>
                <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#60a5fa' }}>
                  {financials.markupPercent}%
                </div>
              </div>
              <div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Total Lot Retail</div>
                <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#ffffff' }}>
                  {formatCurrency(financials.totalRetail)}
                </div>
              </div>
            </div>

            {/* Vendor / Artisan Atelier */}
            <div style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                <label className="input-label" style={{ margin: 0 }}>
                  Vendor / Artisan Atelier
                </label>
                <button
                  type="button"
                  onClick={() => setShowQuickAddVendor(!showQuickAddVendor)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent-gold)',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '2px 6px',
                  }}
                >
                  <Users size={12} />
                  <span>{showQuickAddVendor ? 'Cancel Quick Add' : '+ New Artisan'}</span>
                </button>
              </div>

              {/* Inline Quick Add Artisan Box */}
              {showQuickAddVendor && (
                <div
                  style={{
                    marginBottom: '12px',
                    padding: '12px 14px',
                    borderRadius: '8px',
                    background: 'rgba(212, 175, 55, 0.08)',
                    border: '1px solid rgba(212, 175, 55, 0.25)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                  }}
                >
                  <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#ffffff' }}>
                    Quick Register New Artisan
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr', gap: '8px' }}>
                    <input
                      type="text"
                      maxLength={5}
                      className="input-field"
                      placeholder="Code (e.g. RJJ)"
                      value={quickVendorCode}
                      onChange={(e) => setQuickVendorCode(e.target.value.toUpperCase())}
                      style={{ height: '32px', fontSize: '0.8rem', fontWeight: 700 }}
                    />
                    <input
                      type="text"
                      className="input-field"
                      placeholder="Artisan / Workshop Name *"
                      value={quickVendorName}
                      onChange={(e) => setQuickVendorName(e.target.value)}
                      style={{ height: '32px', fontSize: '0.8rem' }}
                    />
                    <input
                      type="text"
                      className="input-field"
                      placeholder="City (e.g. Jaipur)"
                      value={quickVendorCity}
                      onChange={(e) => setQuickVendorCity(e.target.value)}
                      style={{ height: '32px', fontSize: '0.8rem' }}
                    />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setShowQuickAddVendor(false)}
                      style={{ height: '28px', fontSize: '0.74rem', padding: '0 10px' }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={handleCreateQuickVendor}
                      style={{ height: '28px', fontSize: '0.74rem', padding: '0 12px' }}
                    >
                      Save & Link
                    </button>
                  </div>
                </div>
              )}

              <input
                type="text"
                list="registered-vendors-datalist"
                className="input-field"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                placeholder="Select or type artisan name / workshop"
              />
              <datalist id="registered-vendors-datalist">
                {vendors.map((v) => (
                  <option key={v.id} value={v.name}>
                    {v.code} - {v.city || 'Atelier'} ({v.specialty || 'Jewelry'})
                  </option>
                ))}
              </datalist>

              {/* Quick Select Artisan Pills */}
              {vendors.length > 0 && (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
                  {vendors.slice(0, 4).map((v) => {
                    const isCurrent = vendor.toLowerCase() === v.name.toLowerCase() || vendor.toLowerCase() === v.code.toLowerCase();
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => setVendor(v.name)}
                        style={{
                          background: isCurrent ? 'rgba(212, 175, 55, 0.2)' : 'rgba(255, 255, 255, 0.04)',
                          border: `1px solid ${isCurrent ? 'rgba(212, 175, 55, 0.5)' : 'var(--border-subtle)'}`,
                          color: isCurrent ? '#fae084' : 'var(--text-muted)',
                          padding: '2px 8px',
                          borderRadius: '12px',
                          fontSize: '0.72rem',
                          cursor: 'pointer',
                        }}
                      >
                        {v.code}: {v.name.split(' ')[0]}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Multi-Channel Marketplace & Safety Buffer Reserve */}
            <div
              style={{
                marginBottom: '20px',
                padding: '14px 16px',
                borderRadius: '10px',
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <div
                onClick={() => setShowMarketplacesSection(!showMarketplacesSection)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                    Multi-Channel Listing & Safety Reserve
                  </span>
                  <span
                    style={{
                      fontSize: '0.7rem',
                      padding: '2px 7px',
                      borderRadius: '12px',
                      background: 'rgba(212, 175, 55, 0.15)',
                      color: 'var(--accent-gold)',
                      border: '1px solid rgba(212, 175, 55, 0.3)',
                    }}
                  >
                    SaazAura.com {isListedOnAmazon ? '+ Amazon' : ''} {isListedOnMyntra ? '+ Myntra' : ''}
                  </span>
                </div>
                <div style={{ color: 'var(--text-muted)' }}>
                  {showMarketplacesSection ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </div>

              {showMarketplacesSection && (
                <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {/* Safety Buffer Reserve */}
                  <div
                    style={{
                      padding: '10px 12px',
                      borderRadius: '8px',
                      background: 'rgba(245, 158, 11, 0.08)',
                      border: '1px solid rgba(245, 158, 11, 0.25)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                      <label className="input-label" style={{ margin: 0, color: '#f59e0b', fontWeight: 600 }}>
                        Safety Reserve Buffer (Offline / Boutique Protection)
                      </label>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        Available for Online Feeds:{' '}
                        <strong style={{ color: '#10b981' }}>
                          {Math.max(0, (Number(quantity) || 0) - (Number(safetyReserve) || 0))} pcs
                        </strong>
                      </span>
                    </div>
                    <input
                      type="number"
                      min="0"
                      max={Number(quantity) || 0}
                      className="input-field"
                      value={safetyReserve}
                      onChange={(e) => setSafetyReserve(e.target.value === '' ? '' : parseInt(e.target.value) || 0)}
                      placeholder="e.g. 1"
                      style={{ height: '36px' }}
                    />
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', marginTop: '4px' }}>
                      Reserved stock will NOT be published to Amazon or Myntra feeds, preventing boutique overselling.
                    </div>
                  </div>

                  {/* Amazon Listing */}
                  <div
                    style={{
                      padding: '10px 12px',
                      borderRadius: '8px',
                      background: isListedOnAmazon ? 'rgba(245, 158, 11, 0.05)' : 'transparent',
                      border: '1px solid var(--border-subtle)',
                    }}
                  >
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginBottom: isListedOnAmazon ? '8px' : '0' }}>
                      <input
                        type="checkbox"
                        checked={isListedOnAmazon}
                        onChange={(e) => setIsListedOnAmazon(e.target.checked)}
                        style={{ accentColor: 'var(--accent-gold)', width: '16px', height: '16px' }}
                      />
                      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        List on Amazon India
                      </span>
                    </label>

                    {isListedOnAmazon && (
                      <div>
                        <label className="input-label" style={{ fontSize: '0.75rem' }}>Amazon ASIN / Merchant SKU</label>
                        <input
                          type="text"
                          className="input-field"
                          value={amazonAsin}
                          onChange={(e) => setAmazonAsin(e.target.value)}
                          placeholder="e.g. B09XYZ4321"
                          style={{ height: '36px' }}
                        />
                      </div>
                    )}
                  </div>

                  {/* Myntra Listing */}
                  <div
                    style={{
                      padding: '10px 12px',
                      borderRadius: '8px',
                      background: isListedOnMyntra ? 'rgba(236, 72, 153, 0.05)' : 'transparent',
                      border: '1px solid var(--border-subtle)',
                    }}
                  >
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginBottom: isListedOnMyntra ? '8px' : '0' }}>
                      <input
                        type="checkbox"
                        checked={isListedOnMyntra}
                        onChange={(e) => setIsListedOnMyntra(e.target.checked)}
                        style={{ accentColor: '#ec4899', width: '16px', height: '16px' }}
                      />
                      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                        List on Myntra Partner Portal
                      </span>
                    </label>

                    {isListedOnMyntra && (
                      <div>
                        <label className="input-label" style={{ fontSize: '0.75rem' }}>Myntra Style ID / Portal SKU</label>
                        <input
                          type="text"
                          className="input-field"
                          value={myntraStyleId}
                          onChange={(e) => setMyntraStyleId(e.target.value)}
                          placeholder="e.g. MYN-8849201"
                          style={{ height: '36px' }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Actions */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingTop: '16px',
                borderTop: '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                Review and modify any field before confirming.
              </div>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <button type="button" className="btn-secondary" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={isAnalyzing}
                  onClick={() => { shouldPrintRef.current = false; }}
                >
                  {itemToEdit ? 'Save Changes' : 'Approve & Mint Global SKU'}
                </button>
                {!itemToEdit && onSaveAndPrint && (
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={isAnalyzing}
                    onClick={() => { shouldPrintRef.current = true; }}
                    style={{
                      background: 'linear-gradient(135deg, #059669 0%, #047857 100%)',
                      borderColor: '#10b981',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                    title="Mint 5-digit SKU and immediately open physical jewelry tag printer"
                  >
                    <span>Mint & Print Tag 🏷️</span>
                  </button>
                )}
              </div>
            </div>
          </form>
        </div>
      </div>

      {/* Layer 2 Duplicate Combo Modal Dialog */}
      {duplicateWarning && duplicateWarning.conflictingItem && (
        <DuplicateWarningModal
          conflictingItem={duplicateWarning.conflictingItem}
          suggestedSerial={duplicateWarning.suggestedSerial || '00002'}
          suggestedSku={duplicateWarning.suggestedSku || currentSku}
          incomingQty={Number(quantity) || 1}
          onAddQuantityToExisting={(existingItem, addedQty) => {
            onRestockExisting(existingItem, addedQty);
            setDuplicateWarning(null);
            onClose();
          }}
          onProceedAsNewVariation={(newSerial, newSku) => {
            setSerial(newSerial);
            setDuplicateWarning(null);
            finalizeSave(newSku, newSerial);
          }}
          onCancel={() => setDuplicateWarning(null)}
        />
      )}

      {/* AI Settings Modal */}
      {isAiSettingsOpen && (
        <AiSettingsModal
          onClose={() => setIsAiSettingsOpen(false)}
          onSaved={() => setHasApiKey(Boolean(getStoredAiConfig().apiKey))}
        />
      )}

      {/* Cloud Media Library Selector */}
      {isMediaPickerOpen && (
        <MediaLibraryModal
          isOpen={isMediaPickerOpen}
          onClose={() => setIsMediaPickerOpen(false)}
          inventory={inventory}
          onOpenStorageSettings={() => {}}
          onSelectForProduct={(asset) => {
            setImageUrl(asset.primary_url || asset.thumbnail_url || '');
            if (asset.checksum_sha256) {
              setImageHash(asset.checksum_sha256);
            }
            setIsMediaPickerOpen(false);
          }}
          targetProduct={itemToEdit || null}
        />
      )}
    </>
  );
};
