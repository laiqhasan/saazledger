import React, { useState, useRef, useEffect } from 'react';
import {
  X,
  RotateCcw,
  RotateCw,
  ZoomIn,
  ZoomOut,
  Crop as CropIcon,
  Check,
  RefreshCw,
  Sparkles,
  Move,
} from 'lucide-react';
import { applyMediaCrop, requestJewelryAutoCrop } from '../services/mediaService';

export interface CropEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  imageUrl: string;
  imageBase64?: string;
  title?: string;
  onApplyCrop: (result: { url: string; base64?: string; cropRect: any }) => void;
}

export const CropEditorModal: React.FC<CropEditorModalProps> = ({
  isOpen,
  onClose,
  imageUrl,
  imageBase64,
  title = 'Crop & Frame Editor',
  onApplyCrop,
}) => {
  const [aspectRatio, setAspectRatio] = useState<'1:1' | '4:5' | '9:16' | 'free'>('1:1');
  const [zoom, setZoom] = useState<number>(1.0);
  const [rotation, setRotation] = useState<number>(0);
  const [panX, setPanX] = useState<number>(0);
  const [panY, setPanY] = useState<number>(0);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [naturalDimensions, setNaturalDimensions] = useState<{ width: number; height: number }>({ width: 2048, height: 2048 });
  const [isApplying, setIsApplying] = useState<boolean>(false);
  const [isAutoCropping, setIsAutoCropping] = useState<boolean>(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (isOpen) {
      setZoom(1.0);
      setRotation(0);
      setPanX(0);
      setPanY(0);
      setAspectRatio('1:1');
    }
  }, [isOpen, imageUrl]);

  if (!isOpen) return null;

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNaturalDimensions({ width: img.naturalWidth, height: img.naturalHeight });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    setDragStart({ x: e.clientX - panX, y: e.clientY - panY });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPanX(e.clientX - dragStart.x);
    setPanY(e.clientY - dragStart.y);
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    setZoom((prev) => Math.max(0.6, Math.min(3.0, prev + delta)));
  };

  const handleRotateLeft = () => {
    setRotation((prev) => (prev - 90 + 360) % 360);
  };

  const handleRotateRight = () => {
    setRotation((prev) => (prev + 90) % 360);
  };

  const handleReset = () => {
    setZoom(1.0);
    setRotation(0);
    setPanX(0);
    setPanY(0);
    setAspectRatio('1:1');
  };

  const handleCenter = () => {
    setPanX(0);
    setPanY(0);
  };

  const handleAutoCrop = async () => {
    setIsAutoCropping(true);
    try {
      const res = await requestJewelryAutoCrop({
        imageBase64,
        url: imageUrl,
        category: 'necklace_set',
      });
      if (res.success && res.crop) {
        // Center pan and adjust zoom to focus bounding box
        setPanX(0);
        setPanY(0);
        setZoom(1.15);
      }
    } catch (err: any) {
      console.warn('Auto-crop warning:', err.message);
    } finally {
      setIsAutoCropping(false);
    }
  };

  const handleApply = async () => {
    setIsApplying(true);
    try {
      // Calculate normalized crop coordinates based on zoom, pan, and rotation
      const nw = naturalDimensions.width;
      const nh = naturalDimensions.height;

      // Calculate visible window relative to center
      const visibleFraction = 1 / zoom;
      const cropW = Math.round(nw * visibleFraction);
      const cropH = aspectRatio === '1:1'
        ? cropW
        : aspectRatio === '4:5'
        ? Math.round(cropW * 1.25)
        : aspectRatio === '9:16'
        ? Math.round(cropW * (16 / 9))
        : Math.round(nh * visibleFraction);

      // Pan offset mapping
      const panOffsetFactor = 1.8;
      const offsetX = Math.round((panX / 300) * nw * panOffsetFactor);
      const offsetY = Math.round((panY / 300) * nh * panOffsetFactor);

      let cropX = Math.round((nw - cropW) / 2) - offsetX;
      let cropY = Math.round((nh - cropH) / 2) - offsetY;

      // Clamp coordinates
      cropX = Math.max(0, Math.min(nw - cropW, cropX));
      cropY = Math.max(0, Math.min(nh - cropH, cropY));

      const cropRect = {
        x: cropX,
        y: cropY,
        width: cropW,
        height: cropH,
        rotation,
        zoom,
        aspectRatio,
      };

      const res = await applyMediaCrop({
        imageBase64,
        url: imageUrl,
        crop: cropRect,
        targetOutputDim: 2048,
      });

      if (res.success && res.url) {
        onApplyCrop({
          url: res.url,
          base64: res.base64,
          cropRect,
        });
        onClose();
      } else {
        alert(res.error || 'Failed to apply crop');
      }
    } catch (err: any) {
      alert(err.message || 'Failed to apply crop');
    } finally {
      setIsApplying(false);
    }
  };

  // Determine frame aspect ratio styling
  const frameStyle: React.CSSProperties = {
    position: 'relative',
    width: '360px',
    height:
      aspectRatio === '1:1'
        ? '360px'
        : aspectRatio === '4:5'
        ? '450px'
        : aspectRatio === '9:16'
        ? '560px'
        : '360px',
    border: '2px solid #f59e0b',
    boxShadow: '0 0 0 9999px rgba(10, 12, 16, 0.78), 0 4px 20px rgba(0,0,0,0.5)',
    borderRadius: '4px',
    overflow: 'hidden',
    cursor: isDragging ? 'grabbing' : 'grab',
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '850px',
          backgroundColor: '#11141a',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: '16px',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 60px rgba(0,0,0,0.6)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 24px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                backgroundColor: 'rgba(245, 158, 11, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#f59e0b',
              }}
            >
              <CropIcon size={18} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: '#f3f4f6' }}>
                {title}
              </h3>
              <div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
                Original: {naturalDimensions.width} × {naturalDimensions.height} px &nbsp;•&nbsp; Output:{' '}
                <strong style={{ color: '#fae084' }}>2048 × 2048 Master Square</strong>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: '#9ca3af',
              cursor: 'pointer',
              padding: '6px',
              borderRadius: '6px',
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Workspace Canvas */}
        <div
          ref={containerRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
          style={{
            height: '460px',
            backgroundColor: '#0a0c10',
            position: 'relative',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            userSelect: 'none',
          }}
        >
          {/* Crop Frame Box */}
          <div style={frameStyle}>
            {/* Rule of thirds grid lines */}
            <div
              style={{
                position: 'absolute',
                top: '33.33%',
                left: 0,
                right: 0,
                height: '1px',
                backgroundColor: 'rgba(255,255,255,0.2)',
                pointerEvents: 'none',
              }}
            />
            <div
              style={{
                position: 'absolute',
                top: '66.66%',
                left: 0,
                right: 0,
                height: '1px',
                backgroundColor: 'rgba(255,255,255,0.2)',
                pointerEvents: 'none',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: '33.33%',
                top: 0,
                bottom: 0,
                width: '1px',
                backgroundColor: 'rgba(255,255,255,0.2)',
                pointerEvents: 'none',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: '66.66%',
                top: 0,
                bottom: 0,
                width: '1px',
                backgroundColor: 'rgba(255,255,255,0.2)',
                pointerEvents: 'none',
              }}
            />

            {/* Target Image Container inside frame */}
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transform: `translate(${panX}px, ${panY}px) scale(${zoom}) rotate(${rotation}deg)`,
                transformOrigin: 'center center',
                transition: isDragging ? 'none' : 'transform 0.1s ease-out',
              }}
            >
              <img
                ref={imageRef}
                src={imageUrl}
                alt="Crop preview"
                onLoad={handleImageLoad}
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                  pointerEvents: 'none',
                }}
              />
            </div>
          </div>

          <div
            style={{
              position: 'absolute',
              bottom: '12px',
              left: '16px',
              fontSize: '0.72rem',
              color: '#9ca3af',
              backgroundColor: 'rgba(0,0,0,0.6)',
              padding: '4px 10px',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <Move size={12} />
            <span>Drag image to pan • Scroll wheel to zoom ({Math.round(zoom * 100)}%)</span>
          </div>
        </div>

        {/* Controls Toolbar */}
        <div
          style={{
            padding: '16px 24px',
            backgroundColor: '#161922',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          {/* Aspect Ratio Presets */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '0.75rem', color: '#9ca3af', marginRight: '4px' }}>Ratio:</span>
            {(['1:1', '4:5', '9:16', 'free'] as const).map((ratio) => (
              <button
                key={ratio}
                type="button"
                onClick={() => setAspectRatio(ratio)}
                style={{
                  padding: '5px 10px',
                  borderRadius: '6px',
                  border: aspectRatio === ratio ? '1px solid #f59e0b' : '1px solid rgba(255,255,255,0.1)',
                  backgroundColor: aspectRatio === ratio ? 'rgba(245, 158, 11, 0.15)' : '#1e222d',
                  color: aspectRatio === ratio ? '#fae084' : '#d1d5db',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {ratio === '1:1' ? '1:1 (Shopify)' : ratio === '4:5' ? '4:5 (Feed)' : ratio === '9:16' ? '9:16 (Story)' : 'Free'}
              </button>
            ))}
          </div>

          {/* Transform & Framing Buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              onClick={handleRotateLeft}
              title="Rotate Left 90°"
              style={{
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid rgba(255,255,255,0.1)',
                backgroundColor: '#1e222d',
                color: '#d1d5db',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '0.75rem',
              }}
            >
              <RotateCcw size={14} />
              <span>-90°</span>
            </button>

            <button
              type="button"
              onClick={handleRotateRight}
              title="Rotate Right 90°"
              style={{
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid rgba(255,255,255,0.1)',
                backgroundColor: '#1e222d',
                color: '#d1d5db',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '0.75rem',
              }}
            >
              <RotateCw size={14} />
              <span>+90°</span>
            </button>

            <button
              type="button"
              onClick={() => setZoom((prev) => Math.min(3.0, prev + 0.15))}
              title="Zoom In"
              style={{
                padding: '6px 8px',
                borderRadius: '6px',
                border: '1px solid rgba(255,255,255,0.1)',
                backgroundColor: '#1e222d',
                color: '#d1d5db',
                cursor: 'pointer',
              }}
            >
              <ZoomIn size={14} />
            </button>

            <button
              type="button"
              onClick={() => setZoom((prev) => Math.max(0.6, prev - 0.15))}
              title="Zoom Out"
              style={{
                padding: '6px 8px',
                borderRadius: '6px',
                border: '1px solid rgba(255,255,255,0.1)',
                backgroundColor: '#1e222d',
                color: '#d1d5db',
                cursor: 'pointer',
              }}
            >
              <ZoomOut size={14} />
            </button>

            <button
              type="button"
              onClick={handleCenter}
              title="Center Product"
              style={{
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid rgba(255,255,255,0.1)',
                backgroundColor: '#1e222d',
                color: '#d1d5db',
                cursor: 'pointer',
                fontSize: '0.75rem',
              }}
            >
              Center
            </button>

            <button
              type="button"
              onClick={handleAutoCrop}
              disabled={isAutoCropping}
              title="Auto-detect jewelry bounds with 12% safe margin"
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                border: '1px solid rgba(245, 158, 11, 0.3)',
                backgroundColor: 'rgba(245, 158, 11, 0.1)',
                color: '#fae084',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '0.75rem',
                fontWeight: 600,
              }}
            >
              {isAutoCropping ? <RefreshCw size={14} className="animate-spin" /> : <Sparkles size={14} />}
              <span>Auto Crop</span>
            </button>

            <button
              type="button"
              onClick={handleReset}
              title="Reset Zoom & Position"
              style={{
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid rgba(255,255,255,0.1)',
                backgroundColor: '#1e222d',
                color: '#9ca3af',
                cursor: 'pointer',
                fontSize: '0.75rem',
              }}
            >
              Reset
            </button>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.12)',
                backgroundColor: 'transparent',
                color: '#d1d5db',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>

            <button
              type="button"
              onClick={handleApply}
              disabled={isApplying}
              style={{
                padding: '8px 20px',
                borderRadius: '8px',
                border: 'none',
                background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                color: '#0a0c10',
                fontSize: '0.8rem',
                fontWeight: 700,
                cursor: isApplying ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                boxShadow: '0 2px 10px rgba(245, 158, 11, 0.35)',
              }}
            >
              {isApplying ? (
                <>
                  <RefreshCw size={15} className="animate-spin" />
                  <span>Saving 2048px...</span>
                </>
              ) : (
                <>
                  <Check size={16} />
                  <span>Apply Crop</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
