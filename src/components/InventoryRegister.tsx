import React, { useState, useMemo } from 'react';
import type { JewelryItem, CodeTables, InventoryFilter, SortField, SortOrder } from '../types/inventory';
import { SkuTagBadge } from './SkuTagBadge';
import { formatCurrency, calculateItemFinancials } from '../services/skuEngine';
import { exportToShopifyCSV, downloadFile } from '../services/storage';
import {
  Search,
  ArrowUpDown,
  Plus,
  Minus,
  Edit2,
  Trash2,
  Package,
  Printer,
  ShoppingBag,
  Download,
  CheckSquare,
  Square,
  X,
  PlusCircle,
  UploadCloud,
  Store,
} from 'lucide-react';

interface InventoryRegisterProps {
  items: JewelryItem[];
  codeTables: CodeTables;
  onEditItem: (item: JewelryItem) => void;
  onDeleteItem: (itemId: string) => void;
  onAdjustQuantity: (itemId: string, delta: number) => void;
  filterStatus: InventoryFilter;
  setFilterStatus: (filter: InventoryFilter) => void;
  onOpenPrintStudio: (itemsToPrint: JewelryItem[]) => void;
  onOpenRecordSale: (item: JewelryItem) => void;
  onBulkDelete?: (itemIds: string[]) => void;
  onBulkAdjustQuantity?: (itemIds: string[], delta: number) => void;
  onPushItemToShopify?: (item: JewelryItem) => void;
  onBulkPushToShopify?: (items: JewelryItem[]) => void;
}

