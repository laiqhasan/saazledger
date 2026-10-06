import React from 'react';
import {
  CATEGORY_NOT_SET_MESSAGE,
  describeOverwriteConfirmation,
  type ShopifyOverwriteChoice,
  type ShopifyOverwriteConfirmation,
} from '../services/shopifyService';

/**
 * Shown when a Shopify draft's stock / price / cost was changed manually in Shopify.
 * Nothing has been written yet. "Keep Shopify value" is the default and primary action;
 * overwriting needs an explicit click and sends the confirmation + expected current value.
 */
export const ShopifyOverwriteConfirmDialog: React.FC<{
  confirmation: ShopifyOverwriteConfirmation;
  title?: string;
  busy?: boolean;
  onChoose: (choice: ShopifyOverwriteChoice) => void;
}> = ({ confirmation, title, busy, onChoose }) => (
  <div
    role="alertdialog"
    aria-label="Confirm overwrite of Shopify value"
    data-testid="shopify-overwrite-confirm"
    style={{
      padding: '14px 16px',
      borderRadius: '10px',
      backgroundColor: 'rgba(245, 158, 11, 0.16)',
      border: '1px solid #f59e0b',
      color: '#fde68a',
      fontSize: '0.85rem',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    }}
  >
    <strong>{title ? `${title}: ` : ''}Changed manually in Shopify - nothing was overwritten</strong>
    <span data-testid="shopify-overwrite-confirm-text">{describeOverwriteConfirmation(confirmation)}</span>
    {confirmation.adminUrl && (
      <a href={confirmation.adminUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#fae084' }}>
        Open the draft in Shopify admin
      </a>
    )}
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
      <button
        type="button"
        autoFocus
        disabled={busy}
        data-testid="shopify-keep-value"
        onClick={() => onChoose('keep')}
        style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid #10b981', background: '#065f46', color: '#ecfdf5', fontWeight: 700, cursor: 'pointer' }}
      >
        Keep Shopify value
      </button>
      <button
        type="button"
        disabled={busy}
        data-testid="shopify-overwrite-value"
        onClick={() => onChoose('overwrite')}
        style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid #ef4444', background: 'transparent', color: '#fecaca', fontWeight: 600, cursor: 'pointer' }}
      >
        Overwrite with SaazLedger value
      </button>
    </div>
  </div>
);

/** Prominent "incomplete" flag: the standard Shopify category is not set on the draft. */
export const ShopifyCategoryNotSetBanner: React.FC<{ sku?: string }> = ({ sku }) => (
  <div
    role="alert"
    data-testid="shopify-category-not-set"
    style={{
      padding: '10px 14px',
      borderRadius: '8px',
      backgroundColor: 'rgba(239, 68, 68, 0.16)',
      border: '1px solid #ef4444',
      color: '#fecaca',
      fontSize: '0.82rem',
      fontWeight: 700,
    }}
  >
    {sku ? `${sku} - ` : ''}
    {CATEGORY_NOT_SET_MESSAGE}
  </div>
);
