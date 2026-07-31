'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/**
 * A printable QR code for a store's public storefront.
 *
 * The point is the physical world: a shop tapes this to the counter, the door
 * or a delivery box, and a customer scans it to reach that shop's page. So the
 * printed sheet — not the on-screen preview — is the real output, and it is
 * laid out for A4/A5 with the code big enough to scan from arm's length.
 *
 * Rendered at 1024px and scaled down in CSS so the printed copy stays sharp;
 * a QR generated at display size prints soft and fails to scan.
 */
export default function StoreQrCode({
  storeName, storeUrl,
}: { storeName: string; storeUrl: string }) {
  const [dataUrl, setDataUrl] = useState('');
  const [error, setError]     = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    QRCode.toDataURL(storeUrl, {
      width: 1024,
      margin: 1,
      // Highest correction level: a counter sticker gets scuffed, taped over
      // and printed on cheap paper, and H survives ~30% of the code being
      // damaged before it stops scanning.
      errorCorrectionLevel: 'H',
      color: { dark: '#000000', light: '#FFFFFF' },
    })
      .then(u => { if (!cancelled) setDataUrl(u); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [storeUrl]);

  function handlePrint() {
    if (!dataUrl) return;
    const win = window.open('', '_blank', 'width=720,height=900');
    if (!win) return;
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"/>
      <title>${esc(storeName)} — QR</title>
      <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
             color:#000;background:#fff;display:flex;align-items:center;
             justify-content:center;min-height:100vh;padding:24px}
        .card{text-align:center;max-width:520px;width:100%}
        .kicker{font-size:14px;letter-spacing:.22em;text-transform:uppercase;font-weight:700;margin-bottom:10px}
        h1{font-size:34px;line-height:1.15;margin-bottom:6px}
        .sub{font-size:16px;font-weight:600;margin-bottom:22px}
        /* A quiet zone the printer will honour — a QR flush against a border
           is much harder for a camera to lock onto. */
        .qr{width:100%;max-width:380px;margin:0 auto;padding:16px;border:3px solid #000;border-radius:12px}
        .qr img{display:block;width:100%;height:auto;image-rendering:pixelated}
        .url{font-family:ui-monospace,Consolas,monospace;font-size:15px;margin-top:18px;word-break:break-all}
        .foot{margin-top:26px;font-size:13px;font-weight:600}
        @media print{ @page{margin:12mm} body{padding:0;min-height:auto} }
      </style></head>
      <body><div class="card">
        <div class="kicker">Scan to shop</div>
        <h1>${esc(storeName)}</h1>
        <div class="sub">Iibso online — ka iibso dukaankayaga</div>
        <div class="qr"><img src="${dataUrl}" alt="QR code for ${esc(storeName)}"/></div>
        <div class="url">${esc(storeUrl)}</div>
        <div class="foot">Hamar Mall</div>
      </div>
      <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}<\/script>
      </body></html>`);
    win.document.close();
  }

  return (
    <div style={{
      marginTop: 10, padding: '14px 12px', borderRadius: 10,
      background: 'var(--surface)', border: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
    }}>
      <div style={{
        width: 104, height: 104, flexShrink: 0, background: '#fff',
        border: '1px solid var(--border)', borderRadius: 8, padding: 6,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {dataUrl
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={dataUrl} alt={`QR code for ${storeName}`} style={{ width: '100%', height: '100%', display: 'block' }} />
          : <span style={{ fontSize: '.7rem', color: 'var(--text-muted)', textAlign: 'center' }}>
              {error ? 'QR unavailable' : '…'}
            </span>}
      </div>

      <div style={{ flex: 1, minWidth: 170 }}>
        <div style={{ fontWeight: 700, fontSize: '.86rem' }}>Store QR code</div>
        <div style={{ fontSize: '.76rem', color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.45 }}>
          Print it and put it on the counter or the door — customers scan it to open your shop.
        </div>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          style={{ marginTop: 8 }}
          onClick={handlePrint}
          disabled={!dataUrl}
        >
          🖨️ Print QR
        </button>
      </div>
    </div>
  );
}