export const InventoryRegister: React.FC<InventoryRegisterProps> = ({
  items,
  codeTables,
  onEditItem,
  onDeleteItem,
  onAdjustQuantity,
  filterStatus,
  setFilterStatus,
  onOpenPrintStudio,
  onOpenRecordSale,
  onBulkDelete,
  onBulkAdjustQuantity,
  onPushItemToShopify,
  onBulkPushToShopify,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('dateAdded');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedVendor, setSelectedVendor] = useState<string>('all');

  // Multi-select selection state
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Unique vendors present in current inventory
  const uniqueVendorsInStock = useMemo(() => {
    const set = new Set<string>();
    items.forEach((item) => {
      if (item.vendor && item.vendor.trim()) {
        set.add(item.vendor.trim());
      }
    });
    return Array.from(set).sort();
  }, [items]);

  // Filter and sort items
  const filteredAndSortedItems = useMemo(() => {
    return items
      .filter((item) => {
        // Text Search across SKU, title, vendor, codes
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const matchTitle = item.title.toLowerCase().includes(q);
          const matchSku = item.sku.toLowerCase().includes(q);
          const matchVendor = item.vendor.toLowerCase().includes(q);
          const matchNotes = (item.notes || '').toLowerCase().includes(q);
          if (!matchTitle && !matchSku && !matchVendor && !matchNotes) {
            return false;
          }
        }

        // Status & Channel Filter
        if (filterStatus === 'in_stock' && item.quantity <= 0) return false;
        if (filterStatus === 'low_stock' && (item.quantity > item.reorderLevel || item.quantity === 0))
          return false;
        if (filterStatus === 'out_of_stock' && item.quantity > 0) return false;
        if (filterStatus === 'shopify' && !item.shopifyProductId && !item.isListedOnShopify) return false;
        if (filterStatus === 'amazon' && !item.isListedOnAmazon) return false;
        if (filterStatus === 'myntra' && !item.isListedOnMyntra) return false;

        // Category / Type filter
        if (selectedType !== 'all' && item.typeCode !== selectedType) return false;

        // Artisan / Vendor filter
        if (selectedVendor !== 'all' && (item.vendor || '').toLowerCase() !== selectedVendor.toLowerCase()) {
          return false;
        }

        return true;
      })
      .sort((a, b) => {
        let valA: any = 0;
        let valB: any = 0;

        switch (sortField) {
          case 'sku':
            valA = a.sku;
            valB = b.sku;
            break;
          case 'quantity':
            valA = a.quantity;
            valB = b.quantity;
            break;
          case 'margin': {
            const marginA = a.sellingPrice > 0 ? (a.sellingPrice - a.buyingPrice) / a.sellingPrice : 0;
            const marginB = b.sellingPrice > 0 ? (b.sellingPrice - b.buyingPrice) / b.sellingPrice : 0;
            valA = marginA;
            valB = marginB;
            break;
          }
          case 'retailValue':
            valA = a.sellingPrice * a.quantity;
            valB = b.sellingPrice * b.quantity;
            break;
          case 'dateAdded':
          default:
            valA = new Date(a.dateAdded).getTime();
            valB = new Date(b.dateAdded).getTime();
            break;
        }

        if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
        if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
        return 0;
      });
  }, [items, searchQuery, filterStatus, selectedType, selectedVendor, sortField, sortOrder]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  // Selection helpers
  const allFilteredSelected =
    filteredAndSortedItems.length > 0 &&
    filteredAndSortedItems.every((item) => selectedIds.includes(item.id));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredAndSortedItems.map((i) => i.id));
    }
  };

  const toggleSelectItem = (id: string) => {
    if (selectedIds.includes(id)) {
      setSelectedIds(selectedIds.filter((item) => item !== id));
    } else {
      setSelectedIds([...selectedIds, id]);
    }
  };

  const selectedItems = useMemo(() => {
    return items.filter((item) => selectedIds.includes(item.id));
  }, [items, selectedIds]);

  // Bulk actions
  const handleBulkExportCSV = () => {
    if (selectedItems.length === 0) return;
    const csvContent = exportToShopifyCSV(selectedItems);
    const dateStr = new Date().toISOString().split('T')[0];
    downloadFile(csvContent, `saaz_selected_${selectedItems.length}_pieces_${dateStr}.csv`, 'text/csv');
  };

  const handleBulkDeleteItems = () => {
    if (selectedIds.length === 0) return;
    if (window.confirm(`Are you sure you want to remove ${selectedIds.length} selected pieces from inventory?`)) {
      if (onBulkDelete) {
        onBulkDelete(selectedIds);
      } else {
        selectedIds.forEach((id) => onDeleteItem(id));
      }
      setSelectedIds([]);
    }
  };

  const handleBulkRestockItems = () => {
    if (selectedIds.length === 0) return;
    const addUnits = prompt('How many units would you like to add to each selected piece?', '5');
    if (!addUnits) return;
    const delta = parseInt(addUnits, 10);
    if (isNaN(delta) || delta <= 0) return;

    if (onBulkAdjustQuantity) {
      onBulkAdjustQuantity(selectedIds, delta);
    } else {
      selectedIds.forEach((id) => onAdjustQuantity(id, delta));
    }
  };

  return (
    <div className="glass-panel" style={{ padding: '24px' }}>
      {/* Top Controls: Search + Filters + Sort */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          marginBottom: '24px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
            flexWrap: 'wrap',
          }}
        >
          {/* Search Box */}
          <div
            style={{
              position: 'relative',
              flex: '1',
              minWidth: '260px',
              maxWidth: '460px',
            }}
          >
            <Search
              size={18}
              color="var(--text-dim)"
              style={{
                position: 'absolute',
                left: '12px',
                top: '50%',
                transform: 'translateY(-50%)',
              }}
            />
            <input
              type="text"
              placeholder="Search by SKU, Piece title, Vendor, Notes..."
              className="input-field"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ paddingLeft: '38px' }}
            />
          </div>

          {/* Type Filter Dropdown */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Type:</span>
            <select
              className="select-field"
              style={{ width: 'auto', padding: '8px 12px' }}
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
            >
              <option value="all">All Types</option>
              {codeTables.types.map((t) => (
                <option key={t.code} value={t.code}>
                  [{t.code}] {t.label}
                </option>
              ))}
            </select>
          </div>

          {/* Artisan / Vendor Filter Dropdown */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Artisan:</span>
            <select
              className="select-field"
              style={{ width: 'auto', padding: '8px 12px', minWidth: '130px' }}
              value={selectedVendor}
              onChange={(e) => setSelectedVendor(e.target.value)}
            >
              <option value="all">All Artisans ({uniqueVendorsInStock.length})</option>
              {uniqueVendorsInStock.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            {selectedVendor !== 'all' && (
              <button
                type="button"
                onClick={() => setSelectedVendor('all')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-dim)',
                  cursor: 'pointer',
                  fontSize: '0.75rem',
                  textDecoration: 'underline',
                  padding: '2px',
                }}
                title="Clear artisan filter"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Status Filter Chips + Counter */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {(
              [
                { id: 'all', label: 'All Pieces' },
                { id: 'in_stock', label: 'In Stock' },
                { id: 'low_stock', label: 'Low Stock Alert' },
                { id: 'out_of_stock', label: 'Out of Stock' },
                { id: 'shopify', label: 'SaazAura (Shopify)' },
                { id: 'amazon', label: 'Amazon IN' },
                { id: 'myntra', label: 'Myntra' },
              ] as const
            ).map((filter) => {
              const active = filterStatus === filter.id;
              return (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => setFilterStatus(filter.id)}
                  style={{
                    padding: '6px 14px',
                    borderRadius: '20px',
                    fontSize: '0.82rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    border: '1px solid',
                    borderColor: active ? 'var(--gold-500)' : 'var(--border-subtle)',
                    background: active
                      ? 'linear-gradient(135deg, rgba(212, 175, 55, 0.25) 0%, rgba(212, 175, 55, 0.1) 100%)'
                      : 'rgba(255, 255, 255, 0.03)',
                    color: active ? '#fae084' : 'var(--text-muted)',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {filter.label}
                </button>
              );
            })}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', fontSize: '0.82rem', color: 'var(--text-dim)' }}>
            <span>
              Showing <strong>{filteredAndSortedItems.length}</strong> of {items.length} items
            </span>
            {filteredAndSortedItems.length > 0 && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => onOpenPrintStudio(filteredAndSortedItems)}
                style={{ padding: '4px 10px', fontSize: '0.78rem', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                title="Print tags for all currently filtered items"
              >
                <Printer size={13} />
                <span>Print All Filtered ({filteredAndSortedItems.length})</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Inventory Table */}
      {filteredAndSortedItems.length === 0 ? (
        <div
          style={{
            padding: '60px 20px',
            textAlign: 'center',
            color: 'var(--text-muted)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <Package size={42} color="rgba(212, 175, 55, 0.4)" />
          <p style={{ fontSize: '1rem', margin: 0, fontWeight: 500 }}>
            No pieces found matching your criteria
          </p>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
            Try adjusting your search terms or clearing status filters.
          </span>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              textAlign: 'left',
              fontSize: '0.88rem',
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: '1px solid var(--border-subtle)',
                  color: 'var(--text-dim)',
                  fontSize: '0.75rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                {/* Select All Checkbox */}
                <th style={{ padding: '12px 10px', width: '38px', textAlign: 'center' }}>
                  <button
                    type="button"
                    onClick={toggleSelectAll}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: allFilteredSelected ? 'var(--gold-500)' : 'var(--text-dim)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 0,
                    }}
                    title={allFilteredSelected ? 'Deselect all' : 'Select all'}
                  >
                    {allFilteredSelected ? <CheckSquare size={17} /> : <Square size={17} />}
                  </button>
                </th>
                <th style={{ padding: '12px 14px' }}>Item & SKU Tag</th>
                <th style={{ padding: '12px 14px' }}>Type / Codes</th>
                <th
                  style={{ padding: '12px 14px', cursor: 'pointer' }}
                  onClick={() => toggleSort('quantity')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>Units</span>
                    <ArrowUpDown size={12} />
                  </div>
                </th>
                <th style={{ padding: '12px 14px' }}>Cost vs Retail</th>
                <th
                  style={{ padding: '12px 14px', cursor: 'pointer' }}
                  onClick={() => toggleSort('margin')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>Margin %</span>
                    <ArrowUpDown size={12} />
                  </div>
                </th>
                <th
                  style={{ padding: '12px 14px', cursor: 'pointer' }}
                  onClick={() => toggleSort('retailValue')}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>Total Value</span>
                    <ArrowUpDown size={12} />
                  </div>
                </th>
                <th style={{ padding: '12px 14px', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredAndSortedItems.map((item) => {
                const isSelected = selectedIds.includes(item.id);
                const fin = calculateItemFinancials(item.buyingPrice, item.sellingPrice, item.quantity);
                const isLow = item.quantity <= item.reorderLevel && item.quantity > 0;
                const isOut = item.quantity === 0;

                const typeLabel = codeTables.types.find((t) => t.code === item.typeCode)?.label || item.typeCode;
                const stoneLabel = codeTables.stones.find((s) => s.code === item.stoneCode)?.label || item.stoneCode;
                const colorLabel = codeTables.colors.find((c) => c.code === item.colorCode)?.label || item.colorCode;

                return (
                  <tr
                    key={item.id}
                    style={{
                      borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
                      backgroundColor: isSelected ? 'rgba(212, 175, 55, 0.08)' : 'transparent',
                      transition: 'background-color 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.02)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                  >
                    {/* Row Checkbox */}
                    <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                      <button
                        type="button"
                        onClick={() => toggleSelectItem(item.id)}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          color: isSelected ? 'var(--gold-500)' : 'var(--text-dim)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: 0,
                        }}
                      >
                        {isSelected ? <CheckSquare size={17} /> : <Square size={17} />}
                      </button>
                    </td>

                    {/* Item & SKU */}
                    <td style={{ padding: '14px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        {item.imageUrl ? (
                          <img
                            src={item.imageUrl}
                            alt={item.title}
                            style={{
                              width: '46px',
                              height: '46px',
                              borderRadius: '8px',
                              objectFit: 'cover',
                              border: '1px solid rgba(212, 175, 55, 0.3)',
                              flexShrink: 0,
                            }}
                          />
                        ) : (
                          <div
                            style={{
                              width: '46px',
                              height: '46px',
                              borderRadius: '8px',
                              background: 'rgba(255, 255, 255, 0.04)',
                              border: '1px solid rgba(255, 255, 255, 0.1)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              color: 'var(--text-dim)',
                              fontSize: '0.7rem',
                              flexShrink: 0,
                            }}
                          >
                            No Img
                          </div>
                        )}
                        <div>
                          <div
                            style={{
                              fontWeight: 600,
                              color: '#ffffff',
                              fontSize: '0.92rem',
                              marginBottom: '4px',
                            }}
                          >
                            {item.title}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            <SkuTagBadge sku={item.sku} size="sm" />
                            {item.shopifyProductId ? (
                              <span
                                style={{
                                  fontSize: '0.68rem',
                                  fontWeight: 600,
                                  color: '#34d399',
                                  background: 'rgba(16, 185, 129, 0.12)',
                                  border: '1px solid rgba(16, 185, 129, 0.3)',
                                  padding: '1px 6px',
                                  borderRadius: '4px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '3px',
                                }}
                                title={`Synced on Shopify (ID: ${item.shopifyProductId})`}
                              >
                                <Store size={10} />
                                SaazAura
                              </span>
                            ) : null}
                            {item.isListedOnAmazon ? (
                              <span
                                style={{
                                  fontSize: '0.68rem',
                                  fontWeight: 600,
                                  color: '#fbbf24',
                                  background: 'rgba(245, 158, 11, 0.12)',
                                  border: '1px solid rgba(245, 158, 11, 0.3)',
                                  padding: '1px 6px',
                                  borderRadius: '4px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                }}
                                title={`Listed on Amazon India${item.amazonAsin ? ` (${item.amazonAsin})` : ''}`}
                              >
                                Amazon
                              </span>
                            ) : null}
                            {item.isListedOnMyntra ? (
                              <span
                                style={{
                                  fontSize: '0.68rem',
                                  fontWeight: 600,
                                  color: '#f472b6',
                                  background: 'rgba(236, 72, 153, 0.12)',
                                  border: '1px solid rgba(236, 72, 153, 0.3)',
                                  padding: '1px 6px',
                                  borderRadius: '4px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                }}
                                title={`Listed on Myntra Portal${item.myntraStyleId ? ` (${item.myntraStyleId})` : ''}`}
                              >
                                Myntra
                              </span>
                            ) : null}
                            {item.safetyReserve && item.safetyReserve > 0 ? (
                              <span
                                style={{
                                  fontSize: '0.68rem',
                                  fontWeight: 500,
                                  color: '#94a3b8',
                                  background: 'rgba(148, 163, 184, 0.1)',
                                  border: '1px solid rgba(148, 163, 184, 0.25)',
                                  padding: '1px 5px',
                                  borderRadius: '4px',
                                }}
                                title={`Reserve Buffer: ${item.safetyReserve} pcs reserved offline`}
                              >
                                Buf: {item.safetyReserve}
                              </span>
                            ) : null}
                            {item.vendor && (
                              <span
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedVendor(item.vendor);
                                }}
                                style={{
                                  fontSize: '0.72rem',
                                  color: 'var(--text-dim)',
                                  cursor: 'pointer',
                                  textDecoration: 'underline',
                                  textUnderlineOffset: '2px',
                                }}
                                title={`Filter register to pieces from ${item.vendor}`}
                              >
                                {item.vendor}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Type & Codes */}
                    <td style={{ padding: '14px' }}>
                      <div style={{ fontSize: '0.82rem', color: 'var(--text-main)', fontWeight: 500 }}>
                        {typeLabel}
                      </div>
                      <div
                        style={{
                          fontSize: '0.72rem',
                          color: 'var(--text-dim)',
                          marginTop: '2px',
                          display: 'flex',
                          gap: '6px',
                        }}
                      >
                        <span>{stoneLabel}</span>
                        <span>•</span>
                        <span>{colorLabel}</span>
                      </div>
                    </td>

                    {/* Stock & Quick Adjust */}
                    <td style={{ padding: '14px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <button
                          type="button"
                          onClick={() => onAdjustQuantity(item.id, -1)}
                          disabled={item.quantity <= 0}
                          style={{
                            width: '24px',
                            height: '24px',
                            borderRadius: '4px',
                            background: 'rgba(255, 255, 255, 0.05)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            color: 'var(--text-main)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: item.quantity <= 0 ? 'not-allowed' : 'pointer',
                            opacity: item.quantity <= 0 ? 0.4 : 1,
                          }}
                          title="Decrease 1 unit"
                        >
                          <Minus size={12} />
                        </button>

                        <span
                          style={{
                            fontWeight: 700,
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.95rem',
                            minWidth: '24px',
                            textAlign: 'center',
                            color: isOut ? '#f43f5e' : isLow ? '#f59e0b' : '#ffffff',
                          }}
                        >
                          {item.quantity}
                        </span>

                        <button
                          type="button"
                          onClick={() => onAdjustQuantity(item.id, 1)}
                          style={{
                            width: '24px',
                            height: '24px',
                            borderRadius: '4px',
                            background: 'rgba(255, 255, 255, 0.05)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            color: 'var(--text-main)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: 'pointer',
                          }}
                          title="Increase 1 unit"
                        >
                          <Plus size={12} />
                        </button>
                      </div>

                      {isOut && (
                        <span className="badge badge-out-of-stock" style={{ marginTop: '4px' }}>
                          Out of stock
                        </span>
                      )}
                      {isLow && (
                        <span className="badge badge-low-stock" style={{ marginTop: '4px' }}>
                          Low (Min {item.reorderLevel})
                        </span>
                      )}
                    </td>

                    {/* Cost vs Retail */}
                    <td style={{ padding: '14px' }}>
                      <div style={{ color: '#34d399', fontWeight: 600 }}>
                        {formatCurrency(item.sellingPrice)}
                      </div>
                      <div style={{ fontSize: '0.74rem', color: 'var(--text-dim)', marginTop: '2px' }}>
                        Cost: {formatCurrency(item.buyingPrice)}
                      </div>
                    </td>

                    {/* Margin % */}
                    <td style={{ padding: '14px' }}>
                      <span
                        style={{
                          fontWeight: 700,
                          fontSize: '0.85rem',
                          color: fin.marginPercent > 50 ? '#34d399' : '#fae084',
                          background: 'rgba(255, 255, 255, 0.03)',
                          padding: '3px 8px',
                          borderRadius: '4px',
                          border: '1px solid rgba(255, 255, 255, 0.06)',
                        }}
                      >
                        {fin.marginPercent}%
                      </span>
                    </td>

                    {/* Total Retail Valuation */}
                    <td style={{ padding: '14px' }}>
                      <div style={{ fontWeight: 600, color: '#ffffff' }}>
                        {formatCurrency(fin.totalRetail)}
                      </div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                        Profit: {formatCurrency(fin.potentialProfit)}
                      </div>
                    </td>

                    {/* Action buttons */}
                    <td style={{ padding: '14px', textAlign: 'right' }}>
                      <div
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                        }}
                      >
                        {/* Record Sale Button */}
                        <button
                          type="button"
                          onClick={() => onOpenRecordSale(item)}
                          disabled={item.quantity <= 0}
                          style={{
                            background: item.quantity > 0 ? 'rgba(16, 185, 129, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                            border: `1px solid ${item.quantity > 0 ? 'rgba(16, 185, 129, 0.35)' : 'rgba(255, 255, 255, 0.08)'}`,
                            borderRadius: '6px',
                            padding: '6px 8px',
                            color: item.quantity > 0 ? '#34d399' : 'var(--text-dim)',
                            cursor: item.quantity > 0 ? 'pointer' : 'not-allowed',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                          }}
                          title={item.quantity > 0 ? 'Record sale & realize profit' : 'Item out of stock'}
                        >
                          <ShoppingBag size={13} />
                          <span>Sell</span>
                        </button>

                        {/* Print Single Tag */}
                        <button
                          type="button"
                          onClick={() => onOpenPrintStudio([item])}
                          style={{
                            background: 'rgba(212, 175, 55, 0.1)',
                            border: '1px solid rgba(212, 175, 55, 0.25)',
                            borderRadius: '6px',
                            padding: '6px',
                            color: '#fae084',
                            cursor: 'pointer',
                          }}
                          title="Print barcode tag for this piece"
                        >
                          <Printer size={14} />
                        </button>

                        {/* Push to Shopify */}
                        {onPushItemToShopify && (
                          <button
                            type="button"
                            onClick={() => onPushItemToShopify(item)}
                            style={{
                              background: item.shopifyProductId ? 'rgba(16, 185, 129, 0.1)' : 'rgba(255, 255, 255, 0.05)',
                              border: `1px solid ${item.shopifyProductId ? 'rgba(16, 185, 129, 0.3)' : 'rgba(255, 255, 255, 0.1)'}`,
                              borderRadius: '6px',
                              padding: '6px',
                              color: item.shopifyProductId ? '#34d399' : 'var(--text-muted)',
                              cursor: 'pointer',
                            }}
                            title={item.shopifyProductId ? 'Update on Shopify' : 'Push piece to Shopify'}
                          >
                            <UploadCloud size={14} />
                          </button>
                        )}

                        {/* Edit Item */}
                        <button
                          type="button"
                          onClick={() => onEditItem(item)}
                          style={{
                            background: 'rgba(255, 255, 255, 0.05)',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                            borderRadius: '6px',
                            padding: '6px',
                            color: 'var(--text-muted)',
                            cursor: 'pointer',
                          }}
                          title="Edit piece"
                        >
                          <Edit2 size={14} />
                        </button>

                        {/* Delete Item */}
                        <button
                          type="button"
                          onClick={() => onDeleteItem(item.id)}
                          style={{
                            background: 'rgba(244, 63, 94, 0.1)',
                            border: '1px solid rgba(244, 63, 94, 0.25)',
                            borderRadius: '6px',
                            padding: '6px',
                            color: '#f87171',
                            cursor: 'pointer',
                          }}
                          title="Delete piece"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Sticky Batch Action Bar */}
      {selectedIds.length > 0 && (
        <div className="batch-actions-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '24px',
                height: '24px',
                borderRadius: '50%',
                background: 'var(--gold-500)',
                color: '#0c0d10',
                fontWeight: 800,
                fontSize: '0.8rem',
              }}
            >
              {selectedIds.length}
            </span>
            <span style={{ fontWeight: 600, color: '#ffffff', fontSize: '0.9rem' }}>
              {selectedIds.length === 1 ? 'Piece' : 'Pieces'} Selected
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            {/* Print Tags for Selected */}
            <button
              type="button"
              className="btn-primary"
              onClick={() => onOpenPrintStudio(selectedItems)}
              style={{ padding: '7px 14px', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Printer size={15} />
              <span>Print Tags ({selectedIds.length})</span>
            </button>

            {/* Push Selected to Shopify */}
            {onBulkPushToShopify && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => onBulkPushToShopify(selectedItems)}
                style={{ padding: '7px 14px', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '6px' }}
              >
                <Store size={15} color="#10b981" />
                <span>Push to Shopify ({selectedIds.length})</span>
              </button>
            )}

            {/* Export Selected CSV */}
            <button
              type="button"
              className="btn-secondary"
              onClick={handleBulkExportCSV}
              style={{ padding: '7px 14px', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Download size={15} />
              <span>Export CSV</span>
            </button>

            {/* Bulk Restock */}
            <button
              type="button"
              className="btn-secondary"
              onClick={handleBulkRestockItems}
              style={{ padding: '7px 14px', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <PlusCircle size={15} />
              <span>Bulk Restock</span>
            </button>

            {/* Bulk Delete */}
            <button
              type="button"
              className="btn-danger"
              onClick={handleBulkDeleteItems}
              style={{ padding: '7px 14px', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <Trash2 size={15} />
              <span>Delete</span>
            </button>

            {/* Clear Selection */}
            <button
              type="button"
              onClick={() => setSelectedIds([])}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-dim)',
                cursor: 'pointer',
                padding: '6px',
                display: 'flex',
                alignItems: 'center',
              }}
              title="Deselect all"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
