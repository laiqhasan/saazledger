import React, { useState, useEffect, useRef } from 'react';
import type { MediaAsset, MediaSlotType } from '../types/media';
import type { JewelryItem } from '../types/inventory';
import {
  fetchMediaAssets,
  uploadMediaDirect,
  deleteMediaAsset,
  linkMediaToProduct,
  unlinkMediaFromProduct,
} from '../services/mediaService';
import {
  X,
  Search,
  Upload,
  Image as ImageIcon,
  CheckCircle2,
  ExternalLink,
  Trash2,
  Cloud,
  Sliders,
  RefreshCw,
  FolderOpen,
} from 'lucide-react';

interface MediaLibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
  inventory: JewelryItem[];
  onOpenStorageSettings: () => void;
  onSelectForProduct?: (media: MediaAsset, slotType: MediaSlotType) => void;
  targetProduct?: JewelryItem | null;
}

export const MediaLibraryModal: React.FC<MediaLibraryModalProps> = ({
  isOpen,
  onClose,
  inventory,
  onOpenStorageSettings,
  onSelectForProduct,
  targetProduct,
}) => {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMediaType, setSelectedMediaType] = useState<string>('all');
  const [selectedProvider, setSelectedProvider] = useState<string>('all');
  const [selectedApproval, setSelectedApproval] = useState<string>('all');
  const [linkFilter, setLinkFilter] = useState<'all' | 'linked' | 'unlinked'>('all');

  // Selected Asset for Detail Drawer
  const [selectedAsset, setSelectedAsset] = useState<MediaAsset | null>(null);

  // Upload state
  const [isUploading, setIsUploading] = useState(false);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Link to Product Selector State inside Drawer
  const [linkSkuInput, setLinkSkuInput] = useState('');
  const [selectedSlot, setSelectedSlot] = useState<MediaSlotType>('gallery');

  const loadMedia = async () => {
    setIsLoading(true);
    try {
      const res = await fetchMediaAssets({
        search: searchQuery || undefined,
        mediaType: selectedMediaType !== 'all' ? (selectedMediaType as any) : undefined,
        provider: selectedProvider !== 'all' ? (selectedProvider as any) : undefined,
        approvalStatus: selectedApproval !== 'all' ? (selectedApproval as any) : undefined,
        isLinked: linkFilter === 'all' ? undefined : linkFilter === 'linked',
        limit: 80,
      });
      setAssets(res.assets);
      setTotalCount(res.totalCount);

      if (selectedAsset) {
        const refreshed = res.assets.find((a) => a.id === selectedAsset.id);
        if (refreshed) setSelectedAsset(refreshed);
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadMedia();
    }
  }, [isOpen, searchQuery, selectedMediaType, selectedProvider, selectedApproval, linkFilter]);

  if (!isOpen) return null;

  // Handle Multi-file Upload
  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsUploading(true);
    setUploadNotice(`Uploading ${files.length} file(s) to cloud media library...`);

    let uploadedCount = 0;
    let duplicateCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const reader = new FileReader();

      await new Promise<void>((resolve) => {
        reader.onload = async (e) => {
          const base64Data = e.target?.result as string;
          if (base64Data) {
            const res = await uploadMediaDirect({
              base64Data,
              filename: file.name,
              displayTitle: file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' '),
              productId: targetProduct?.id,
              slotType: targetProduct ? 'gallery' : undefined,
              approvalStatus: 'approved',
            });

            if (res) {
              if (res.isDuplicate) duplicateCount++;
              else uploadedCount++;
            }
          }
          resolve();
        };
        reader.readAsDataURL(file);
      });
    }

    setIsUploading(false);
    setUploadNotice(
      `Upload complete: ${uploadedCount} new asset(s) ingested.${duplicateCount > 0 ? ` (${duplicateCount} duplicate bytes matched and linked)` : ''}`
    );
    setTimeout(() => setUploadNotice(null), 6000);
    loadMedia();
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  const handleAttachProduct = async (assetId: string) => {
    if (!linkSkuInput.trim()) return;
    const target = inventory.find(
      (i) => i.sku.toUpperCase() === linkSkuInput.trim().toUpperCase() || i.id === linkSkuInput.trim()
    );
    if (!target) {
      alert(`Product with SKU "${linkSkuInput}" not found in inventory.`);
      return;
    }

    await linkMediaToProduct({
      productId: target.id,
      mediaId: assetId,
      slotType: selectedSlot,
    });

    setLinkSkuInput('');
    loadMedia();
  };

  const handleUnlink = async (productId: string, mediaId: string, slotType?: string) => {
    await unlinkMediaFromProduct(productId, mediaId, slotType);
    loadMedia();
  };

  const handleDelete = async (assetId: string) => {
    if (window.confirm('Move this media asset to trash? Linked products will retain their other media.')) {
      await deleteMediaAsset(assetId);
      if (selectedAsset?.id === assetId) setSelectedAsset(null);
      loadMedia();
    }
  };

  return (
    <div className="modal-overlay">
      <div
        className="modal-content"
        style={{
          maxWidth: '1280px',
          height: '92vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          overflow: 'hidden',
          background: 'var(--bg-card)',
        }}
      >
        {/* Header Bar */}
        <div
          style={{
            padding: '16px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'var(--bg-surface)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '10px',
                background: 'rgba(212, 175, 55, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--gold)',
              }}
            >
              <Cloud size={22} />
            </div>
            <div>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                Cloud Media Library
              </h2>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
                Amazon S3 & Google Drive Provider-Independent Vault · {totalCount} assets cataloged
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              onClick={onOpenStorageSettings}
              className="btn btn-secondary"
              style={{ padding: '7px 14px', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Sliders size={15} />
              Storage Settings
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="btn btn-primary"
              disabled={isUploading}
              style={{ padding: '7px 16px', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Upload size={15} />
              Upload Files
            </button>
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              multiple
              accept="image/*,video/*"
              onChange={(e) => handleFiles(e.target.files)}
            />
            <button
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: '6px',
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Upload Banner / Drag notification */}
        {uploadNotice && (
          <div
            style={{
              padding: '8px 24px',
              background: 'rgba(16, 185, 129, 0.15)',
              color: 'var(--success)',
              fontSize: '0.85rem',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              borderBottom: '1px solid rgba(16, 185, 129, 0.3)',
            }}
          >
            <CheckCircle2 size={16} />
            {uploadNotice}
          </div>
        )}

        {/* Search & Filter Controls */}
        <div
          style={{
            padding: '12px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '12px',
            alignItems: 'center',
            background: 'var(--bg-card)',
          }}
        >
          {/* Search Input */}
          <div style={{ position: 'relative', flex: '1 1 240px' }}>
            <Search
              size={16}
              style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}
            />
            <input
              type="text"
              className="form-control"
              placeholder="Search by title, SKU, or filename..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ paddingLeft: '36px', height: '36px', fontSize: '0.85rem' }}
            />
          </div>

          {/* Provider Filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Provider:</span>
            <select
              className="form-control"
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value)}
              style={{ height: '36px', fontSize: '0.85rem', width: 'auto' }}
            >
              <option value="all">All Providers</option>
              <option value="s3">Amazon S3</option>
              <option value="google_drive">Google Drive</option>
              <option value="local_disk">Local Vault</option>
            </select>
          </div>

          {/* Media Type Filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Type:</span>
            <select
              className="form-control"
              value={selectedMediaType}
              onChange={(e) => setSelectedMediaType(e.target.value)}
              style={{ height: '36px', fontSize: '0.85rem', width: 'auto' }}
            >
              <option value="all">All Types</option>
              <option value="image">Photos</option>
              <option value="video">Videos</option>
            </select>
          </div>

          {/* Approval Filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Approval:</span>
            <select
              className="form-control"
              value={selectedApproval}
              onChange={(e) => setSelectedApproval(e.target.value)}
              style={{ height: '36px', fontSize: '0.85rem', width: 'auto' }}
            >
              <option value="all">All Status</option>
              <option value="approved">Approved</option>
              <option value="pending_review">Pending Review</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>

          {/* Linkage Filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Links:</span>
            <select
              className="form-control"
              value={linkFilter}
              onChange={(e) => setLinkFilter(e.target.value as any)}
              style={{ height: '36px', fontSize: '0.85rem', width: 'auto' }}
            >
              <option value="all">All Media</option>
              <option value="linked">Linked to Piece</option>
              <option value="unlinked">Unlinked / Free</option>
            </select>
          </div>

          <button
            onClick={loadMedia}
            className="btn btn-secondary"
            title="Refresh Library"
            style={{ padding: '7px 10px', height: '36px' }}
          >
            <RefreshCw size={15} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Main Content Area (Grid + Optional Right Drawer) */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Gallery Dropzone & Grid */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '20px',
              position: 'relative',
              background: isDragOver ? 'rgba(212, 175, 55, 0.05)' : 'transparent',
              border: isDragOver ? '2px dashed var(--gold)' : 'none',
              transition: 'all 0.2s',
            }}
          >
            {isDragOver && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(0, 0, 0, 0.65)',
                  zIndex: 10,
                  color: 'var(--gold)',
                  fontSize: '1.2rem',
                  fontWeight: 600,
                  gap: '12px',
                }}
              >
                <Upload size={32} />
                Drop media files here to upload into Cloud Library
              </div>
            )}

            {assets.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)' }}>
                <FolderOpen size={48} style={{ opacity: 0.4, margin: '0 auto 16px' }} />
                <h3 style={{ fontSize: '1.1rem', color: 'var(--text-primary)', marginBottom: '6px' }}>
                  No media assets found
                </h3>
                <p style={{ fontSize: '0.85rem', maxWidth: '400px', margin: '0 auto 16px' }}>
                  Drag and drop jewelry photos anywhere or click "Upload Files" to catalog original photography.
                </p>
                <button onClick={() => fileInputRef.current?.click()} className="btn btn-primary" style={{ fontSize: '0.85rem' }}>
                  Select Photos
                </button>
              </div>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                  gap: '16px',
                }}
              >
                {assets.map((asset) => {
                  const isSelected = selectedAsset?.id === asset.id;
                  const displayImg = asset.thumbnail_url || asset.primary_url;

                  return (
                    <div
                      key={asset.id}
                      onClick={() => setSelectedAsset(asset)}
                      style={{
                        background: 'var(--bg-surface)',
                        borderRadius: '10px',
                        border: isSelected ? '2px solid var(--gold)' : '1px solid var(--border-subtle)',
                        overflow: 'hidden',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        transition: 'transform 0.15s, border-color 0.15s',
                        boxShadow: isSelected ? '0 0 14px rgba(212, 175, 55, 0.3)' : 'none',
                      }}
                    >
                      {/* Image Thumbnail Box */}
                      <div
                        style={{
                          height: '140px',
                          background: '#0d1117',
                          position: 'relative',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          overflow: 'hidden',
                        }}
                      >
                        {displayImg ? (
                          <img
                            src={displayImg}
                            alt={asset.display_title}
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            loading="lazy"
                          />
                        ) : (
                          <ImageIcon size={32} style={{ color: 'var(--text-muted)' }} />
                        )}

                        {/* Provider Badge */}
                        <div
                          style={{
                            position: 'absolute',
                            top: '6px',
                            left: '6px',
                            fontSize: '0.65rem',
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: '4px',
                            background:
                              asset.provider === 's3'
                                ? 'rgba(245, 158, 11, 0.9)'
                                : asset.provider === 'google_drive'
                                ? 'rgba(59, 130, 246, 0.9)'
                                : 'rgba(30, 41, 59, 0.85)',
                            color: '#fff',
                            textTransform: 'uppercase',
                          }}
                        >
                          {asset.provider === 's3' ? 'S3' : asset.provider === 'google_drive' ? 'Drive' : 'Local'}
                        </div>

                        {/* Linked Product Pill */}
                        {asset.linked_products && asset.linked_products.length > 0 && (
                          <div
                            style={{
                              position: 'absolute',
                              bottom: '6px',
                              left: '6px',
                              fontSize: '0.65rem',
                              fontWeight: 600,
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: 'rgba(16, 185, 129, 0.9)',
                              color: '#fff',
                            }}
                          >
                            {asset.linked_products[0].productSku}
                          </div>
                        )}
                      </div>

                      {/* Card Meta */}
                      <div style={{ padding: '10px' }}>
                        <div
                          style={{
                            fontSize: '0.8rem',
                            fontWeight: 600,
                            color: 'var(--text-primary)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                          title={asset.display_title}
                        >
                          {asset.display_title}
                        </div>
                        <div
                          style={{
                            fontSize: '0.7rem',
                            color: 'var(--text-secondary)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            marginTop: '4px',
                          }}
                        >
                          <span>{(asset.byte_size / 1024).toFixed(0)} KB</span>
                          <span style={{ color: asset.approval_status === 'approved' ? 'var(--success)' : 'var(--warning)' }}>
                            {asset.approval_status === 'approved' ? 'Approved' : 'Pending'}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right Inspector Drawer */}
          {selectedAsset && (
            <div
              style={{
                width: '380px',
                borderLeft: '1px solid var(--border-subtle)',
                background: 'var(--bg-surface)',
                display: 'flex',
                flexDirection: 'column',
                overflowY: 'auto',
              }}
            >
              {/* Drawer Header */}
              <div
                style={{
                  padding: '14px 18px',
                  borderBottom: '1px solid var(--border-subtle)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Media Asset Details
                </div>
                <button
                  onClick={() => setSelectedAsset(null)}
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
                >
                  <X size={16} />
                </button>
              </div>

              {/* Large Image Preview */}
              <div style={{ padding: '16px', borderBottom: '1px solid var(--border-subtle)' }}>
                <div
                  style={{
                    width: '100%',
                    height: '220px',
                    borderRadius: '8px',
                    background: '#0d1117',
                    overflow: 'hidden',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {selectedAsset.primary_url ? (
                    <img
                      src={selectedAsset.primary_url}
                      alt={selectedAsset.display_title}
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                    />
                  ) : (
                    <ImageIcon size={48} style={{ color: 'var(--text-muted)' }} />
                  )}
                </div>

                <div style={{ marginTop: '12px' }}>
                  <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {selectedAsset.display_title}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                    {selectedAsset.original_filename}
                  </div>
                </div>

                {onSelectForProduct && (
                  <button
                    onClick={() => {
                      onSelectForProduct(selectedAsset, 'cover');
                      onClose();
                    }}
                    className="btn btn-primary"
                    style={{ width: '100%', marginTop: '12px', padding: '8px 12px', fontSize: '0.85rem' }}
                  >
                    Select as Product Photo
                  </button>
                )}
              </div>

              {/* Technical Specifications */}
              <div style={{ padding: '16px', borderBottom: '1px solid var(--border-subtle)', fontSize: '0.8rem' }}>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
                  Storage Metadata
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '6px', color: 'var(--text-secondary)' }}>
                  <span>Provider:</span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600, textTransform: 'uppercase' }}>
                    {selectedAsset.provider}
                  </span>

                  <span>Format:</span>
                  <span style={{ color: 'var(--text-primary)' }}>{selectedAsset.mime_type}</span>

                  <span>Size:</span>
                  <span style={{ color: 'var(--text-primary)' }}>{(selectedAsset.byte_size / 1024).toFixed(1)} KB</span>

                  <span>SHA-256:</span>
                  <span style={{ fontFamily: 'monospace', fontSize: '0.7rem', wordBreak: 'break-all' }}>
                    {selectedAsset.checksum_sha256.slice(0, 24)}...
                  </span>

                  <span>Cataloged:</span>
                  <span>{new Date(selectedAsset.created_at).toLocaleDateString()}</span>
                </div>
              </div>

              {/* Linked Products Section */}
              <div style={{ padding: '16px', borderBottom: '1px solid var(--border-subtle)' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
                  Linked Jewelry Pieces ({selectedAsset.linked_products?.length || 0})
                </div>

                {selectedAsset.linked_products && selectedAsset.linked_products.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {selectedAsset.linked_products.map((lp) => (
                      <div
                        key={`${lp.productId}-${lp.slotType}`}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '6px 10px',
                          background: 'var(--bg-card)',
                          borderRadius: '6px',
                          fontSize: '0.75rem',
                        }}
                      >
                        <div>
                          <span style={{ fontWeight: 700, color: 'var(--gold)' }}>{lp.productSku}</span> —{' '}
                          <span style={{ color: 'var(--text-primary)' }}>{lp.productTitle}</span>{' '}
                          <span style={{ color: 'var(--text-muted)' }}>({lp.slotType})</span>
                        </div>
                        <button
                          onClick={() => handleUnlink(lp.productId, selectedAsset.id, lp.slotType)}
                          title="Unlink from product"
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--text-muted)',
                            cursor: 'pointer',
                          }}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0 0 10px' }}>
                    This asset is currently free / not attached to any jewelry SKU.
                  </p>
                )}

                {/* Attach to Piece Input */}
                <div style={{ marginTop: '12px' }}>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="Enter SKU (e.g. CHKP99001)..."
                      value={linkSkuInput}
                      onChange={(e) => setLinkSkuInput(e.target.value)}
                      style={{ height: '32px', fontSize: '0.8rem', flex: 1 }}
                    />
                    <select
                      className="form-control"
                      value={selectedSlot}
                      onChange={(e) => setSelectedSlot(e.target.value as any)}
                      style={{ height: '32px', fontSize: '0.8rem', width: '90px' }}
                    >
                      <option value="cover">Cover</option>
                      <option value="front">Front</option>
                      <option value="back">Back</option>
                      <option value="close_up">Close-up</option>
                      <option value="model">Model</option>
                      <option value="gallery">Gallery</option>
                    </select>
                    <button
                      onClick={() => handleAttachProduct(selectedAsset.id)}
                      className="btn btn-secondary"
                      style={{ height: '32px', padding: '0 10px', fontSize: '0.8rem' }}
                    >
                      Attach
                    </button>
                  </div>
                </div>
              </div>

              {/* Actions Footer */}
              <div style={{ padding: '16px', marginTop: 'auto', display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => handleDelete(selectedAsset.id)}
                  className="btn btn-secondary"
                  style={{
                    flex: 1,
                    padding: '8px',
                    fontSize: '0.8rem',
                    color: 'var(--danger)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                  }}
                >
                  <Trash2 size={14} />
                  Move to Trash
                </button>
                {selectedAsset.primary_url && (
                  <a
                    href={selectedAsset.primary_url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-secondary"
                    style={{
                      padding: '8px 12px',
                      fontSize: '0.8rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                    }}
                  >
                    <ExternalLink size={14} />
                    Open
                  </a>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
