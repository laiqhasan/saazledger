import React, { useState } from 'react';
import type { JewelryItem } from '../types/inventory';
import { SkuTagBadge } from './SkuTagBadge';
import { formatCurrency } from '../services/skuEngine';
import {
  X,
  ShoppingBag,
  CheckCircle2,
  Plus,
  Minus,
} from 'lucide-react';
import confetti from 'canvas-confetti';

interface RecordSaleModalProps {
  item: JewelryItem;
  onConfirmSale: (params: {
    itemId: string;
    quantitySold: number;
    unitPrice: number;
    channel: string;
    notes: string;
  }) => void;
  onClose: () => void;
}

export const RecordSaleModal: React.FC<RecordSaleModalProps> = ({
  item,
  onConfirmSale,
  onClose,
}) => {
  const [quantitySold, setQuantitySold] = useState<number>(1);
  const [salePrice, setSalePrice] = useState<number>(item.sellingPrice);
  const [channel, setChannel] = useState<string>('Retail Store');
  const [notes, setNotes] = useState<string>('');

  const cost = item.buyingPrice;
  const totalRevenue = quantitySold * salePrice;
  const totalCost = quantitySold * cost;
  const realizedProfit = totalRevenue - totalCost;
  const marginPercent = totalRevenue > 0 ? ((realizedProfit / totalRevenue) * 100).toFixed(1) : '0.0';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (quantitySold <= 0 || quantitySold > item.quantity) {
      alert(`Invalid quantity. You have ${item.quantity} units available.`);
      return;
    }

    // Trigger celebration confetti
    try {
      confetti({
        particleCount: 50,
        spread: 60,
        origin: { y: 0.7 },
        colors: ['#d4af37', '#10b981', '#ffffff'],
      });
    } catch {}

    onConfirmSale({
      itemId: item.id,
      quantitySold,
      unitPrice: salePrice,
      channel,
      notes,
    });
    onClose();
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '520px' }}>
        {/* Header */}
        <div
          style={{
            padding: '20px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '8px',
                background: 'rgba(16, 185, 129, 0.15)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ShoppingBag size={20} color="#10b981" />
            </div>
            <div>
              <h2
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: '1.25rem',
                  color: '#ffffff',
                  margin: 0,
                }}
              >
                Record Jewelry Sale
              </h2>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '2px 0 0 0' }}>
                Log customer sale & realize immediate profit
              </p>
            </div>
          </div>
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

        <form onSubmit={handleSubmit} style={{ padding: '24px' }}>
          {/* Piece Card Preview */}
          <div
            style={{
              padding: '12px 16px',
              borderRadius: '10px',
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--border-subtle)',
              marginBottom: '20px',
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
            }}
          >
            {item.imageUrl ? (
              <img
                src={item.imageUrl}
                alt={item.title}
                style={{
                  width: '52px',
                  height: '52px',
                  borderRadius: '8px',
                  objectFit: 'cover',
                  border: '1px solid rgba(212, 175, 55, 0.3)',
                }}
              />
            ) : (
              <div
                style={{
                  width: '52px',
                  height: '52px',
                  borderRadius: '8px',
                  background: 'rgba(255, 255, 255, 0.05)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.7rem',
                  color: 'var(--text-dim)',
                }}
              >
                No Img
              </div>
            )}
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, color: '#ffffff', fontSize: '0.95rem' }}>{item.title}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                <SkuTagBadge sku={item.sku} size="sm" />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                  In Stock: <strong style={{ color: '#fae084' }}>{item.quantity} units</strong>
                </span>
              </div>
            </div>
          </div>

          {/* Units Sold & Selling Price */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '18px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                Quantity Sold
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  type="button"
                  onClick={() => setQuantitySold(Math.max(1, quantitySold - 1))}
                  style={{
                    width: '36px',
                    height: '38px',
                    borderRadius: '6px',
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-main)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                  }}
                >
                  <Minus size={14} />
                </button>
                <input
                  type="number"
                  min="1"
                  max={item.quantity}
                  value={quantitySold}
                  onChange={(e) => setQuantitySold(Math.min(item.quantity, Math.max(1, parseInt(e.target.value, 10) || 1)))}
                  className="input-field"
                  style={{ textAlign: 'center', fontWeight: 700, fontSize: '1rem' }}
                />
                <button
                  type="button"
                  onClick={() => setQuantitySold(Math.min(item.quantity, quantitySold + 1))}
                  style={{
                    width: '36px',
                    height: '38px',
                    borderRadius: '6px',
                    background: 'rgba(255, 255, 255, 0.05)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-main)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                  }}
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                Sale Price per Unit (₹)
              </label>
              <input
                type="number"
                min="0"
                value={salePrice}
                onChange={(e) => setSalePrice(Math.max(0, parseFloat(e.target.value) || 0))}
                className="input-field"
                style={{ fontWeight: 700, color: '#34d399' }}
              />
              <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '2px', display: 'block' }}>
                Retail Tag: {formatCurrency(item.sellingPrice)} | Cost: {formatCurrency(item.buyingPrice)}
              </span>
            </div>
          </div>

          {/* Sales Channel & Notes */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '20px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                Sales Channel
              </label>
              <select
                className="select-field"
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
              >
                <option value="SaazAura.com (Shopify)">SaazAura.com (Shopify)</option>
                <option value="Amazon India">Amazon India</option>
                <option value="Myntra Portal">Myntra Partner Portal</option>
                <option value="Retail Boutique">Retail Boutique Counter</option>
                <option value="Instagram / WhatsApp">Instagram / WhatsApp Direct</option>
                <option value="Exhibition / Trunk Show">Exhibition / Trunk Show</option>
                <option value="Wholesale">Wholesale / Consignment</option>
                <option value="Direct VIP Client">Direct VIP Client</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '6px' }}>
                Customer / Invoice Note
              </label>
              <input
                type="text"
                placeholder="e.g. Invoice #204, Cash payment"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="input-field"
              />
            </div>
          </div>

          {/* Real-time Profit Summary Card */}
          <div
            style={{
              padding: '16px',
              borderRadius: '10px',
              background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.12) 0%, rgba(212, 175, 55, 0.08) 100%)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              marginBottom: '24px',
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: '12px',
              textAlign: 'center',
            }}
          >
            <div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', textTransform: 'uppercase' }}>
                Total Revenue
              </div>
              <div style={{ fontWeight: 800, fontSize: '1.1rem', color: '#ffffff', marginTop: '2px' }}>
                {formatCurrency(totalRevenue)}
              </div>
            </div>

            <div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', textTransform: 'uppercase' }}>
                Realized Profit
              </div>
              <div style={{ fontWeight: 800, fontSize: '1.1rem', color: '#34d399', marginTop: '2px' }}>
                {formatCurrency(realizedProfit)}
              </div>
            </div>

            <div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', textTransform: 'uppercase' }}>
                Realized Margin
              </div>
              <div style={{ fontWeight: 800, fontSize: '1.1rem', color: '#fae084', marginTop: '2px' }}>
                {marginPercent}%
              </div>
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '10px 20px',
                background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                borderColor: '#10b981',
              }}
            >
              <CheckCircle2 size={16} />
              <span>Confirm Sale ({quantitySold} {quantitySold === 1 ? 'Unit' : 'Units'})</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
