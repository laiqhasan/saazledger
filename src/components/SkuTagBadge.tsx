import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface SkuTagBadgeProps {
  sku: string;
  size?: 'sm' | 'md' | 'lg';
  showCopy?: boolean;
  showBarcode?: boolean;
}

export const SkuTagBadge: React.FC<SkuTagBadgeProps> = ({
  sku,
  size = 'md',
  showCopy = true,
  showBarcode = false,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(sku);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const isSmall = size === 'sm';
  const isLarge = size === 'lg';

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: isSmall ? '6px' : '10px',
        background: 'linear-gradient(135deg, #181c26 0%, #0f1118 100%)',
        border: '1px solid rgba(212, 175, 55, 0.4)',
        borderRadius: isSmall ? '4px' : '8px',
        padding: isSmall ? '2px 8px' : isLarge ? '8px 16px' : '5px 12px',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 2px 8px rgba(0,0,0,0.5)',
        position: 'relative',
      }}
      title="Jewelry SKU & Barcode Tag"
    >
      {/* Hangtag eyelet / hole */}
      <div
        style={{
          width: isSmall ? '5px' : '7px',
          height: isSmall ? '5px' : '7px',
          borderRadius: '50%',
          background: '#07080a',
          border: '1px solid #d4af37',
          flexShrink: 0,
        }}
      />

      {showBarcode && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '2px',
            height: isSmall ? '14px' : '20px',
            paddingRight: '4px',
            borderRight: '1px solid rgba(212, 175, 55, 0.2)',
          }}
        >
          <div style={{ width: '2px', height: '100%', background: '#d4af37' }} />
          <div style={{ width: '1px', height: '80%', background: '#9ca3af' }} />
          <div style={{ width: '3px', height: '100%', background: '#d4af37' }} />
          <div style={{ width: '1px', height: '60%', background: '#9ca3af' }} />
          <div style={{ width: '2px', height: '90%', background: '#d4af37' }} />
        </div>
      )}

      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 700,
          letterSpacing: '0.08em',
          color: sku.endsWith('-XXXXX') ? '#93c5fd' : '#fae084',
          fontSize: isSmall ? '0.78rem' : isLarge ? '1.1rem' : '0.9rem',
          textShadow: '0 0 10px rgba(212, 175, 55, 0.25)',
        }}
      >
        {sku || '------'}
      </span>

      {sku.endsWith('-XXXXX') && (
        <span
          style={{
            fontSize: '0.62rem',
            background: 'rgba(59, 130, 246, 0.2)',
            color: '#93c5fd',
            padding: '1px 5px',
            borderRadius: '3px',
            fontWeight: 600,
            letterSpacing: '0.05em',
          }}
        >
          PREVIEW
        </span>
      )}

      {showCopy && sku && (
        <button
          type="button"
          onClick={handleCopy}
          style={{
            background: 'none',
            border: 'none',
            color: copied ? '#10b981' : 'rgba(212, 175, 55, 0.65)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            padding: '2px',
            transition: 'color 0.2s',
          }}
          title={copied ? 'Copied to clipboard!' : 'Copy SKU code'}
        >
          {copied ? <Check size={isSmall ? 12 : 14} /> : <Copy size={isSmall ? 12 : 14} />}
        </button>
      )}
    </div>
  );
};
