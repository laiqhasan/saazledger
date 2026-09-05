import React, { useState, useMemo, useRef } from 'react';
import type { VendorItem, JewelryItem, StockMovement } from '../types/inventory';
import {
  calculateVendorMetrics,
  generateVendorReorderSheetCsv,
  generateVendorsExportCsv,
  parseVendorsCsv,
  isItemFromVendor,
} from '../services/vendorService';
import { downloadFile } from '../services/storage';
import { formatCurrency } from '../services/skuEngine';
import { SkuTagBadge } from './SkuTagBadge';
import {
  X,
  Users,
  Plus,
  Search,
  Phone,
  MapPin,
  Download,
  Upload,
  AlertTriangle,
  Edit2,
  Trash2,
  FileText,
} from 'lucide-react';
import confetti from 'canvas-confetti';

interface VendorMasterModalProps {
  vendors: VendorItem[];
  inventory: JewelryItem[];
  transactions: StockMovement[];
  onSaveVendor: (vendor: VendorItem) => void;
  onDeleteVendor: (vendorId: string) => void;
  onImportVendors: (imported: VendorItem[]) => void;
  onSelectVendorForFilter?: (vendorName: string) => void;
  onClose: () => void;
}

export const VendorMasterModal: React.FC<VendorMasterModalProps> = ({
  vendors,
  inventory,
  transactions,
  onSaveVendor,
  onDeleteVendor,
  onImportVendors,
  onSelectVendorForFilter,
  onClose,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCity, setSelectedCity] = useState<string>('all');
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(
    vendors.length > 0 ? vendors[0].id : null
  );

  // Form modal for Add / Edit
  const [editingVendor, setEditingVendor] = useState<VendorItem | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);

  // Notice toast
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Extract unique cities
  const uniqueCities = useMemo(() => {
    const set = new Set<string>();
    vendors.forEach((v) => {
      if (v.city) set.add(v.city.trim());
    });
    return Array.from(set).sort();
  }, [vendors]);

  // Filtered vendors
  const filteredVendors = useMemo(() => {
    return vendors.filter((v) => {
      if (selectedCity !== 'all' && v.city?.toLowerCase() !== selectedCity.toLowerCase()) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = v.name.toLowerCase().includes(q);
        const matchCode = v.code.toLowerCase().includes(q);
        const matchPerson = (v.contactPerson || '').toLowerCase().includes(q);
        const matchCity = (v.city || '').toLowerCase().includes(q);
        const matchSpecialty = (v.specialty || '').toLowerCase().includes(q);
        if (!matchName && !matchCode && !matchPerson && !matchCity && !matchSpecialty) {
          return false;
        }
      }
      return true;
    });
  }, [vendors, selectedCity, searchQuery]);

  // Currently selected vendor
  const currentVendor = useMemo(() => {
    return vendors.find((v) => v.id === selectedVendorId) || filteredVendors[0] || null;
  }, [vendors, selectedVendorId, filteredVendors]);

  // Metrics for all vendors
  const allVendorMetrics = useMemo(() => {
    const map = new Map<string, ReturnType<typeof calculateVendorMetrics>>();
    vendors.forEach((v) => {
      map.set(v.id, calculateVendorMetrics(v, inventory, transactions));
    });
    return map;
  }, [vendors, inventory, transactions]);

  // Overall Global Vendor Stats
  const globalStats = useMemo(() => {
    let totalCostVal = 0;
    let totalRealizedProfit = 0;
    let vendorsWithLowStock = 0;

    allVendorMetrics.forEach((m) => {
      totalCostVal += m.costValuation;
      totalRealizedProfit += m.realizedGrossProfit;
      if (m.lowStockItemCount > 0) {
        vendorsWithLowStock++;
      }
    });

    return {
      activeCount: vendors.filter((v) => v.status === 'active').length,
      totalCostVal,
      totalRealizedProfit,
      vendorsWithLowStock,
    };
  }, [vendors, allVendorMetrics]);

  // Selected vendor pieces
  const currentVendorItems = useMemo(() => {
    if (!currentVendor) return [];
    return inventory.filter((item) => isItemFromVendor(item, currentVendor));
  }, [inventory, currentVendor]);

  const currentVendorLowStock = useMemo(() => {
    return currentVendorItems.filter((i) => i.quantity <= (i.reorderLevel || 0));
  }, [currentVendorItems]);

  const currentMetrics = currentVendor
    ? allVendorMetrics.get(currentVendor.id)
    : null;

  // Handler: Open Add Vendor Form
  const handleOpenAdd = () => {
    setEditingVendor({
      id: `vendor-${Date.now()}`,
      code: '',
      name: '',
      specialty: 'Kundan & Jadau Artisans',
      city: 'Jaipur',
      paymentTerms: 'Net 15',
      leadTimeDays: 10,
      rating: 5,
      status: 'active',
      createdAt: new Date().toISOString().split('T')[0],
    });
    setIsFormOpen(true);
  };

  // Handler: Open Edit Vendor Form
  const handleOpenEdit = (v: VendorItem) => {
    setEditingVendor({ ...v });
    setIsFormOpen(true);
  };

  // Handler: Save Vendor
  const handleSaveForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingVendor || !editingVendor.name.trim()) {
      alert('Please provide a Vendor / Artisan Name.');
      return;
    }

    const codeToSave =
      editingVendor.code.trim().toUpperCase() ||
      editingVendor.name.slice(0, 3).toUpperCase();

    const vendorToSave: VendorItem = {
      ...editingVendor,
      code: codeToSave,
      name: editingVendor.name.trim(),
    };

    onSaveVendor(vendorToSave);
    setSelectedVendorId(vendorToSave.id);
    setIsFormOpen(false);
    setEditingVendor(null);

    setNotice(`Vendor "${vendorToSave.name}" (${vendorToSave.code}) saved successfully!`);
    setTimeout(() => setNotice(null), 4000);
  };

  // Handler: Delete Vendor
  const handleDelete = (v: VendorItem) => {
    if (window.confirm(`Are you sure you want to remove artisan "${v.name}" (${v.code}) from Vendor Master?`)) {
      onDeleteVendor(v.id);
      if (selectedVendorId === v.id) {
        setSelectedVendorId(null);
      }
      setNotice(`Vendor "${v.name}" removed.`);
      setTimeout(() => setNotice(null), 3000);
    }
  };

  // Handler: Download Reorder PO Sheet for current vendor
  const handleDownloadReorderSheet = () => {
    if (!currentVendor) return;
    if (currentVendorLowStock.length === 0) {
      alert(`No low-stock items detected for ${currentVendor.name}. All pieces are adequately stocked!`);
      return;
    }

    const csvContent = generateVendorReorderSheetCsv(currentVendor, currentVendorLowStock);
    const filename = `SaazAura_Reorder_PO_${currentVendor.code}_${new Date().toISOString().slice(0, 10)}.csv`;
    downloadFile(csvContent, filename, 'text/csv;charset=utf-8;');

    try {
      confetti({
        particleCount: 30,
        spread: 50,
        origin: { y: 0.6 },
        colors: ['#d4af37', '#10b981'],
      });
    } catch {}

    setNotice(`Generated Purchase Order with ${currentVendorLowStock.length} items for ${currentVendor.name}`);
    setTimeout(() => setNotice(null), 4000);
  };

  // Handler: Export All Vendors
  const handleExportVendors = () => {
    const csvContent = generateVendorsExportCsv(vendors);
    downloadFile(csvContent, `Saaz_Vendors_Master_${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8;');
  };

  // Handler: Import CSV
  const handleImportCsv = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const imported = parseVendorsCsv(text);
      if (imported.length > 0) {
        onImportVendors(imported);
        setNotice(`Successfully imported ${imported.length} artisans & vendors!`);
        setTimeout(() => setNotice(null), 4000);
      } else {
        alert('Could not parse any vendors from the uploaded CSV. Please ensure columns include Name, Code, City.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="modal-overlay" style={{ zIndex: 1100 }}>
      <div
        className="modal-content"
        style={{
          maxWidth: '1240px',
          width: '96vw',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          overflow: 'hidden',
          border: '1px solid rgba(212, 175, 55, 0.3)',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 40px rgba(212, 175, 55, 0.15)',
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: '18px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'linear-gradient(180deg, rgba(26, 28, 36, 0.95) 0%, rgba(18, 20, 26, 0.95) 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '16px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '42px',
                height: '42px',
                borderRadius: '10px',
                background: 'rgba(212, 175, 55, 0.15)',
                border: '1px solid rgba(212, 175, 55, 0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Users size={22} color="#fae084" />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <h2
                  style={{
                    fontFamily: 'var(--font-serif)',
                    fontSize: '1.35rem',
                    fontWeight: 700,
                    color: '#ffffff',
                    margin: 0,
                  }}
                >
                  Artisans & Vendor Master Data
                </h2>
                <span
                  style={{
                    fontSize: '0.72rem',
                    padding: '2px 8px',
                    borderRadius: '12px',
                    background: 'rgba(16, 185, 129, 0.15)',
                    color: '#34d399',
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                    fontWeight: 600,
                  }}
                >
                  {vendors.length} Registered Karigars
                </span>
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '3px 0 0 0' }}>
                Manage manufacturing ateliers, gemstone suppliers, procurement reorder sheets & artisan margins
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleExportVendors}
              style={{ fontSize: '0.8rem', padding: '6px 12px', gap: '6px' }}
              title="Export Vendor Master Directory to CSV"
            >
              <Download size={14} />
              <span>Export Directory</span>
            </button>

            <button
              type="button"
              className="btn-secondary"
              onClick={() => fileInputRef.current?.click()}
              style={{ fontSize: '0.8rem', padding: '6px 12px', gap: '6px' }}
              title="Import Vendors CSV"
            >
              <Upload size={14} />
              <span>Import CSV</span>
            </button>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImportCsv}
              accept=".csv"
              style={{ display: 'none' }}
            />

            <button
              type="button"
              className="btn-primary"
              onClick={handleOpenAdd}
              style={{ fontSize: '0.82rem', padding: '7px 14px', gap: '6px' }}
            >
              <Plus size={16} />
              <span>New Artisan</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-dim)',
                cursor: 'pointer',
                padding: '6px',
                marginLeft: '8px',
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Global Notice Toast */}
        {notice && (
          <div
            style={{
              padding: '10px 20px',
              background: 'rgba(16, 185, 129, 0.15)',
              borderBottom: '1px solid rgba(16, 185, 129, 0.3)',
              color: '#34d399',
              fontSize: '0.84rem',
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <span>✓ {notice}</span>
          </div>
        )}

        {/* Top KPI Metrics Bar */}
        <div
          style={{
            padding: '16px 24px',
            background: 'rgba(255, 255, 255, 0.02)',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '14px',
          }}
        >
          <div
            style={{
              padding: '12px 16px',
              borderRadius: '8px',
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Active Artisans / Ateliers
            </div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#ffffff', marginTop: '4px' }}>
              {globalStats.activeCount} <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)', fontWeight: 400 }}>of {vendors.length} total</span>
            </div>
          </div>

          <div
            style={{
              padding: '12px 16px',
              borderRadius: '8px',
              background: 'rgba(212, 175, 55, 0.06)',
              border: '1px solid rgba(212, 175, 55, 0.2)',
            }}
          >
            <div style={{ fontSize: '0.74rem', color: '#fae084', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Capital Sourced (Cost Value)
            </div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--accent-gold)', marginTop: '4px' }}>
              {formatCurrency(globalStats.totalCostVal)}
            </div>
          </div>

          <div
            style={{
              padding: '12px 16px',
              borderRadius: '8px',
              background: 'rgba(16, 185, 129, 0.06)',
              border: '1px solid rgba(16, 185, 129, 0.2)',
            }}
          >
            <div style={{ fontSize: '0.74rem', color: '#34d399', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Realized Gross Profit Generated
            </div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: '#34d399', marginTop: '4px' }}>
              {formatCurrency(globalStats.totalRealizedProfit)}
            </div>
          </div>

          <div
            style={{
              padding: '12px 16px',
              borderRadius: '8px',
              background: globalStats.vendorsWithLowStock > 0 ? 'rgba(245, 158, 11, 0.08)' : 'rgba(255, 255, 255, 0.03)',
              border: `1px solid ${globalStats.vendorsWithLowStock > 0 ? 'rgba(245, 158, 11, 0.3)' : 'var(--border-subtle)'}`,
            }}
          >
            <div style={{ fontSize: '0.74rem', color: globalStats.vendorsWithLowStock > 0 ? '#f59e0b' : 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Procurement Alert
            </div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: globalStats.vendorsWithLowStock > 0 ? '#f59e0b' : '#ffffff', marginTop: '4px' }}>
              {globalStats.vendorsWithLowStock} <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)', fontWeight: 400 }}>vendors need restock</span>
            </div>
          </div>
        </div>

        {/* Master Body: Split View (Directory List on Left, Detail & Analytics on Right) */}
        <div style={{ display: 'grid', gridTemplateColumns: '400px 1fr', flex: 1, overflow: 'hidden' }}>
          {/* Left Panel: Directory Search & List */}
          <div
            style={{
              borderRight: '1px solid var(--border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              background: 'rgba(10, 11, 14, 0.6)',
              overflow: 'hidden',
            }}
          >
            {/* Search & City Filter */}
            <div style={{ padding: '14px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ position: 'relative' }}>
                <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-dim)' }} />
                <input
                  type="text"
                  className="input-field"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by artisan, code, city..."
                  style={{ paddingLeft: '32px', height: '34px', fontSize: '0.82rem' }}
                />
              </div>

              <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '2px' }}>
                <button
                  type="button"
                  onClick={() => setSelectedCity('all')}
                  style={{
                    padding: '3px 9px',
                    borderRadius: '12px',
                    fontSize: '0.74rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    border: '1px solid',
                    borderColor: selectedCity === 'all' ? 'var(--gold-500)' : 'var(--border-subtle)',
                    background: selectedCity === 'all' ? 'rgba(212, 175, 55, 0.2)' : 'transparent',
                    color: selectedCity === 'all' ? '#fae084' : 'var(--text-muted)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  All Hubs ({vendors.length})
                </button>
                {uniqueCities.map((city) => (
                  <button
                    key={city}
                    type="button"
                    onClick={() => setSelectedCity(city)}
                    style={{
                      padding: '3px 9px',
                      borderRadius: '12px',
                      fontSize: '0.74rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      border: '1px solid',
                      borderColor: selectedCity === city ? 'var(--gold-500)' : 'var(--border-subtle)',
                      background: selectedCity === city ? 'rgba(212, 175, 55, 0.2)' : 'transparent',
                      color: selectedCity === city ? '#fae084' : 'var(--text-muted)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {city}
                  </button>
                ))}
              </div>
            </div>

            {/* Vendor List */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
              {filteredVendors.length === 0 ? (
                <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  No vendors found matching your search.
                </div>
              ) : (
                filteredVendors.map((v) => {
                  const isSelected = currentVendor?.id === v.id;
                  const m = allVendorMetrics.get(v.id);

                  return (
                    <div
                      key={v.id}
                      onClick={() => setSelectedVendorId(v.id)}
                      style={{
                        padding: '12px 14px',
                        borderRadius: '8px',
                        marginBottom: '6px',
                        cursor: 'pointer',
                        background: isSelected ? 'rgba(212, 175, 55, 0.12)' : 'rgba(255, 255, 255, 0.02)',
                        border: `1px solid ${isSelected ? 'rgba(212, 175, 55, 0.4)' : 'transparent'}`,
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span
                            style={{
                              fontSize: '0.72rem',
                              fontWeight: 700,
                              fontFamily: 'var(--font-mono)',
                              background: 'rgba(255, 255, 255, 0.08)',
                              color: 'var(--accent-gold)',
                              padding: '1px 6px',
                              borderRadius: '4px',
                            }}
                          >
                            {v.code}
                          </span>
                          <span style={{ fontSize: '0.88rem', fontWeight: 600, color: isSelected ? '#ffffff' : 'var(--text-main)' }}>
                            {v.name}
                          </span>
                        </div>
                        {m && m.lowStockItemCount > 0 && (
                          <span
                            style={{
                              fontSize: '0.68rem',
                              padding: '1px 6px',
                              borderRadius: '10px',
                              background: 'rgba(245, 158, 11, 0.2)',
                              color: '#f59e0b',
                              border: '1px solid rgba(245, 158, 11, 0.3)',
                              fontWeight: 600,
                            }}
                            title={`${m.lowStockItemCount} items below reorder level`}
                          >
                            {m.lowStockItemCount} low
                          </span>
                        )}
                      </div>

                      <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {v.specialty || v.city}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                        <span>
                          <strong style={{ color: '#ffffff' }}>{m?.totalPiecesSupplied || 0}</strong> SKUs ({m?.inStockUnits || 0} pcs)
                        </span>
                        <span style={{ color: '#fae084', fontWeight: 600 }}>
                          {formatCurrency(m?.costValuation || 0)}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right Panel: Selected Vendor Detail & Stock Intelligence */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {currentVendor ? (
              <>
                {/* Vendor Profile Card */}
                <div
                  style={{
                    padding: '20px',
                    borderRadius: '12px',
                    background: 'rgba(255, 255, 255, 0.02)',
                    border: '1px solid var(--border-subtle)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '16px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                        <span
                          style={{
                            fontSize: '0.82rem',
                            fontWeight: 700,
                            fontFamily: 'var(--font-mono)',
                            background: 'rgba(212, 175, 55, 0.2)',
                            color: 'var(--accent-gold)',
                            padding: '2px 8px',
                            borderRadius: '4px',
                            border: '1px solid rgba(212, 175, 55, 0.4)',
                          }}
                        >
                          {currentVendor.code}
                        </span>
                        <h3 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#ffffff', margin: 0 }}>
                          {currentVendor.name}
                        </h3>
                        <span
                          style={{
                            fontSize: '0.72rem',
                            padding: '2px 8px',
                            borderRadius: '12px',
                            background: currentVendor.status === 'active' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(255, 255, 255, 0.1)',
                            color: currentVendor.status === 'active' ? '#34d399' : 'var(--text-muted)',
                            fontWeight: 600,
                          }}
                        >
                          {currentVendor.status === 'active' ? 'Active Partner' : 'Inactive'}
                        </span>
                      </div>

                      <div style={{ fontSize: '0.84rem', color: 'var(--text-muted)', marginTop: '6px' }}>
                        {currentVendor.specialty || 'Fine Jewelry Manufacturer'}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '8px' }}>
                      {onSelectVendorForFilter && (
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => {
                            onSelectVendorForFilter(currentVendor.name);
                            onClose();
                          }}
                          style={{ fontSize: '0.78rem', padding: '5px 12px' }}
                          title="Filter Inventory Register to this artisan"
                        >
                          <FileText size={13} />
                          <span>Show in Register</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => handleOpenEdit(currentVendor)}
                        style={{ fontSize: '0.78rem', padding: '5px 10px' }}
                        title="Edit Vendor Information"
                      >
                        <Edit2 size={13} />
                        <span>Edit</span>
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => handleDelete(currentVendor)}
                        style={{ fontSize: '0.78rem', padding: '5px 10px', color: '#f87171' }}
                        title="Delete Vendor"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>

                  {/* Vendor Contact & Business Details Grid */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                      gap: '12px',
                      padding: '12px 16px',
                      borderRadius: '8px',
                      background: 'rgba(0, 0, 0, 0.25)',
                      fontSize: '0.8rem',
                    }}
                  >
                    <div>
                      <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Contact Person</div>
                      <div style={{ fontWeight: 600, color: 'var(--text-main)', marginTop: '2px' }}>
                        {currentVendor.contactPerson || '—'}
                      </div>
                    </div>

                    <div>
                      <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Phone / WhatsApp</div>
                      <div style={{ fontWeight: 600, color: '#34d399', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        {currentVendor.phone ? (
                          <a
                            href={`https://wa.me/${currentVendor.phone.replace(/[^0-9]/g, '')}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: '#34d399', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                            title="Chat on WhatsApp"
                          >
                            <Phone size={12} />
                            {currentVendor.phone}
                          </a>
                        ) : (
                          '—'
                        )}
                      </div>
                    </div>

                    <div>
                      <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>City / Hub</div>
                      <div style={{ fontWeight: 600, color: 'var(--text-main)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <MapPin size={12} color="#fae084" />
                        {currentVendor.city || '—'}
                      </div>
                    </div>

                    <div>
                      <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Payment Terms</div>
                      <div style={{ fontWeight: 600, color: '#60a5fa', marginTop: '2px' }}>
                        {currentVendor.paymentTerms || 'Net 15'}
                      </div>
                    </div>

                    <div>
                      <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>Restock Lead Time</div>
                      <div style={{ fontWeight: 600, color: 'var(--text-main)', marginTop: '2px' }}>
                        {currentVendor.leadTimeDays ? `${currentVendor.leadTimeDays} Days` : '10 Days'}
                      </div>
                    </div>

                    <div>
                      <div style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>GSTIN / Tax ID</div>
                      <div style={{ fontWeight: 600, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: '2px' }}>
                        {currentVendor.gstin || 'Unregistered'}
                      </div>
                    </div>
                  </div>

                  {currentVendor.notes && (
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      &ldquo;{currentVendor.notes}&rdquo;
                    </div>
                  )}
                </div>

                {/* Financial & Stock Intelligence Cards for Current Vendor */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
                  <div style={{ padding: '12px 14px', borderRadius: '8px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-subtle)' }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Cataloged SKUs</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#ffffff', marginTop: '3px' }}>
                      {currentMetrics?.totalPiecesSupplied || 0}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                      {currentMetrics?.inStockUnits || 0} units in stock
                    </div>
                  </div>

                  <div style={{ padding: '12px 14px', borderRadius: '8px', background: 'rgba(212, 175, 55, 0.06)', border: '1px solid rgba(212, 175, 55, 0.2)' }}>
                    <div style={{ fontSize: '0.72rem', color: '#fae084' }}>Capital Invested (Cost)</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--accent-gold)', marginTop: '3px' }}>
                      {formatCurrency(currentMetrics?.costValuation || 0)}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                      Total inventory wholesale
                    </div>
                  </div>

                  <div style={{ padding: '12px 14px', borderRadius: '8px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border-subtle)' }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Retail Value</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#ffffff', marginTop: '3px' }}>
                      {formatCurrency(currentMetrics?.retailValuation || 0)}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: '#60a5fa' }}>
                      Avg Margin: {currentMetrics?.averageMarginPercent || 0}%
                    </div>
                  </div>

                  <div style={{ padding: '12px 14px', borderRadius: '8px', background: 'rgba(16, 185, 129, 0.06)', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                    <div style={{ fontSize: '0.72rem', color: '#34d399' }}>Realized Profit</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#34d399', marginTop: '3px' }}>
                      {formatCurrency(currentMetrics?.realizedGrossProfit || 0)}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                      {currentMetrics?.realizedSalesUnits || 0} units sold
                    </div>
                  </div>
                </div>

                {/* Procurement Purchase Order Action Bar */}
                <div
                  style={{
                    padding: '14px 18px',
                    borderRadius: '10px',
                    background: currentVendorLowStock.length > 0 ? 'rgba(245, 158, 11, 0.08)' : 'rgba(255, 255, 255, 0.02)',
                    border: `1px solid ${currentVendorLowStock.length > 0 ? 'rgba(245, 158, 11, 0.3)' : 'var(--border-subtle)'}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '14px',
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <AlertTriangle size={18} color={currentVendorLowStock.length > 0 ? '#f59e0b' : 'var(--text-dim)'} />
                    <div>
                      <div style={{ fontSize: '0.88rem', fontWeight: 600, color: currentVendorLowStock.length > 0 ? '#ffffff' : 'var(--text-muted)' }}>
                        {currentVendorLowStock.length > 0
                          ? `${currentVendorLowStock.length} piece(s) below reorder threshold for ${currentVendor.name}`
                          : `All inventory for ${currentVendor.name} is adequately stocked.`}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                        Generate procurement restock sheet / PO formatted for supplier dispatch.
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="btn-primary"
                    disabled={currentVendorLowStock.length === 0}
                    onClick={handleDownloadReorderSheet}
                    style={{
                      fontSize: '0.82rem',
                      padding: '7px 14px',
                      background: currentVendorLowStock.length > 0 ? undefined : 'rgba(255,255,255,0.1)',
                      borderColor: currentVendorLowStock.length > 0 ? undefined : 'transparent',
                      color: currentVendorLowStock.length > 0 ? undefined : 'var(--text-dim)',
                    }}
                  >
                    <Download size={14} />
                    <span>Download Reorder PO ({currentVendorLowStock.length})</span>
                  </button>
                </div>

                {/* Pieces Supplied Table */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                    <h4 style={{ fontSize: '0.95rem', fontWeight: 600, color: '#ffffff', margin: 0 }}>
                      Cataloged Pieces from {currentVendor.name} ({currentVendorItems.length})
                    </h4>
                  </div>

                  {currentVendorItems.length === 0 ? (
                    <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                      No pieces cataloged under this artisan yet. When registering new pieces, select this artisan from the vendor dropdown.
                    </div>
                  ) : (
                    <div style={{ overflowX: 'auto', border: '1px solid var(--border-subtle)', borderRadius: '8px' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                        <thead>
                          <tr style={{ background: 'rgba(255, 255, 255, 0.03)', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-dim)', textAlign: 'left' }}>
                            <th style={{ padding: '10px 12px' }}>SKU</th>
                            <th style={{ padding: '10px 12px' }}>Piece Title</th>
                            <th style={{ padding: '10px 12px' }}>Stock</th>
                            <th style={{ padding: '10px 12px' }}>Cost</th>
                            <th style={{ padding: '10px 12px' }}>Retail</th>
                            <th style={{ padding: '10px 12px' }}>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {currentVendorItems.map((item) => {
                            const isLow = item.quantity <= (item.reorderLevel || 0);
                            return (
                              <tr
                                key={item.id}
                                style={{
                                  borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                                  background: isLow ? 'rgba(245, 158, 11, 0.03)' : 'transparent',
                                }}
                              >
                                <td style={{ padding: '10px 12px' }}>
                                  <SkuTagBadge sku={item.sku} size="sm" />
                                </td>
                                <td style={{ padding: '10px 12px', fontWeight: 500, color: '#ffffff' }}>
                                  {item.title}
                                </td>
                                <td style={{ padding: '10px 12px' }}>
                                  <span style={{ fontWeight: 700, color: isLow ? '#f59e0b' : '#34d399' }}>
                                    {item.quantity} pcs
                                  </span>
                                  <span style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginLeft: '4px' }}>
                                    (min {item.reorderLevel})
                                  </span>
                                </td>
                                <td style={{ padding: '10px 12px', color: 'var(--text-muted)' }}>
                                  {formatCurrency(item.buyingPrice)}
                                </td>
                                <td style={{ padding: '10px 12px', color: 'var(--accent-gold)', fontWeight: 600 }}>
                                  {formatCurrency(item.sellingPrice)}
                                </td>
                                <td style={{ padding: '10px 12px' }}>
                                  {isLow ? (
                                    <span style={{ fontSize: '0.7rem', padding: '1px 6px', borderRadius: '4px', background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.3)' }}>
                                      Needs Restock
                                    </span>
                                  ) : (
                                    <span style={{ fontSize: '0.7rem', padding: '1px 6px', borderRadius: '4px', background: 'rgba(16, 185, 129, 0.15)', color: '#34d399' }}>
                                      In Stock
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                Select an artisan or vendor from the directory to inspect profile and stock.
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div
          style={{
            padding: '12px 24px',
            borderTop: '1px solid var(--border-subtle)',
            background: 'rgba(10, 11, 14, 0.95)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
            Vendor codes (e.g. ACJ, RZC) link automatically to inventory items & batch procurement sheets.
          </div>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {/* Add / Edit Vendor Sub-Modal */}
      {isFormOpen && editingVendor && (
        <div
          className="modal-overlay"
          style={{ zIndex: 1200, background: 'rgba(0, 0, 0, 0.75)' }}
        >
          <div className="modal-content" style={{ maxWidth: '580px', maxHeight: '88vh', overflowY: 'auto' }}>
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: '#ffffff', margin: 0 }}>
                {editingVendor.code ? `Edit Artisan (${editingVendor.code})` : 'Register New Artisan / Vendor'}
              </h3>
              <button
                type="button"
                onClick={() => setIsFormOpen(false)}
                style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveForm} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '12px' }}>
                <div>
                  <label className="input-label">Vendor Code</label>
                  <input
                    type="text"
                    maxLength={5}
                    className="input-field"
                    value={editingVendor.code}
                    onChange={(e) => setEditingVendor({ ...editingVendor, code: e.target.value.toUpperCase() })}
                    placeholder="e.g. ACJ"
                    style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}
                  />
                </div>
                <div>
                  <label className="input-label">Artisan / Workshop Name *</label>
                  <input
                    type="text"
                    required
                    className="input-field"
                    value={editingVendor.name}
                    onChange={(e) => setEditingVendor({ ...editingVendor, name: e.target.value })}
                    placeholder="e.g. Aura Creations Jaipur"
                  />
                </div>
              </div>

              <div>
                <label className="input-label">Specialty / Craft Domain</label>
                <input
                  type="text"
                  className="input-field"
                  value={editingVendor.specialty || ''}
                  onChange={(e) => setEditingVendor({ ...editingVendor, specialty: e.target.value })}
                  placeholder="e.g. Kundan & Jadau, Floral Meenakari, Drop Jade Beads"
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label className="input-label">Contact Person</label>
                  <input
                    type="text"
                    className="input-field"
                    value={editingVendor.contactPerson || ''}
                    onChange={(e) => setEditingVendor({ ...editingVendor, contactPerson: e.target.value })}
                    placeholder="e.g. Vikram Sharma"
                  />
                </div>
                <div>
                  <label className="input-label">Phone / WhatsApp</label>
                  <input
                    type="text"
                    className="input-field"
                    value={editingVendor.phone || ''}
                    onChange={(e) => setEditingVendor({ ...editingVendor, phone: e.target.value })}
                    placeholder="e.g. +91 98290 12345"
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label className="input-label">City / Jewelry Hub</label>
                  <input
                    type="text"
                    className="input-field"
                    value={editingVendor.city || ''}
                    onChange={(e) => setEditingVendor({ ...editingVendor, city: e.target.value })}
                    placeholder="e.g. Jaipur"
                  />
                </div>
                <div>
                  <label className="input-label">Email Address</label>
                  <input
                    type="email"
                    className="input-field"
                    value={editingVendor.email || ''}
                    onChange={(e) => setEditingVendor({ ...editingVendor, email: e.target.value })}
                    placeholder="e.g. artisan@gmail.com"
                  />
                </div>
              </div>

              <div>
                <label className="input-label">Workshop / Atelier Address</label>
                <input
                  type="text"
                  className="input-field"
                  value={editingVendor.address || ''}
                  onChange={(e) => setEditingVendor({ ...editingVendor, address: e.target.value })}
                  placeholder="e.g. 142 Johari Bazaar, Jaipur"
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
                <div>
                  <label className="input-label">Payment Terms</label>
                  <select
                    className="select-field"
                    value={editingVendor.paymentTerms || 'Net 15'}
                    onChange={(e) => setEditingVendor({ ...editingVendor, paymentTerms: e.target.value })}
                  >
                    <option value="Net 15">Net 15</option>
                    <option value="Net 30">Net 30</option>
                    <option value="50% Advance">50% Advance</option>
                    <option value="Immediate / Cash">Immediate / Cash</option>
                    <option value="Consignment">Consignment</option>
                  </select>
                </div>

                <div>
                  <label className="input-label">Lead Time (Days)</label>
                  <input
                    type="number"
                    min="1"
                    className="input-field"
                    value={editingVendor.leadTimeDays || 10}
                    onChange={(e) => setEditingVendor({ ...editingVendor, leadTimeDays: parseInt(e.target.value) || 10 })}
                  />
                </div>

                <div>
                  <label className="input-label">GSTIN / Tax ID</label>
                  <input
                    type="text"
                    className="input-field"
                    value={editingVendor.gstin || ''}
                    onChange={(e) => setEditingVendor({ ...editingVendor, gstin: e.target.value.toUpperCase() })}
                    placeholder="08AAACA..."
                  />
                </div>
              </div>

              <div>
                <label className="input-label">Internal Notes / Artisan Profile</label>
                <textarea
                  className="input-field"
                  rows={2}
                  value={editingVendor.notes || ''}
                  onChange={(e) => setEditingVendor({ ...editingVendor, notes: e.target.value })}
                  placeholder="Special instructions, hallmark stamps, billing details..."
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '10px', borderTop: '1px solid var(--border-subtle)' }}>
                <button type="button" className="btn-secondary" onClick={() => setIsFormOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Save Artisan
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
