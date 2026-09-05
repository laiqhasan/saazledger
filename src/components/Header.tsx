import React, { useState, useEffect, useRef } from 'react';
import {
  Gem,
  Plus,
  Sliders,
  Download,
  Sparkles,
  BookOpen,
  Printer,
  Store,
  Layers,
  Users,
  Cloud,
  AlertTriangle,
  Key,
  ChevronDown,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface HeaderProps {
  onOpenAddItem: () => void;
  onOpenCodeRef: () => void;
  onOpenExport: () => void;
  onOpenAiSettings: () => void;
  onOpenSalesLedger: () => void;
  onOpenPrintTags: () => void;
  onOpenShopify: () => void;
  onOpenMarketplaces: () => void;
  onOpenVendors: () => void;
  onOpenMediaLibrary: () => void;
  onOpenNeedsAttention?: () => void;
  onOpenGlobalSkuInit?: () => void;
  onOpenAuth?: () => void;
  isShopifyConnected?: boolean;
  totalItemsCount: number;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenAddItem,
  onOpenCodeRef,
  onOpenExport,
  onOpenAiSettings,
  onOpenSalesLedger,
  onOpenPrintTags,
  onOpenShopify,
  onOpenMarketplaces,
  onOpenVendors,
  onOpenMediaLibrary,
  onOpenNeedsAttention,
  onOpenGlobalSkuInit,
  onOpenAuth,
  isShopifyConnected = false,
  totalItemsCount,
}) => {
  const { user, isAuthenticated } = useAuth();
  const [activeDropdown, setActiveDropdown] = useState<'channels' | 'operations' | 'master' | null>(null);
  const navRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(event.target as Node)) {
        setActiveDropdown(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleDropdown = (menu: 'channels' | 'operations' | 'master') => {
    setActiveDropdown((prev) => (prev === menu ? null : menu));
  };

  const handleMenuClick = (action: () => void) => {
    action();
    setActiveDropdown(null);
  };

  return (
    <header
      style={{
        borderBottom: '1px solid var(--border-subtle)',
        background: 'rgba(10, 11, 14, 0.92)',
        backdropFilter: 'blur(20px)',
        position: 'sticky',
        top: 0,
        zIndex: 50,
      }}
    >
      <div
        style={{
          maxWidth: '1440px',
          margin: '0 auto',
          padding: '12px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
        }}
      >
        {/* Brand & Identity */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexShrink: 0 }}>
          <div
            style={{
              width: '42px',
              height: '42px',
              borderRadius: '10px',
              background: 'linear-gradient(135deg, #262112 0%, #12141a 100%)',
              border: '1px solid #d4af37',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 16px rgba(212, 175, 55, 0.2)',
            }}
          >
            <Gem size={22} color="#fae084" />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h1
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: '1.35rem',
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  background: 'linear-gradient(135deg, #ffffff 0%, #fae084 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  margin: 0,
                }}
              >
                SAAZ LEDGER
              </h1>
              <span
                style={{
                  fontSize: '0.65rem',
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                  background: 'rgba(212, 175, 55, 0.15)',
                  color: '#fae084',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  border: '1px solid rgba(212, 175, 55, 0.3)',
                }}
              >
                ATELIER OS
              </span>
            </div>
            <p
              style={{
                fontSize: '0.78rem',
                color: 'var(--text-muted)',
                margin: 0,
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span>Fine Jewelry SKU & Profit Suite</span>
              <span style={{ color: 'rgba(255,255,255,0.2)' }}>•</span>
              <span style={{ color: '#d4af37', fontWeight: 600 }}>{totalItemsCount} Active SKUs</span>
            </p>
          </div>
        </div>

        {/* Grouped Dropdown Navigation Menus */}
        <div
          ref={navRef}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            position: 'relative',
          }}
        >
          {/* Menu 1: Channels */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => toggleDropdown('channels')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '7px',
                padding: '8px 14px',
                borderRadius: '8px',
                background: activeDropdown === 'channels' ? 'rgba(212, 175, 55, 0.15)' : 'rgba(255, 255, 255, 0.04)',
                border: activeDropdown === 'channels' ? '1px solid #d4af37' : '1px solid var(--border-subtle)',
                color: activeDropdown === 'channels' ? '#fae084' : 'var(--text-main)',
                fontSize: '0.86rem',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              <Store size={16} color={isShopifyConnected ? '#10b981' : '#d4af37'} />
              <span>Channels</span>
              {isShopifyConnected && (
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: '#34d399',
                    boxShadow: '0 0 6px #34d399',
                  }}
                  title="Shopify Connected"
                />
              )}
              <ChevronDown
                size={14}
                style={{
                  transform: activeDropdown === 'channels' ? 'rotate(180deg)' : 'rotate(0)',
                  transition: 'transform 0.2s ease',
                  opacity: 0.7,
                }}
              />
            </button>

            {activeDropdown === 'channels' && (
              <div
                className="animate-fade-in"
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 8px)',
                  left: 0,
                  width: '270px',
                  background: 'rgba(18, 21, 30, 0.98)',
                  backdropFilter: 'blur(20px)',
                  border: '1px solid rgba(212, 175, 55, 0.35)',
                  borderRadius: '12px',
                  padding: '8px',
                  boxShadow: '0 12px 36px rgba(0,0,0,0.7), 0 0 20px rgba(212,175,55,0.1)',
                  zIndex: 100,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                }}
              >
                <div style={{ padding: '6px 10px', fontSize: '0.72rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Sales & Stock Channels
                </div>
                <button
                  type="button"
                  onClick={() => handleMenuClick(onOpenShopify)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    background: 'transparent',
                    border: 'none',
                    color: '#fff',
                    textAlign: 'left',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(212, 175, 55, 0.1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ padding: '6px', borderRadius: '6px', background: 'rgba(16, 185, 129, 0.15)' }}>
                    <Store size={18} color="#34d399" />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.88rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span>Shopify Sync</span>
                      <span style={{ fontSize: '0.7rem', color: isShopifyConnected ? '#34d399' : '#f59e0b' }}>
                        {isShopifyConnected ? '● Online' : '○ Setup'}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Store connection & auto sync</div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => handleMenuClick(onOpenMarketplaces)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    background: 'transparent',
                    border: 'none',
                    color: '#fff',
                    textAlign: 'left',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(212, 175, 55, 0.1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ padding: '6px', borderRadius: '6px', background: 'rgba(251, 191, 36, 0.15)' }}>
                    <Layers size={18} color="#fbbf24" />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>Marketplace Hub</div>
                    <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Amazon, Myntra & buffer stock</div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => handleMenuClick(onOpenMediaLibrary)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    background: 'transparent',
                    border: 'none',
                    color: '#fff',
                    textAlign: 'left',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(212, 175, 55, 0.1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ padding: '6px', borderRadius: '6px', background: 'rgba(192, 132, 252, 0.15)' }}>
                    <Cloud size={18} color="#c084fc" />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>Cloud Media Vault</div>
                    <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Amazon S3 & Google Drive</div>
                  </div>
                </button>
              </div>
            )}
          </div>

          {/* Menu 2: Operations */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => toggleDropdown('operations')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '7px',
                padding: '8px 14px',
                borderRadius: '8px',
                background: activeDropdown === 'operations' ? 'rgba(212, 175, 55, 0.15)' : 'rgba(255, 255, 255, 0.04)',
                border: activeDropdown === 'operations' ? '1px solid #d4af37' : '1px solid var(--border-subtle)',
                color: activeDropdown === 'operations' ? '#fae084' : 'var(--text-main)',
                fontSize: '0.86rem',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              <BookOpen size={16} color="#34d399" />
              <span>Operations</span>
              <ChevronDown
                size={14}
                style={{
                  transform: activeDropdown === 'operations' ? 'rotate(180deg)' : 'rotate(0)',
                  transition: 'transform 0.2s ease',
                  opacity: 0.7,
                }}
              />
            </button>

            {activeDropdown === 'operations' && (
              <div
                className="animate-fade-in"
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 8px)',
                  left: 0,
                  width: '270px',
                  background: 'rgba(18, 21, 30, 0.98)',
                  backdropFilter: 'blur(20px)',
                  border: '1px solid rgba(212, 175, 55, 0.35)',
                  borderRadius: '12px',
                  padding: '8px',
                  boxShadow: '0 12px 36px rgba(0,0,0,0.7), 0 0 20px rgba(212,175,55,0.1)',
                  zIndex: 100,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                }}
              >
                <div style={{ padding: '6px 10px', fontSize: '0.72rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Floor & Ledger Operations
                </div>
                <button
                  type="button"
                  onClick={() => handleMenuClick(onOpenSalesLedger)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    background: 'transparent',
                    border: 'none',
                    color: '#fff',
                    textAlign: 'left',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(212, 175, 55, 0.1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ padding: '6px', borderRadius: '6px', background: 'rgba(52, 211, 153, 0.15)' }}>
                    <BookOpen size={18} color="#34d399" />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>Sales Ledger</div>
                    <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Transactions & realized margins</div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => handleMenuClick(onOpenPrintTags)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    background: 'transparent',
                    border: 'none',
                    color: '#fff',
                    textAlign: 'left',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(212, 175, 55, 0.1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ padding: '6px', borderRadius: '6px', background: 'rgba(250, 224, 132, 0.15)' }}>
                    <Printer size={18} color="#fae084" />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>Tag Studio</div>
                    <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Print jewelry hangtags & barcodes</div>
                  </div>
                </button>

                {onOpenNeedsAttention && (
                  <button
                    type="button"
                    onClick={() => handleMenuClick(onOpenNeedsAttention)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      background: 'transparent',
                      border: 'none',
                      color: '#fff',
                      textAlign: 'left',
                      cursor: 'pointer',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(212, 175, 55, 0.1)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div style={{ padding: '6px', borderRadius: '6px', background: 'rgba(245, 158, 11, 0.15)' }}>
                      <AlertTriangle size={18} color="#f59e0b" />
                    </div>
                    <div>
                      <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>Exceptions Desk</div>
                      <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Reconcile stock anomalies</div>
                    </div>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Menu 3: Master Data & Settings */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => toggleDropdown('master')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '7px',
                padding: '8px 14px',
                borderRadius: '8px',
                background: activeDropdown === 'master' ? 'rgba(212, 175, 55, 0.15)' : 'rgba(255, 255, 255, 0.04)',
                border: activeDropdown === 'master' ? '1px solid #d4af37' : '1px solid var(--border-subtle)',
                color: activeDropdown === 'master' ? '#fae084' : 'var(--text-main)',
                fontSize: '0.86rem',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              <Sliders size={16} color="#38bdf8" />
              <span>Master Data</span>
              <ChevronDown
                size={14}
                style={{
                  transform: activeDropdown === 'master' ? 'rotate(180deg)' : 'rotate(0)',
                  transition: 'transform 0.2s ease',
                  opacity: 0.7,
                }}
              />
            </button>

            {activeDropdown === 'master' && (
              <div
                className="animate-fade-in"
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 8px)',
                  left: 0,
                  width: '280px',
                  background: 'rgba(18, 21, 30, 0.98)',
                  backdropFilter: 'blur(20px)',
                  border: '1px solid rgba(212, 175, 55, 0.35)',
                  borderRadius: '12px',
                  padding: '8px',
                  boxShadow: '0 12px 36px rgba(0,0,0,0.7), 0 0 20px rgba(212,175,55,0.1)',
                  zIndex: 100,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                }}
              >
                <div style={{ padding: '6px 10px', fontSize: '0.72rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Configuration & Masters
                </div>
                <button
                  type="button"
                  onClick={() => handleMenuClick(onOpenVendors)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    background: 'transparent',
                    border: 'none',
                    color: '#fff',
                    textAlign: 'left',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(212, 175, 55, 0.1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ padding: '6px', borderRadius: '6px', background: 'rgba(56, 189, 248, 0.15)' }}>
                    <Users size={18} color="#38bdf8" />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>Artisans & Vendors</div>
                    <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Vendor master & reorder POs</div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => handleMenuClick(onOpenCodeRef)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    background: 'transparent',
                    border: 'none',
                    color: '#fff',
                    textAlign: 'left',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(212, 175, 55, 0.1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ padding: '6px', borderRadius: '6px', background: 'rgba(212, 175, 55, 0.15)' }}>
                    <Sliders size={18} color="#d4af37" />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>Code Reference</div>
                    <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Type, stone & color taxonomy</div>
                  </div>
                </button>

                {onOpenGlobalSkuInit && (
                  <button
                    type="button"
                    onClick={() => handleMenuClick(onOpenGlobalSkuInit)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      background: 'transparent',
                      border: 'none',
                      color: '#fff',
                      textAlign: 'left',
                      cursor: 'pointer',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(212, 175, 55, 0.1)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div style={{ padding: '6px', borderRadius: '6px', background: 'rgba(250, 224, 132, 0.15)' }}>
                      <Key size={18} color="#fae084" />
                    </div>
                    <div>
                      <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>Global SKU Sequence</div>
                      <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Atomic SKU sequence calibration</div>
                    </div>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => handleMenuClick(onOpenExport)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    background: 'transparent',
                    border: 'none',
                    color: '#fff',
                    textAlign: 'left',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(212, 175, 55, 0.1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ padding: '6px', borderRadius: '6px', background: 'rgba(255, 255, 255, 0.08)' }}>
                    <Download size={18} color="#f3f4f6" />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>Data Hub</div>
                    <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>CSV ingest, backup & export</div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => handleMenuClick(onOpenAiSettings)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    background: 'transparent',
                    border: 'none',
                    color: '#fff',
                    textAlign: 'left',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(212, 175, 55, 0.1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ padding: '6px', borderRadius: '6px', background: 'rgba(250, 224, 132, 0.15)' }}>
                    <Sparkles size={18} color="#fae084" />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>AI Vision Settings</div>
                    <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>Gemini & OpenAI API keys</div>
                  </div>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right CTA Actions: New Piece + Account Profile */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
          {/* Primary CTA */}
          <button
            type="button"
            className="btn-primary"
            onClick={onOpenAddItem}
            title="Add a new jewelry piece and generate next free SKU"
            style={{
              padding: '9px 18px',
              fontSize: '0.88rem',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              whiteSpace: 'nowrap',
            }}
          >
            <Plus size={18} />
            <span>New Piece</span>
          </button>

          {/* User Profile / Account Badge */}
          {onOpenAuth && (
            <button
              type="button"
              onClick={onOpenAuth}
              title={isAuthenticated ? `Logged in as ${user?.fullName} (${user?.role})` : 'Sign in with Google'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 12px',
                borderRadius: '8px',
                background: isAuthenticated ? 'rgba(212, 175, 55, 0.1)' : 'rgba(255, 255, 255, 0.05)',
                border: isAuthenticated ? '1px solid rgba(212, 175, 55, 0.35)' : '1px solid rgba(255, 255, 255, 0.1)',
                color: '#f3f4f6',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                whiteSpace: 'nowrap',
              }}
            >
              {isAuthenticated && user?.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user.fullName}
                  style={{ width: '24px', height: '24px', borderRadius: '50%', objectFit: 'cover', border: '1px solid #fae084' }}
                />
              ) : isAuthenticated && user ? (
                <div
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '50%',
                    background: '#fae084',
                    color: '#0d1117',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.75rem',
                    fontWeight: 'bold',
                  }}
                >
                  {user.fullName[0]?.toUpperCase() || 'U'}
                </div>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24">
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                  />
                </svg>
              )}
              <span style={{ fontSize: '0.82rem', fontWeight: 600 }}>
                {isAuthenticated && user ? user.fullName.split(' ')[0] : 'Sign In'}
              </span>
              {isAuthenticated && user && (
                <span
                  style={{
                    fontSize: '0.65rem',
                    textTransform: 'uppercase',
                    padding: '1px 5px',
                    borderRadius: '4px',
                    background: user.role === 'admin' ? 'rgba(212, 175, 55, 0.2)' : 'rgba(56, 189, 248, 0.2)',
                    color: user.role === 'admin' ? '#fae084' : '#38bdf8',
                  }}
                >
                  {user.role}
                </span>
              )}
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
