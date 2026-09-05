import React from 'react';
import type { JewelryItem, CodeTables, StockMovement } from '../types/inventory';
import { formatCurrency } from '../services/skuEngine';
import {
  TrendingUp,
  Package,
  Layers,
  AlertTriangle,
  ArrowUpRight,
  PieChart,
  Coins,
  DollarSign,
} from 'lucide-react';

interface DashboardProps {
  items: JewelryItem[];
  codeTables: CodeTables;
  transactions?: StockMovement[];
  onQuickRestock: (itemId: string, addQty: number) => void;
  onFilterLowStock: () => void;
  onOpenSalesLedger?: () => void;
}

export const Dashboard: React.FC<DashboardProps> = ({
  items,
  codeTables,
  transactions = [],
  onQuickRestock,
  onFilterLowStock,
  onOpenSalesLedger,
}) => {
  // Aggregate calculations
  const totalSkus = items.length;
  const totalUnits = items.reduce((sum, item) => sum + item.quantity, 0);

  const totalCostValue = items.reduce(
    (sum, item) => sum + item.buyingPrice * item.quantity,
    0
  );

  const totalRetailValue = items.reduce(
    (sum, item) => sum + item.sellingPrice * item.quantity,
    0
  );

  const potentialProfit = totalRetailValue - totalCostValue;

  const averageMargin =
    totalRetailValue > 0
      ? Math.round(((totalRetailValue - totalCostValue) / totalRetailValue) * 1000) / 10
      : 0;

  // Realized Sales metrics from ledger
  const realizedSales = transactions.filter((t) => t.type === 'sale');
  const realizedProfit = realizedSales.reduce((sum, t) => sum + t.realizedProfit, 0);
  const totalSalesRevenue = realizedSales.reduce((sum, t) => sum + t.totalPrice, 0);
  const unitsSold = realizedSales.reduce((sum, t) => sum + Math.abs(t.quantityDelta), 0);

  // Reorder alerts (quantity <= reorderLevel)
  const lowStockItems = items.filter((item) => item.quantity <= item.reorderLevel);

  // Breakdown by Product Type
  const typeValueMap: { [typeCode: string]: { retail: number; units: number; count: number } } = {};
  items.forEach((item) => {
    if (!typeValueMap[item.typeCode]) {
      typeValueMap[item.typeCode] = { retail: 0, units: 0, count: 0 };
    }
    typeValueMap[item.typeCode].retail += item.sellingPrice * item.quantity;
    typeValueMap[item.typeCode].units += item.quantity;
    typeValueMap[item.typeCode].count += 1;
  });

  const typeBreakdown = Object.entries(typeValueMap)
    .map(([typeCode, data]) => {
      const typeRef = codeTables.types.find((t) => t.code === typeCode);
      const label = typeRef ? typeRef.label : typeCode;
      const percentage =
        totalRetailValue > 0 ? Math.round((data.retail / totalRetailValue) * 100) : 0;
      return {
        typeCode,
        label,
        ...data,
        percentage,
      };
    })
    .sort((a, b) => b.retail - a.retail);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* KPI Cards Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: '16px',
        }}
      >
        {/* Card 1: Total Units & SKUs */}
        <div className="glass-panel" style={{ padding: '20px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '12px',
            }}
          >
            <span className="input-label" style={{ margin: 0 }}>Stock on Hand</span>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'rgba(59, 130, 246, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Package size={18} color="#60a5fa" />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span
              style={{
                fontSize: '1.85rem',
                fontWeight: 700,
                fontFamily: 'var(--font-sans)',
                color: '#ffffff',
              }}
            >
              {totalUnits}
            </span>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>units total</span>
          </div>
          <div
            style={{
              marginTop: '8px',
              fontSize: '0.8rem',
              color: 'var(--text-dim)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <Layers size={14} color="#d4af37" />
            <span>Across <strong>{totalSkus}</strong> unique SKUs</span>
          </div>
        </div>

        {/* Card 2: Cost Valuation */}
        <div className="glass-panel" style={{ padding: '20px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '12px',
            }}
          >
            <span className="input-label" style={{ margin: 0 }}>Inventory Cost Value</span>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'rgba(212, 175, 55, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Coins size={18} color="#fae084" />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span
              style={{
                fontSize: '1.85rem',
                fontWeight: 700,
                fontFamily: 'var(--font-sans)',
                color: '#fae084',
              }}
            >
              {formatCurrency(totalCostValue)}
            </span>
          </div>
          <div
            style={{
              marginTop: '8px',
              fontSize: '0.8rem',
              color: 'var(--text-dim)',
            }}
          >
            Purchase capital deployed
          </div>
        </div>

        {/* Card 3: Retail Valuation */}
        <div className="glass-panel" style={{ padding: '20px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '12px',
            }}
          >
            <span className="input-label" style={{ margin: 0 }}>Total Retail Value</span>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'rgba(16, 185, 129, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ArrowUpRight size={18} color="#34d399" />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span
              style={{
                fontSize: '1.85rem',
                fontWeight: 700,
                fontFamily: 'var(--font-sans)',
                color: '#34d399',
              }}
            >
              {formatCurrency(totalRetailValue)}
            </span>
          </div>
          <div
            style={{
              marginTop: '8px',
              fontSize: '0.8rem',
              color: 'var(--text-dim)',
            }}
          >
            Projected sales catalog value
          </div>
        </div>

        {/* Card 4: Potential Profit & Margin */}
        <div className="glass-panel" style={{ padding: '20px', border: '1px solid rgba(212, 175, 55, 0.35)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '12px',
            }}
          >
            <span className="input-label" style={{ margin: 0, color: '#fae084' }}>Potential Profit</span>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'rgba(212, 175, 55, 0.25)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <TrendingUp size={18} color="#fae084" />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span
              style={{
                fontSize: '1.85rem',
                fontWeight: 700,
                fontFamily: 'var(--font-sans)',
                color: '#ffffff',
              }}
            >
              {formatCurrency(potentialProfit)}
            </span>
          </div>
          <div
            style={{
              marginTop: '8px',
              fontSize: '0.85rem',
              color: '#34d399',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span>{averageMargin}%</span>
            <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>avg store margin</span>
          </div>
        </div>

        {/* Card 5: Realized Profit (Actual Sales) */}
        <div
          className="glass-panel"
          style={{
            padding: '20px',
            border: '1px solid rgba(16, 185, 129, 0.35)',
            background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.08) 0%, rgba(18, 20, 28, 0.8) 100%)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '12px',
            }}
          >
            <span className="input-label" style={{ margin: 0, color: '#34d399' }}>Realized Cash Profit</span>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'rgba(16, 185, 129, 0.25)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <DollarSign size={18} color="#34d399" />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span
              style={{
                fontSize: '1.85rem',
                fontWeight: 700,
                fontFamily: 'var(--font-sans)',
                color: '#34d399',
              }}
            >
              {formatCurrency(realizedProfit)}
            </span>
          </div>
          <div
            style={{
              marginTop: '8px',
              fontSize: '0.82rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ color: 'var(--text-dim)' }}>
              Revenue: {formatCurrency(totalSalesRevenue)} ({unitsSold} {unitsSold === 1 ? 'pc' : 'pcs'})
            </span>
            {onOpenSalesLedger && (
              <button
                type="button"
                onClick={onOpenSalesLedger}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#fae084',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  padding: 0,
                  textDecoration: 'underline',
                }}
              >
                View Ledger &rarr;
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Row: Reorder Warning Banner + Category Breakdown Chart */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: lowStockItems.length > 0 ? '1fr 1fr' : '1fr',
          gap: '16px',
        }}
      >
        {/* Reorder Threshold Alert */}
        {lowStockItems.length > 0 && (
          <div
            className="glass-panel"
            style={{
              padding: '18px 20px',
              border: '1px solid rgba(245, 158, 11, 0.4)',
              background: 'rgba(30, 22, 10, 0.65)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '14px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <AlertTriangle size={18} color="#f59e0b" />
                <h3
                  style={{
                    fontSize: '0.95rem',
                    fontWeight: 600,
                    color: '#fbbf24',
                    margin: 0,
                  }}
                >
                  Reorder Threshold Alert ({lowStockItems.length} items low)
                </h3>
              </div>
              <button
                type="button"
                onClick={onFilterLowStock}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#f59e0b',
                  fontSize: '0.8rem',
                  textDecoration: 'underline',
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                View in Register
              </button>
            </div>

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                maxHeight: '160px',
                overflowY: 'auto',
                paddingRight: '6px',
              }}
            >
              {lowStockItems.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    borderRadius: '8px',
                    background: 'rgba(0, 0, 0, 0.35)',
                    border: '1px solid rgba(245, 158, 11, 0.2)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.82rem',
                        fontWeight: 700,
                        color: '#fae084',
                      }}
                    >
                      {item.sku}
                    </span>
                    <span
                      style={{
                        fontSize: '0.85rem',
                        color: 'var(--text-main)',
                        maxWidth: '180px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.title}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span
                      style={{
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        color: item.quantity === 0 ? '#f43f5e' : '#f59e0b',
                      }}
                    >
                      {item.quantity} in stock (min {item.reorderLevel})
                    </span>
                    <button
                      type="button"
                      onClick={() => onQuickRestock(item.id, 5)}
                      style={{
                        padding: '3px 8px',
                        background: 'rgba(212, 175, 55, 0.15)',
                        border: '1px solid rgba(212, 175, 55, 0.4)',
                        color: '#fae084',
                        borderRadius: '4px',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        fontWeight: 600,
                      }}
                      title="Quick add 5 units"
                    >
                      +5 Restock
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Product Type Retail Value Breakdown */}
        <div className="glass-panel" style={{ padding: '18px 20px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '14px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <PieChart size={18} color="#d4af37" />
              <h3 style={{ fontSize: '0.95rem', fontWeight: 600, margin: 0 }}>
                Retail Valuation by Jewelry Type
              </h3>
            </div>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
              {typeBreakdown.length} Categories
            </span>
          </div>

          {/* Segment Progress Bar */}
          <div
            style={{
              display: 'flex',
              height: '10px',
              borderRadius: '5px',
              overflow: 'hidden',
              background: 'rgba(255, 255, 255, 0.05)',
              marginBottom: '14px',
            }}
          >
            {typeBreakdown.map((item, idx) => {
              const colors = ['#d4af37', '#34d399', '#60a5fa', '#f472b6', '#a78bfa', '#f59e0b'];
              const col = colors[idx % colors.length];
              return (
                <div
                  key={item.typeCode}
                  style={{
                    width: `${item.percentage}%`,
                    background: col,
                    transition: 'width 0.3s ease',
                  }}
                  title={`${item.label}: ${item.percentage}% (${formatCurrency(item.retail)})`}
                />
              );
            })}
          </div>

          {/* Breakdown Legend Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '10px',
            }}
          >
            {typeBreakdown.slice(0, 4).map((item, idx) => {
              const colors = ['#d4af37', '#34d399', '#60a5fa', '#f472b6', '#a78bfa', '#f59e0b'];
              const col = colors[idx % colors.length];
              return (
                <div
                  key={item.typeCode}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '0.8rem',
                    padding: '4px 8px',
                    borderRadius: '6px',
                    background: 'rgba(255,255,255,0.03)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <div
                      style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '2px',
                        background: col,
                      }}
                    />
                    <span style={{ color: 'var(--text-main)', fontWeight: 500 }}>
                      {item.label}
                    </span>
                  </div>
                  <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {formatCurrency(item.retail)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
