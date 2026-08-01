'use client';

import { useEffect, useRef, useState } from 'react';

interface Props {
  onDetected: (code: string) => void;
  onClose:    () => void;
  /** Header text — e.g. "Scan Barcode" (default) or "Scan product barcode". */
  title?: string;
  /**
   * Accept ANY symbology (Code-128/39, QR, alphanumeric).
   * Default false = numeric retail barcodes only (EAN-13/8, UPC-A/E),
   * which is what product lookup wants.
   */
  allowAnyFormat?: boolean;
}

/**
 * Modal barcode scanner — the SINGLE scanner for the whole app.
 *
 * The camera preview is always visible: html5-qrcode renders a live <video>
 * into #barcode-reader, with an aim box drawn over it. It works on every
 * browser (iOS Safari and Firefox included), unlike the native BarcodeDetector
 * API, which only exists in Chromium — InventoryView used to call that
 * directly and showed NO preview at all.
 *
 * Manual entry is always offered as a fallback.
 */
export default function BarcodeScanner({ onDetected, onClose, title = 'Scan Barcode', allowAnyFormat = false }: Props) {
  const [status,      setStatus]      = useState<'loading' | 'scanning' | 'error'>('loading');
  const [errorMsg,    setErrorMsg]    = useState('');
  const [manualCode,  setManualCode]  = useState('');
  const [lastScanned, setLastScanned] = useState('');
  const scannerRef = useRef<{ stop: () => Promise<void>; clear: () => void; isScanning: boolean } | null>(null);
  const detectedRef = useRef(false);

  useEffect(() => {
    let mounted = true;

    async function startScanner() {
      try {
        /*
         * iOS refuses the camera outright on an insecure origin, and the
         * failure surfaces as a generic getUserMedia rejection — which used to
         * be reported as "Camera not available", sending people to hunt for a
         * permission they had already granted. Check first and name the real
         * cause. `isSecureContext` is true for https:// and for localhost, so
         * desktop dev is unaffected; testing the phone against a LAN IP over
         * http:// is the case this catches.
         */
        if (typeof window !== 'undefined' && !window.isSecureContext) {
          if (mounted) {
            setStatus('error');
            setErrorMsg(
              'The camera only works over a secure (https) connection. '
              + 'Open the site with https, or type the barcode in below.',
            );
          }
          return;
        }
        if (!navigator.mediaDevices?.getUserMedia) {
          if (mounted) {
            setStatus('error');
            setErrorMsg('This browser cannot open the camera. Enter the barcode manually below.');
          }
          return;
        }

        const { Html5Qrcode } = await import('html5-qrcode');
        const scanner = new Html5Qrcode('barcode-reader');
        scannerRef.current = scanner;

        await scanner.start(
          { facingMode: 'environment' },
          {
            fps: 12,
            // Responsive aim box — keeps the live preview large on phones
            // instead of a fixed 260px window on a cropped video.
            qrbox: (viewW: number, viewH: number) => {
              const w = Math.max(140, Math.floor(Math.min(viewW, 380) * 0.82));
              const h = Math.max(90,  Math.floor(Math.min(viewH * 0.6, w * 0.55)));
              return { width: w, height: h };
            },
          },
          (decodedText: string) => {
            if (detectedRef.current || !mounted) return;
            const cleaned = decodedText.trim().replace(/\s/g, '');
            const ok = allowAnyFormat
              ? cleaned.length >= 4
              : /^\d{8,14}$/.test(cleaned);   // EAN-13/8, UPC-A/E
            if (ok) {
              detectedRef.current = true;
              setLastScanned(cleaned);
              scanner.stop().catch(() => {});
              onDetected(cleaned);
              onClose();
            }
          },
          () => {} // per-frame decode misses are normal, ignore them
        );

        if (mounted) setStatus('scanning');
      } catch (e) {
        if (mounted) {
          setStatus('error');
          const name = (e as { name?: string })?.name ?? '';
          setErrorMsg(
            name === 'NotAllowedError'
              ? 'Camera permission was denied. Allow camera access, or enter the barcode manually below.'
              : 'Camera not available. Please enter the barcode manually below.'
          );
        }
      }
    }

    startScanner();

    return () => {
      mounted = false;
      const s = scannerRef.current;
      if (s && s.isScanning) {
        s.stop().then(() => s.clear()).catch(() => {});
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleManual() {
    const raw = manualCode.trim();
    const code = allowAnyFormat ? raw : raw.replace(/\D/g, '');
    if (allowAnyFormat ? code.length < 4 : code.length < 8) return;
    onDetected(code);
    onClose();
  }

  const manualTooShort = allowAnyFormat
    ? manualCode.trim().length < 4
    : manualCode.replace(/\D/g, '').length < 8;

  return (
    <div className="modal-overlay barcode-modal-overlay" onClick={onClose}>
      <div className="modal-box barcode-modal-box" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '1.2rem' }}>📷</span>
            <span style={{ fontWeight: 700 }}>{title}</span>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {/* Live camera viewport — always on screen while scanning */}
          <div className="barcode-viewport">
            <div id="barcode-reader" />

            {status === 'loading' && (
              <div className="barcode-overlay">
                <div className="spinner" style={{ width: 28, height: 28 }} />
                <span style={{ fontSize: '.85rem', marginTop: 8 }}>Starting camera…</span>
              </div>
            )}

            {status === 'error' && (
              <div className="barcode-overlay">
                <span style={{ fontSize: '1.8rem' }}>📷</span>
                <span style={{ fontSize: '.82rem', textAlign: 'center', padding: '0 18px', opacity: .85 }}>
                  Camera unavailable
                </span>
              </div>
            )}

            {status === 'scanning' && <div className="barcode-scan-line" />}
          </div>

          {status === 'scanning' && (
            <p className="barcode-hint">
              📦 Point the camera at a barcode{allowAnyFormat ? '' : ' (EAN-13, UPC-A, EAN-8)'}
            </p>
          )}

          {status === 'error' && (
            <div className="auth-error" style={{ marginBottom: 12 }}>{errorMsg}</div>
          )}

          {lastScanned && (
            <div className="barcode-detected-row">
              ✅ Scanned: <strong>{lastScanned}</strong>
            </div>
          )}

          <div className="barcode-divider"><span>or enter manually</span></div>

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <input
              className="form-input"
              placeholder={allowAnyFormat ? 'Enter barcode…' : 'Enter barcode number…'}
              value={manualCode}
              onChange={e => setManualCode(allowAnyFormat ? e.target.value : e.target.value.replace(/\D/g, ''))}
              onKeyDown={e => e.key === 'Enter' && handleManual()}
              inputMode={allowAnyFormat ? 'text' : 'numeric'}
              maxLength={32}
              autoFocus={status === 'error'}
            />
            <button
              className="btn btn-primary"
              onClick={handleManual}
              disabled={manualTooShort}
              style={{ flexShrink: 0 }}
            >
              {allowAnyFormat ? 'Use' : 'Search'}
            </button>
          </div>

          <p style={{ fontSize: '.75rem', color: 'var(--text-muted)', marginTop: 10, textAlign: 'center' }}>
            Tip: Turn on your flashlight for better results in low light.
          </p>
        </div>
      </div>
    </div>
  );
}
