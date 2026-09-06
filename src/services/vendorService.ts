import type { VendorItem, VendorPerformanceMetrics, JewelryItem, StockMovement } from '../types/inventory';

const VENDORS_STORAGE_KEY = 'saaz_ledger_vendors_v1';

export const DEFAULT_VENDORS: VendorItem[] = [
  {
    id: 'vendor-acj',
    code: 'ACJ',
    name: 'Aura Creations Jaipur',
    contactPerson: 'Vikram Sharma',
    phone: '+91 98290 41234',
    email: 'aura.creations@jaipurjewels.com',
    city: 'Jaipur',
    address: '142 Johari Bazaar, Pink City, Jaipur, Rajasthan 302003',
    gstin: '08AAACA9812A1Z5',
    specialty: 'Kundan & Jadau, Floral Meenakari, Drop Jade Beads',
    leadTimeDays: 10,
    paymentTerms: 'Net 15',
    rating: 5,
    status: 'active',
    notes: 'Primary artisan for traditional choker and pendant sets. High finish quality.',
    createdAt: '2026-08-01',
  },
  {
    id: 'vendor-rzc',
    code: 'RZC',
    name: 'Royal Zari Crafts',
    contactPerson: 'Suresh Zaveri',
    phone: '+91 98201 88392',
    email: 'orders@royalzaricrafts.in',
    city: 'Mumbai',
    address: '44 Sheikh Memon Street, Zaveri Bazaar, Mumbai 400002',
    gstin: '27AABCR4412B1Z2',
    specialty: 'Antique Bridal Sets, Temple Jewelry & Maangtikkas',
    leadTimeDays: 14,
    paymentTerms: '50% Advance / 50% on Delivery',
    rating: 5,
    status: 'active',
    notes: 'Exquisite antique gold matte finish and heavy wedding collections.',
    createdAt: '2026-08-05',
  },
  {
    id: 'vendor-ssi',
    code: 'SSI',
    name: 'ShineStar Imports',
    contactPerson: 'Pooja Patel',
    phone: '+91 97277 55432',
    email: 'pooja@shinestarimports.com',
    city: 'Surat',
    address: 'B-201 Diamond World, Mini Bazaar, Varachha, Surat 395006',
    gstin: '24AAECS1109K1ZP',
    specialty: 'American Diamond (CZ) Simulants, Silver Plating',
    leadTimeDays: 5,
    paymentTerms: 'Immediate / Cash',
    rating: 4,
    status: 'active',
    notes: 'Fast turnaround for modern solitaire rings and tennis bracelets.',
    createdAt: '2026-08-10',
  },
  {
    id: 'vendor-jgc',
    code: 'JGC',
    name: 'Jaipur Gemstone Cutters',
    contactPerson: 'Mahesh Agarwal',
    phone: '+91 94140 22910',
    email: 'sales@jaipurgemstones.in',
    city: 'Jaipur',
    address: 'Ghat Gate, Jaipur, Rajasthan 302003',
    gstin: '08BBXPA3041J1Z8',
    specialty: 'Hydro Jade Beads, Carved Emerald Drops & Freshwater Pearls',
    leadTimeDays: 7,
    paymentTerms: 'Net 30',
    rating: 4,
    status: 'active',
    notes: 'Raw stone and bead supplier for custom in-house assembly.',
    createdAt: '2026-08-12',
  },
];

