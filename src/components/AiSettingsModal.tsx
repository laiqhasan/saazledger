import React, { useState } from 'react';
import {
  getStoredAiConfig,
  saveStoredAiConfig,
  testAiConnection,
} from '../services/aiVisionService';
import type { AiConfig } from '../services/aiVisionService';
import {
  X,
  Sparkles,
  Key,
  Check,
  AlertCircle,
  ExternalLink,
  Bot,
  Zap,
} from 'lucide-react';

interface AiSettingsModalProps {
  onClose: () => void;
  onSaved?: () => void;
}

export const AiSettingsModal: React.FC<AiSettingsModalProps> = ({ onClose, onSaved }) => {
  const [config, setConfig] = useState<AiConfig>(getStoredAiConfig());
  const [isTestingGemini, setIsTestingGemini] = useState(false);
  const [isTestingOpenAI, setIsTestingOpenAI] = useState(false);
  const [geminiResult, setGeminiResult] = useState<{ success: boolean; message: string } | null>(null);
  const [openAiResult, setOpenAiResult] = useState<{ success: boolean; message: string } | null>(null);
  const [savedSuccess, setSavedSuccess] = useState(false);

  const handleTestGemini = async () => {
    setIsTestingGemini(true);
    setGeminiResult(null);
    const res = await testAiConnection('gemini', config.geminiApiKey, config.geminiModel);
    setGeminiResult(res);
    setIsTestingGemini(false);
  };

  const handleTestOpenAI = async () => {
    setIsTestingOpenAI(true);
    setOpenAiResult(null);
    const res = await testAiConnection('openai', config.openaiApiKey, config.openaiModel);
    setOpenAiResult(res);
    setIsTestingOpenAI(false);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    saveStoredAiConfig(config);
    setSavedSuccess(true);
    if (onSaved) onSaved();
    setTimeout(() => {
      setSavedSuccess(false);
      onClose();
    }, 1200);
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '640px' }}>
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
                borderRadius: '10px',
                background: 'linear-gradient(135deg, rgba(212, 175, 55, 0.25) 0%, rgba(59, 130, 246, 0.15) 100%)',
                border: '1px solid rgba(212, 175, 55, 0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Sparkles size={20} color="#fae084" />
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
                Dual AI Engine Configuration
              </h2>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '2px 0 0 0' }}>
                Default: <strong>Gemini AI</strong> on upload &bull; Re-analyze: <strong>ChatGPT (OpenAI)</strong>
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

        <form onSubmit={handleSave} style={{ padding: '24px' }}>
          {/* Section 1: Google Gemini (Initial Analysis) */}
          <div
            style={{
              padding: '16px',
              borderRadius: '12px',
              background: 'rgba(212, 175, 55, 0.05)',
              border: '1px solid rgba(212, 175, 55, 0.25)',
              marginBottom: '18px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Zap size={16} color="#fae084" />
                <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#fae084' }}>
                  1. Google Gemini API Key
                </span>
                <span
                  style={{
                    fontSize: '0.68rem',
                    background: 'rgba(16, 185, 129, 0.2)',
                    color: '#34d399',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    fontWeight: 600,
                  }}
                >
                  DEFAULT (First Upload)
                </span>
              </div>

              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: '0.74rem',
                  color: '#fae084',
                  textDecoration: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <span>Get Free Key</span>
                <ExternalLink size={12} />
              </a>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <Key
                  size={15}
                  color="var(--text-dim)"
                  style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }}
                />
                <input
                  type="password"
                  className="input-field"
                  placeholder="AIzaSy... (Gemini 2.5 Flash)"
                  value={config.geminiApiKey}
                  onChange={(e) => setConfig({ ...config, geminiApiKey: e.target.value })}
                  style={{ paddingLeft: '34px', fontSize: '0.85rem', fontFamily: 'var(--font-mono)' }}
                />
              </div>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleTestGemini}
                disabled={isTestingGemini || !config.geminiApiKey.trim()}
                style={{ padding: '8px 12px', fontSize: '0.78rem', whiteSpace: 'nowrap' }}
              >
                {isTestingGemini ? 'Testing...' : 'Test Gemini'}
              </button>
            </div>

            {geminiResult && (
              <div
                style={{
                  marginTop: '8px',
                  fontSize: '0.78rem',
                  color: geminiResult.success ? '#34d399' : '#f87171',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                {geminiResult.success ? <Check size={14} /> : <AlertCircle size={14} />}
                <span>{geminiResult.message}</span>
              </div>
            )}
          </div>

          {/* Section 2: OpenAI / ChatGPT (Re-analysis & Second Opinion) */}
          <div
            style={{
              padding: '16px',
              borderRadius: '12px',
              background: 'rgba(59, 130, 246, 0.05)',
              border: '1px solid rgba(59, 130, 246, 0.25)',
              marginBottom: '20px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Bot size={16} color="#60a5fa" />
                <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#93c5fd' }}>
                  2. OpenAI (ChatGPT) API Key
                </span>
                <span
                  style={{
                    fontSize: '0.68rem',
                    background: 'rgba(59, 130, 246, 0.2)',
                    color: '#93c5fd',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    fontWeight: 600,
                  }}
                >
                  RE-ANALYZE / SECOND OPINION
                </span>
              </div>

              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: '0.74rem',
                  color: '#60a5fa',
                  textDecoration: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                <span>Get OpenAI Key</span>
                <ExternalLink size={12} />
              </a>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <Key
                  size={15}
                  color="var(--text-dim)"
                  style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }}
                />
                <input
                  type="password"
                  className="input-field"
                  placeholder="sk-... (GPT-4o / GPT-4o-mini)"
                  value={config.openaiApiKey}
                  onChange={(e) => setConfig({ ...config, openaiApiKey: e.target.value })}
                  style={{ paddingLeft: '34px', fontSize: '0.85rem', fontFamily: 'var(--font-mono)' }}
                />
              </div>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleTestOpenAI}
                disabled={isTestingOpenAI || !config.openaiApiKey.trim()}
                style={{ padding: '8px 12px', fontSize: '0.78rem', whiteSpace: 'nowrap' }}
              >
                {isTestingOpenAI ? 'Testing...' : 'Test ChatGPT'}
              </button>
            </div>

            {openAiResult && (
              <div
                style={{
                  marginTop: '8px',
                  fontSize: '0.78rem',
                  color: openAiResult.success ? '#34d399' : '#f87171',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                {openAiResult.success ? <Check size={14} /> : <AlertCircle size={14} />}
                <span>{openAiResult.message}</span>
              </div>
            )}
          </div>

          {savedSuccess && (
            <div
              style={{
                marginBottom: '16px',
                padding: '10px 14px',
                borderRadius: '8px',
                background: 'rgba(16, 185, 129, 0.15)',
                border: '1px solid rgba(16, 185, 129, 0.4)',
                color: '#34d399',
                fontSize: '0.84rem',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <Check size={16} />
              <span>AI keys saved! Gemini on upload &bull; ChatGPT on re-analyze.</span>
            </div>
          )}

          {/* Footer Actions */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: '12px',
              paddingTop: '16px',
              borderTop: '1px solid var(--border-subtle)',
            }}
          >
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary">
              Save AI Settings
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
