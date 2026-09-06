import type { CodeTables, JewelryItem } from '../types/inventory';

export const DEFAULT_CODE_TABLES: CodeTables = {
  types: [
    { code: 'PD', label: 'Pendant Set', description: 'Pendant with matching earrings' },
    { code: 'NLS', label: 'Necklace Set', description: 'Full necklace with earrings & maangtikka' },
    { code: 'EAR', label: 'Earrings / Jhumkas', description: 'Drop earrings, studs, chandbalis, jhumkas' },
    { code: 'CHK', label: 'Choker Set', description: 'Collar / high-neck choker with studs' },
    { code: 'BNG', label: 'Bangles / Kadas', description: 'Openable kadas, traditional bangle sets' },
    { code: 'BRC', label: 'Bracelet', description: 'Tennis bracelets, charm cuffs' },
    { code: 'RNG', label: 'Finger Ring', description: 'Adjustable statement & solitaire rings' },
    { code: 'MNG', label: 'Mangalsutra', description: 'Contemporary & traditional black bead chains' },
    { code: 'OTH', label: 'Other Accessories', description: 'Brooches, hair ornaments, nose rings' },
  ],
  stones: [
    { code: 'D', label: 'American Diamond (CZ)', description: 'High-clarity cubic zirconia simulants' },
    { code: 'K', label: 'Kundan', description: 'Traditional foil-backed glass stones' },
    { code: 'PK', label: 'Polki', description: 'Uncut diamond look in jadau setting' },
    { code: 'P', label: 'Cultured Pearl / Moti', description: 'Freshwater imitation pearl drops' },
    { code: 'J', label: 'Jade / Semi-precious Bead', description: 'Carved jadeite & dyed quartz drops' },
    { code: 'E', label: 'Emerald Simulant', description: 'Deep forest green hydro stones' },
    { code: 'R', label: 'Ruby Simulant', description: 'Pigeon blood synthetic corundum' },
    { code: 'TX', label: 'Meenakari / Temple', description: 'Enamel painted & carved antique work' },
    { code: 'NO', label: 'Plain Metal / No Stone', description: 'Pure metal finish with no encrusting' },
  ],
  colors: [
    { code: '01', label: 'Antique Gold Tone', description: 'Warm matte 22K finish brass' },
    { code: '02', label: 'Silver / Rhodium Tone', description: 'Bright white rhodium plating' },
    { code: '03', label: 'Rose Gold Tone', description: 'Modern pink copper hue' },
    { code: '12', label: 'Emerald Green', description: 'Rich deep royal green' },
    { code: '15', label: 'Ruby Maroon', description: 'Traditional wedding deep red' },
    { code: '20', label: 'Mint / Sage Green', description: 'Pastel bridal tone' },
    { code: '30', label: 'Royal Blue / Sapphire', description: 'Navy and cobolt faceted highlights' },
    { code: '40', label: 'Baby Pink / Rose Quartz', description: 'Soft powder pink highlights' },
    { code: '99', label: 'Multicolour / Navratna', description: 'Multi-stone composite palette' },
  ],
};

export const INITIAL_INVENTORY: JewelryItem[] = [];