export function getStoredVendors(): VendorItem[] {
  try {
    const raw = localStorage.getItem(VENDORS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (err) {
    console.error('Failed reading vendors from storage:', err);
  }
  return DEFAULT_VENDORS;
}

export function saveStoredVendors(vendors: VendorItem[]): void {
  try {
    localStorage.setItem(VENDORS_STORAGE_KEY, JSON.stringify(vendors));
  } catch (err) {
    console.error('Failed saving vendors to storage:', err);
  }
}

/**
 * Checks if a given item belongs to a vendor by comparing vendor name or vendor code
 */
export function isItemFromVendor(item: JewelryItem, vendor: VendorItem): boolean {
  if (!item.vendor) return false;
  const itemVendor = item.vendor.trim().toLowerCase();
  const vName = vendor.name.trim().toLowerCase();
  const vCode = vendor.code.trim().toLowerCase();

  return (
    itemVendor === vName ||
    itemVendor === vCode ||
    itemVendor.includes(vName) ||
    vName.includes(itemVendor)
  );
}

/**
 * Calculates financial, stock, and sales metrics for a specific vendor
 */
export function calculateVendorMetrics(
  vendor: VendorItem,
  inventory: JewelryItem[],
  transactions: StockMovement[] = []
): VendorPerformanceMetrics {
  const vendorItems = inventory.filter((item) => isItemFromVendor(item, vendor));

  let inStockUnits = 0;
  let costValuation = 0;
  let retailValuation = 0;
  let lowStockItemCount = 0;

  for (const item of vendorItems) {
    const qty = item.quantity || 0;
    inStockUnits += qty;
    costValuation += (item.buyingPrice || 0) * qty;
    retailValuation += (item.sellingPrice || 0) * qty;

    if (qty <= (item.reorderLevel || 0)) {
      lowStockItemCount++;
    }
  }

  // Calculate realized sales and profit from sales ledger
  const vendorItemIds = new Set(vendorItems.map((i) => i.id));
  const vendorSkus = new Set(vendorItems.map((i) => i.sku.toUpperCase()));

  let realizedSalesUnits = 0;
  let realizedSalesRevenue = 0;
  let realizedGrossProfit = 0;

  for (const tx of transactions) {
    if (tx.type === 'sale') {
      const isMatch =
        (tx.itemId && vendorItemIds.has(tx.itemId)) ||
        (tx.sku && vendorSkus.has(tx.sku.toUpperCase())) ||
        (tx.notes && tx.notes.toLowerCase().includes(vendor.name.toLowerCase()));

      if (isMatch) {
        const soldUnits = Math.abs(tx.quantityDelta || 0);
        realizedSalesUnits += soldUnits;
        realizedSalesRevenue += tx.totalPrice || 0;
        realizedGrossProfit += tx.realizedProfit || 0;
      }
    }
  }

  const averageMarginPercent =
    retailValuation > 0
      ? Math.round(((retailValuation - costValuation) / retailValuation) * 100)
      : 0;

  return {
    vendorId: vendor.id,
    totalPiecesSupplied: vendorItems.length,
    inStockUnits,
    costValuation,
    retailValuation,
    realizedSalesUnits,
    realizedSalesRevenue,
    realizedGrossProfit,
    lowStockItemCount,
    averageMarginPercent,
  };
}

/**
 * Generates a procurement Restock Purchase Order sheet CSV for sending to an artisan
 */
export function generateVendorReorderSheetCsv(
  vendor: VendorItem,
  lowStockItems: JewelryItem[]
): string {
  const headers = [
    'PO Number',
    'Artisan / Vendor Code',
    'Artisan Name',
    'SKU',
    'Item Description',
    'Current Stock',
    'Reorder Threshold',
    'Recommended Order Qty',
    'Unit Cost (INR)',
    'Est. Total Cost (INR)',
    'Lead Time (Days)',
  ];

  const poNumber = `PO-${vendor.code}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

  const rows = lowStockItems.map((item) => {
    const currentStock = item.quantity || 0;
    const reorderLevel = item.reorderLevel || 3;
    // Suggested restock brings stock back up to 3x reorder level or minimum 10
    const suggestedQty = Math.max(10, reorderLevel * 3 - currentStock);
    const unitCost = item.buyingPrice || 0;
    const estTotalCost = unitCost * suggestedQty;

    return [
      poNumber,
      vendor.code,
      `"${vendor.name.replace(/"/g, '""')}"`,
      item.sku,
      `"${item.title.replace(/"/g, '""')}"`,
      currentStock,
      reorderLevel,
      suggestedQty,
      unitCost,
      estTotalCost,
      vendor.leadTimeDays || 10,
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Generates CSV export for all vendors in Master Data
 */
export function generateVendorsExportCsv(vendors: VendorItem[]): string {
  const headers = [
    'Vendor ID',
    'Vendor Code',
    'Vendor Name',
    'Contact Person',
    'Phone',
    'Email',
    'City',
    'Address',
    'GSTIN',
    'Specialty',
    'Lead Time (Days)',
    'Payment Terms',
    'Rating',
    'Status',
    'Notes',
    'Created At',
  ];

  const rows = vendors.map((v) => [
    v.id,
    v.code,
    `"${(v.name || '').replace(/"/g, '""')}"`,
    `"${(v.contactPerson || '').replace(/"/g, '""')}"`,
    `"${(v.phone || '').replace(/"/g, '""')}"`,
    `"${(v.email || '').replace(/"/g, '""')}"`,
    `"${(v.city || '').replace(/"/g, '""')}"`,
    `"${(v.address || '').replace(/"/g, '""')}"`,
    `"${(v.gstin || '').replace(/"/g, '""')}"`,
    `"${(v.specialty || '').replace(/"/g, '""')}"`,
    v.leadTimeDays || '',
    `"${(v.paymentTerms || '').replace(/"/g, '""')}"`,
    v.rating || '',
    v.status,
    `"${(v.notes || '').replace(/"/g, '""')}"`,
    v.createdAt,
  ].join(','));

  return [headers.join(','), ...rows].join('\n');
}

/**
 * Parses uploaded CSV to VendorItem list
 */
export function parseVendorsCsv(csvText: string): VendorItem[] {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  // Parse header
  const headerLine = lines[0].toLowerCase();
  const headers = headerLine.split(',').map((h) => h.trim().replace(/^"|"$/g, ''));

  const codeIdx = headers.findIndex((h) => h.includes('code'));
  const nameIdx = headers.findIndex((h) => h.includes('name'));
  const contactIdx = headers.findIndex((h) => h.includes('contact') || h.includes('person'));
  const phoneIdx = headers.findIndex((h) => h.includes('phone') || h.includes('mobile'));
  const emailIdx = headers.findIndex((h) => h.includes('email'));
  const cityIdx = headers.findIndex((h) => h.includes('city'));
  const addressIdx = headers.findIndex((h) => h.includes('address'));
  const gstinIdx = headers.findIndex((h) => h.includes('gst'));
  const specialtyIdx = headers.findIndex((h) => h.includes('specialty') || h.includes('category'));
  const termsIdx = headers.findIndex((h) => h.includes('term'));

  const parsedVendors: VendorItem[] = [];

  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i];
    // Basic CSV regex split honoring quotes
    const cells = rawLine.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || rawLine.split(',');
    const cleanCells = cells.map((c) => c.replace(/^"|"$/g, '').trim());

    const name = nameIdx >= 0 ? cleanCells[nameIdx] : cleanCells[1] || '';
    if (!name) continue;

    const code =
      codeIdx >= 0 && cleanCells[codeIdx]
        ? cleanCells[codeIdx].toUpperCase()
        : name.slice(0, 3).toUpperCase();

    parsedVendors.push({
      id: `vendor-${Date.now()}-${i}`,
      code,
      name,
      contactPerson: contactIdx >= 0 ? cleanCells[contactIdx] : undefined,
      phone: phoneIdx >= 0 ? cleanCells[phoneIdx] : undefined,
      email: emailIdx >= 0 ? cleanCells[emailIdx] : undefined,
      city: cityIdx >= 0 ? cleanCells[cityIdx] : 'Jaipur',
      address: addressIdx >= 0 ? cleanCells[addressIdx] : undefined,
      gstin: gstinIdx >= 0 ? cleanCells[gstinIdx] : undefined,
      specialty: specialtyIdx >= 0 ? cleanCells[specialtyIdx] : 'Fine Fashion Jewelry',
      leadTimeDays: 10,
      paymentTerms: termsIdx >= 0 ? cleanCells[termsIdx] : 'Net 15',
      rating: 5,
      status: 'active',
      createdAt: new Date().toISOString().split('T')[0],
    });
  }

  return parsedVendors;
}
