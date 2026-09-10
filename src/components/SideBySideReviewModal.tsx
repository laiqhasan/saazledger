import React from 'react';
import { X, Check, RefreshCw, ShieldCheck, ThumbsDown } from 'lucide-react';

export interface SideBySideReviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  originalImageUrl: string;
  generatedImageUrl: string;
  productTitle: string;
  slotTitle: string;
  consistencyScore?: number;
  onApprove: () => void;
  onRegenerate: () => void;
  onReject: () => void;
}

export const SideBySideReviewModal: React.FC<SideBySideReviewModalProps> = ({
  isOpen,
  onClose,
  originalImageUrl,
  generatedImageUrl,
  productTitle,
  slotTitle,
  consistencyScore = 92,
  onApprove,
  onRegenerate,
  onReject,
}) => {
  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.88)',
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
          backgroundColor: '#11141a',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: '16px',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 60px rgba(0,0,0,0.7)',
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
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span
                style={{
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  backgroundColor: 'rgba(59, 130, 246, 0.2)',
                  color: '#93c5fd',
                }}
              >
                Visual Consistency Review ({consistencyScore}% match)
              </span>
              <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>{slotTitle}</span>
            </div>
            <h3 style={{ margin: '4px 0 0 0', fontSize: '1.05rem', fontWeight: 600, color: '#f3f4f6' }}>
              Compare {productTitle || 'Product'} With Original Photo
            </h3>
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

        {/* Side-by-Side View */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '16px',
            padding: '24px',
            backgroundColor: '#0a0c10',
          }}
        >
          {/* Left: Authentic Reference Photo */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: '#161922',
              borderRadius: '12px',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#34d399' }}>
                📷 Authentic Original Reference
              </span>
              <span style={{ fontSize: '0.7rem', color: '#9ca3af' }}>Source Truth</span>
            </div>

            <div
              style={{
                height: '380px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '12px',
                backgroundColor: '#0f1117',
              }}
            >
              <img
                src={originalImageUrl}
                alt="Authentic Reference"
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                  borderRadius: '6px',
                }}
              />
            </div>
            <div style={{ padding: '10px 14px', fontSize: '0.75rem', color: '#9ca3af' }}>
              Verify stone settings, metal luster, chain structure, and motifs.
            </div>
          </div>

          {/* Right: Generated Image */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: '#161922',
              borderRadius: '12px',
              border: '1px solid rgba(245, 158, 11, 0.3)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '10px 14px',
                borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#fae084' }}>
                ✨ AI Generated Presentation
              </span>
              <span
                style={{
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  padding: '2px 6px',
                  borderRadius: '4px',
                  backgroundColor: 'rgba(16, 185, 129, 0.2)',
                  color: '#34d399',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <ShieldCheck size={12} />
                <span>Design-Locked</span>
              </span>
            </div>

            <div
              style={{
                height: '380px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '12px',
                backgroundColor: '#0f1117',
              }}
            >
              <img
                src={generatedImageUrl}
                alt="AI Generated"
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                  borderRadius: '6px',
                }}
              />
            </div>
            <div style={{ padding: '10px 14px', fontSize: '0.75rem', color: '#9ca3af' }}>
              Check wearing scale, neckline drape, and that no stones were hallucinated or altered.
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div
          style={{
            padding: '16px 24px',
            backgroundColor: '#161922',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <button
            type="button"
            onClick={onReject}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              color: '#f87171',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <ThumbsDown size={15} />
            <span>Reject & Use Authentic Photo</span>
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              type="button"
              onClick={onRegenerate}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                border: '1px solid rgba(245, 158, 11, 0.3)',
                backgroundColor: 'rgba(245, 158, 11, 0.15)',
                color: '#fae084',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <RefreshCw size={15} />
              <span>Regenerate with New Prompt</span>
            </button>

            <button
              type="button"
              onClick={() => {
                onApprove();
                onClose();
              }}
              style={{
                padding: '8px 22px',
                borderRadius: '8px',
                border: 'none',
                background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                color: '#ffffff',
                fontSize: '0.8rem',
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                boxShadow: '0 2px 10px rgba(16, 185, 129, 0.35)',
              }}
            >
              <Check size={16} />
              <span>Approve For Shopify</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
