import React, { useEffect, useMemo, useRef, useState } from 'react';
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

type AspectRatio = '1:1' | '4:5' | '9:16' | 'free';

const ZOOM_MIN = 0.35;
const ZOOM_MAX = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getFrameDimensions(aspectRatio: AspectRatio): { width: number; height: number } {
  const width = 360;
  if (aspectRatio === '4:5') return { width, height: 450 };
  if (aspectRatio === '9:16') return { width: 300, height: 533 };
  return { width, height: 360 };
}

function getRotatedDimensions(
  natural: { width: number; height: number },
  rotation: number
): { width: number; height: number } {
  const normalized = ((rotation % 360) + 360) % 360;
  return normalized === 90 || normalized === 270
    ? { width: natural.height, height: natural.width }
    : natural;
}

export const CropEditorModal: React.FC<CropEditorModalProps> = ({
  isOpen,
  onClose,
  imageUrl,
  imageBase64,
  title = 'Crop & Frame Editor',
  onApplyCrop,
}) => {
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('1:1');
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [naturalDimensions, setNaturalDimensions] = useState({ width: 2048, height: 2048 });
  const [isApplying, setIsApplying] = useState(false);
  const [isAutoCropping, setIsAutoCropping] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setZoom(1);
      setRotation(0);
      setPanX(0);
      setPanY(0);
      setAspectRatio('1:1');
      setStatusMessage(null);
    }
  }, [isOpen, imageUrl]);

  const frameDimensions = useMemo(() => getFrameDimensions(aspectRatio), [aspectRatio]);
  const rotatedDimensions = useMemo(
    () => getRotatedDimensions(naturalDimensions, rotation),
    [naturalDimensions, rotation]
  );

  const baseScale = useMemo(() => {
    if (!rotatedDimensions.width || !rotatedDimensions.height) return 1;
    return Math.min(
      frameDimensions.width / rotatedDimensions.width,
      frameDimensions.height / rotatedDimensions.height
    );
  }, [frameDimensions, rotatedDimensions]);

  if (!isOpen) return null;

  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setNaturalDimensions({ width: img.naturalWidth, height: img.naturalHeight });
    }
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

  const handleMouseUp = () => setIsDragging(false);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.08 : 0.08;
    setZoom((prev) => clamp(prev + delta, ZOOM_MIN, ZOOM_MAX));
  };

  const handleRotateLeft = () => {
    setRotation((prev) => (prev - 90 + 360) % 360);
    setPanX(0);
    setPanY(0);
  };

  const handleRotateRight = () => {
    setRotation((prev) => (prev + 90) % 360);
    setPanX(0);
    setPanY(0);
  };

  const handleReset = () => {
    setZoom(1);
    setRotation(0);
    setPanX(0);
    setPanY(0);
    setAspectRatio('1:1');
    setStatusMessage(null);
  };

  const handleCenter = () => {
    setPanX(0);
    setPanY(0);
  };

  const handleAutoCrop = async () => {
    setIsAutoCropping(true);
    setStatusMessage('Detecting jewellery bounds...');
    try {
      const res = await requestJewelryAutoCrop({
        imageBase64,
        url: imageUrl,
        category: 'necklace_set',
      });

      if (!res.success || !res.crop) {
        setStatusMessage(res.error || 'Auto Crop could not detect a reliable jewellery region.');
        return;
      }

      // The server returns source-pixel bounds in the EXIF-oriented, unrotated image.
      // Reset user rotation and map those exact bounds into the visible crop frame.
      setRotation(0);

      const frame = getFrameDimensions(aspectRatio);
      const sourceW = naturalDimensions.width;
      const sourceH = naturalDimensions.height;
      const crop = res.crop.cropRect || res.crop;
      const cropW = clamp(Number(crop.width) || sourceW, 1, sourceW);
      const cropH = clamp(Number(crop.height) || sourceH, 1, sourceH);
      const cropX = clamp(Number(crop.x) || 0, 0, Math.max(0, sourceW - cropW));
      const cropY = clamp(Number(crop.y) || 0, 0, Math.max(0, sourceH - cropH));

      const initialScale = Math.min(frame.width / sourceW, frame.height / sourceH);
      const desiredVisualScale = Math.min(frame.width / cropW, frame.height / cropH);
      const desiredZoom = clamp(desiredVisualScale / Math.max(initialScale, 0.000001), ZOOM_MIN, ZOOM_MAX);
      const actualVisualScale = initialScale * desiredZoom;
      const cropCenterX = cropX + cropW / 2;
      const cropCenterY = cropY + cropH / 2;

      setZoom(desiredZoom);
      setPanX((sourceW / 2 - cropCenterX) * actualVisualScale);
      setPanY((sourceH / 2 - cropCenterY) * actualVisualScale);
      setStatusMessage('Auto Crop applied. Fine-tune by dragging or zooming, then Apply Crop.');
    } catch (err: any) {
      setStatusMessage(err.message || 'Auto Crop failed.');
    } finally {
      setIsAutoCropping(false);
    }
  };

  /**
   * Converts the exact on-screen viewport into source-pixel coordinates.
   * This replaces the old panX/300 * magic-factor approximation.
   */
  const calculateCropRectFromViewport = () => {
    const frame = frameDimensions;
    const rotated = rotatedDimensions;
    const visualScale = baseScale * zoom;

    const imageLeft = frame.width / 2 + panX - (rotated.width * visualScale) / 2;
    const imageTop = frame.height / 2 + panY - (rotated.height * visualScale) / 2;
    const imageRight = imageLeft + rotated.width * visualScale;
    const imageBottom = imageTop + rotated.height * visualScale;

    const visibleLeft = Math.max(0, imageLeft);
    const visibleTop = Math.max(0, imageTop);
    const visibleRight = Math.min(frame.width, imageRight);
    const visibleBottom = Math.min(frame.height, imageBottom);

    if (visibleRight <= visibleLeft || visibleBottom <= visibleTop || visualScale <= 0) {
      throw new Error('The image is outside the crop frame. Use Reset or Center and try again.');
    }

    const x = clamp((visibleLeft - imageLeft) / visualScale, 0, rotated.width);
    const y = clamp((visibleTop - imageTop) / visualScale, 0, rotated.height);
    const width = clamp((visibleRight - visibleLeft) / visualScale, 1, rotated.width - x);
    const height = clamp((visibleBottom - visibleTop) / visualScale, 1, rotated.height - y);

    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
      rotation,
      zoom,
      aspectRatio,
      coordinateSpace: 'exif_oriented_after_user_rotation',
    };
  };

  const handleApply = async () => {
    setIsApplying(true);
    setStatusMessage('Rendering crop...');
    try {
      const cropRect = calculateCropRectFromViewport();
      const res = await applyMediaCrop({
        imageBase64,
        url: imageUrl,
        crop: cropRect,
        targetOutputDim: 2048,
      });

      if (res.success && res.url) {
        onApplyCrop({ url: res.url, base64: res.base64, cropRect });
        onClose();
      } else {
        setStatusMessage(res.error || 'Failed to apply crop.');
      }
    } catch (err: any) {
      setStatusMessage(err.message || 'Failed to apply crop.');
    } finally {
      setIsApplying(false);
    }
  };

  const planeWidth = rotatedDimensions.width * baseScale;
  const planeHeight = rotatedDimensions.height * baseScale;
  const unrotatedPreviewWidth = naturalDimensions.width * baseScale;
  const unrotatedPreviewHeight = naturalDimensions.height * baseScale;

  const frameStyle: React.CSSProperties = {
    position: 'relative',
    width: `${frameDimensions.width}px`,
    height: `${frameDimensions.height}px`,
    border: '2px solid #f59e0b',
    boxShadow: '0 0 0 9999px rgba(10, 12, 16, 0.78), 0 4px 20px rgba(0,0,0,0.5)',
    borderRadius: '4px',
    overflow: 'hidden',
    cursor: isDragging ? 'grabbing' : 'grab',
    backgroundColor: '#ffffff',
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
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
          maxWidth: '920px',
          maxHeight: '96vh',
          backgroundColor: '#11141a',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: '16px',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 60px rgba(0,0,0,0.6)',
          overflow: 'hidden',
        }}
      >
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
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: '#f3f4f6' }}>{title}</h3>
              <div style={{ fontSize: '0.75rem', color: '#9ca3af' }}>
                Original: {naturalDimensions.width} × {naturalDimensions.height} px &nbsp;•&nbsp; Output:{' '}
                <strong style={{ color: '#fae084' }}>2048px master</strong>
              </div>
            </div>
          </div>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', padding: '6px' }}>
            <X size={20} />
          </button>
        </div>

        <div
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
          style={{
            minHeight: '460px',
            maxHeight: '62vh',
            padding: '28px 16px 44px',
            backgroundColor: '#0a0c10',
            position: 'relative',
            overflow: 'auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            userSelect: 'none',
          }}
        >
          <div ref={frameRef} style={frameStyle}>
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: planeWidth,
                height: planeHeight,
                transform: `translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px)) scale(${zoom})`,
                transformOrigin: 'center center',
                transition: isDragging ? 'none' : 'transform 0.08s linear',
              }}
            >
              <img
                src={imageUrl}
                alt="Crop preview"
                onLoad={handleImageLoad}
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  width: `${unrotatedPreviewWidth}px`,
                  height: `${unrotatedPreviewHeight}px`,
                  maxWidth: 'none',
                  maxHeight: 'none',
                  objectFit: 'fill',
                  transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                  transformOrigin: 'center center',
                  pointerEvents: 'none',
                }}
              />
            </div>

            {[33.33, 66.66].map((pct) => (
              <React.Fragment key={pct}>
                <div style={{ position: 'absolute', top: `${pct}%`, left: 0, right: 0, height: 1, backgroundColor: 'rgba(80,80,80,0.28)', pointerEvents: 'none' }} />
                <div style={{ position: 'absolute', left: `${pct}%`, top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(80,80,80,0.28)', pointerEvents: 'none' }} />
              </React.Fragment>
            ))}
          </div>

          <div
            style={{
              position: 'absolute',
              bottom: '10px',
              left: '16px',
              fontSize: '0.72rem',
              color: '#d1d5db',
              backgroundColor: 'rgba(0,0,0,0.7)',
              padding: '5px 10px',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <Move size={12} />
            <span>Drag to pan • Scroll to zoom ({Math.round(zoom * 100)}%) • White areas are preserved as canvas padding</span>
          </div>
        </div>

        {statusMessage && (
          <div style={{ padding: '8px 24px', fontSize: '0.75rem', color: '#fde68a', backgroundColor: 'rgba(245,158,11,0.08)', borderTop: '1px solid rgba(245,158,11,0.14)' }}>
            {statusMessage}
          </div>
        )}

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
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.75rem', color: '#9ca3af', marginRight: '4px' }}>Ratio:</span>
            {(['1:1', '4:5', '9:16', 'free'] as const).map((ratio) => (
              <button
                key={ratio}
                type="button"
                onClick={() => {
                  setAspectRatio(ratio);
                  setPanX(0);
                  setPanY(0);
                  setZoom(1);
                }}
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

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button type="button" onClick={handleRotateLeft} title="Rotate Left 90°" style={toolButtonStyle}>
              <RotateCcw size={14} /> -90°
            </button>
            <button type="button" onClick={handleRotateRight} title="Rotate Right 90°" style={toolButtonStyle}>
              <RotateCw size={14} /> +90°
            </button>
            <button type="button" onClick={() => setZoom((prev) => clamp(prev + 0.15, ZOOM_MIN, ZOOM_MAX))} title="Zoom In" style={iconButtonStyle}>
              <ZoomIn size={14} />
            </button>
            <button type="button" onClick={() => setZoom((prev) => clamp(prev - 0.15, ZOOM_MIN, ZOOM_MAX))} title="Zoom Out" style={iconButtonStyle}>
              <ZoomOut size={14} />
            </button>
            <button type="button" onClick={handleCenter} style={toolButtonStyle}>Center</button>
            <button
              type="button"
              onClick={handleAutoCrop}
              disabled={isAutoCropping}
              style={{ ...toolButtonStyle, border: '1px solid rgba(245,158,11,0.35)', color: '#fae084', backgroundColor: 'rgba(245,158,11,0.1)' }}
            >
              {isAutoCropping ? <RefreshCw size={14} /> : <Sparkles size={14} />}
              {isAutoCropping ? 'Detecting...' : 'Auto Crop'}
            </button>
            <button type="button" onClick={handleReset} style={{ ...toolButtonStyle, color: '#9ca3af' }}>Reset</button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button type="button" onClick={onClose} style={{ ...actionButtonStyle, backgroundColor: 'transparent', color: '#d1d5db', border: '1px solid rgba(255,255,255,0.12)' }}>
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={isApplying}
              style={{ ...actionButtonStyle, background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', color: '#0a0c10', border: 'none', opacity: isApplying ? 0.65 : 1 }}
            >
              {isApplying ? <RefreshCw size={15} /> : <Check size={16} />}
              {isApplying ? 'Saving 2048px...' : 'Apply Crop'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const toolButtonStyle: React.CSSProperties = {
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
};

const iconButtonStyle: React.CSSProperties = {
  ...toolButtonStyle,
  padding: '6px 8px',
};

const actionButtonStyle: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: '8px',
  fontSize: '0.8rem',
  fontWeight: 700,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
};
