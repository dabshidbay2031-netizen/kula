'use client';

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { isLogoUrl } from '@/components/StoreAvatar';
import type { CartItem, Product } from '@/lib/types';

interface ReceiptProps {
  /**
   * The order this receipt belongs to. OMIT IT for a plain print — a counter
   * slip that is not a sale: no order number is printed and no QR is drawn,
   * because there is no order for either of them to point at. Printing an id
   * that resolves to nothing is worse than printing none at all.
   */
  orderId?:      string;
  businessName?: string;
  businessIcon?: string;
  customerName:  string;
  paymentMethod: string;
  items:         CartItem[];
  products:      Product[];
  subtotal:      number;
  discount:      number;
  total:         number;
  /** The order's date — pass when REPRINTING so the receipt shows when the
   *  sale happened, not when the reprint button was clicked. */
  date?:         string | Date;
  /** Open the print dialog automatically (Settings → POS → Auto-Print). */
  autoPrint?:    boolean;
  /** Show the order-tracking QR. POS-only setting (Settings → Point of Sale).
   *  Online-sale receipts always pass true (default). */
  showQr?:       boolean;
  /** A merchant ID / phone printed under the business name. POS-only. */
  merchantNumber?: string;
  /** Up to 3 free-text lines printed at the very top of the receipt. POS-only. */
  headerLines?:  string[];
  onClose:       () => void;
}

export default function Receipt({
  orderId, businessName, businessIcon, customerName,
  paymentMethod, items, products, subtotal, discount, total, date, autoPrint,
  showQr = true, merchantNumber, headerLines, onClose,
}: ReceiptProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Header lines are optional and empty entries are skipped (so a store using
  // only one or two lines doesn't print blank rows).
  const visibleHeaderLines = (headerLines ?? []).map(l => l.trim()).filter(Boolean);

  /** No order → nothing to number and nothing to scan. */
  const isPlainPrint = !orderId;
  const wantQr = showQr && !isPlainPrint;

  /**
   * QR code → live order page. Scanning it (store owner or customer)
   * opens the REAL order from the database — current status, items,
   * totals — not a static copy. Soft-deleted orders still resolve,
   * labeled as deleted.
   */
  const orderUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/#/orders/${orderId}`;
  const [qrDataUrl, setQrDataUrl] = useState('');

  useEffect(() => {
    if (!wantQr) { setQrDataUrl(''); return; }
    let cancelled = false;
    QRCode.toDataURL(orderUrl, { width: 132, margin: 1 })
      .then(url => { if (!cancelled) setQrDataUrl(url); })
      .catch(() => { /* receipt still works without the QR */ });
    return () => { cancelled = true; };
  }, [orderUrl, wantQr]);

  // Auto-print (POS setting): when the QR is shown, give it a beat to render so
  // the printed copy isn't missing it; when the QR is hidden, print right away.
  const printedRef = useRef(false);
  useEffect(() => {
    if (!autoPrint || printedRef.current) return;
    if (wantQr && !qrDataUrl) return;   // wait for the QR to finish rendering
    printedRef.current = true;
    const t = setTimeout(() => handlePrint(), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPrint, qrDataUrl, wantQr]);

  function handlePrint() {
    const content = ref.current?.innerHTML ?? '';
    const win = window.open('', '_blank', 'width=400,height=700');
    if (!win) return;
    win.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8"/>
        <title>${orderId ? `Receipt ${orderId}` : 'Receipt'}</title>
        <style>
          * { margin:0; padding:0; box-sizing:border-box; }
          body { font-family: 'Courier New', monospace; font-size: 13px; color:#000; background:#fff; padding:16px; }
          .receipt { max-width: 320px; margin: 0 auto; }

          /* ── Thermal-printer legibility ──────────────────────────────────
             A thermal head is 1-BIT: each dot is either burned or it isn't,
             so there is no grey ink. Anything grey gets halftoned into a
             sparse scatter of dots and, at 10–11px, most of a glyph's strokes
             fall between those dots and never reach the paper — which is why
             the date, order number, "1 × $5.00" and the footer came out as
             ghosts while the bold black lines printed solid.

             The receipt body is built with INLINE styles (that is what the
             screen preview uses), and those inline greys are copied into this
             document with the markup. A normal rule can't beat an inline
             style, so this override is deliberately !important — it is the
             only thing that can force them black. The on-screen preview is a
             separate document and keeps its softer greys.

             The small print is 12px at source (it was 10–11px): below roughly
             12px a 203dpi head drops strokes even in solid black. */
          .receipt, .receipt * {
            color: #000 !important;
            opacity: 1 !important;
            text-shadow: none !important;
            filter: none !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          @media print {
            body { padding:0; }
            @page { margin:8mm; }
          }
        </style>
      </head>
      <body>
        <div class="receipt">${content}</div>
        <script>window.onload = () => { window.print(); window.onafterprint = () => window.close(); }</script>
      </body>
      </html>
    `);
    win.document.close();
  }

  const now = date ? new Date(date) : new Date();
  const dateStr = now.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
  const pmLabel = paymentMethod === 'waafi' ? 'Waafi Pay'
    : paymentMethod === 'cash' ? 'Cash'
    : paymentMethod === 'sifalo' ? 'Sifalo Pay'
    : paymentMethod === 'invoice' ? 'Invoice (pay later)'
    : paymentMethod === 'card' ? 'Card'
    : paymentMethod;

  return (
    <>
      {/* Overlay */}
      <div
        style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.55)', zIndex:800, backdropFilter:'blur(2px)' }}
        onClick={onClose}
      />

      {/* Modal */}
      <div style={{
        position:'fixed', inset:0, zIndex:801, display:'flex', alignItems:'center', justifyContent:'center',
        padding: '16px',
      }}>
        <div style={{
          background:'#fff', borderRadius:16, padding:0, width:'100%', maxWidth:380,
          boxShadow:'0 20px 60px rgba(0,0,0,.3)', maxHeight:'90vh', display:'flex', flexDirection:'column',
        }}>
          {/* Header */}
          <div style={{ padding:'16px 20px 12px', borderBottom:'1px solid #eee', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <span style={{ fontWeight:700, fontSize:'1rem', color:'#111' }}>🧾 Receipt</span>
            <button onClick={onClose} style={{ background:'none', border:'none', fontSize:18, cursor:'pointer', color:'#999', padding:'0 4px' }}>✕</button>
          </div>

          {/* Scrollable content */}
          <div style={{ overflowY:'auto', padding:'20px', flex:1 }}>
            {/* Receipt preview */}
            <div ref={ref} style={{ fontFamily:"'Courier New', monospace", fontSize:13, color:'#000', lineHeight:1.5 }}>

              {/* Optional POS header lines (Settings → Point of Sale) */}
              {visibleHeaderLines.length > 0 && (
                <div style={{ textAlign:'center', paddingBottom:8, marginBottom:8, borderBottom:'2px dashed #000' }}>
                  {visibleHeaderLines.map((line, i) => (
                    <div key={i} style={{ fontSize:12, fontWeight:600 }}>{line}</div>
                  ))}
                </div>
              )}

              {/* Business header */}
              <div className="r-head" style={{ textAlign:'center', paddingBottom:12, borderBottom:'2px dashed #000', marginBottom:12 }}>
                {businessIcon && (
                  isLogoUrl(businessIcon) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={businessIcon}
                      alt={businessName ? `${businessName} logo` : 'Store logo'}
                      width={56}
                      height={56}
                      style={{ display:'block', margin:'0 auto 2px', objectFit:'contain', maxHeight:56 }}
                    />
                  ) : (
                    <div style={{ fontSize:28 }}>{businessIcon}</div>
                  )
                )}
                <div style={{ fontSize:16, fontWeight:700, marginTop:4 }}>{businessName || 'Hamar Mall'}</div>
                <div style={{ fontSize:12, letterSpacing:2, textTransform:'uppercase', color:'#555', marginTop:2 }}>Receipt</div>
                {merchantNumber && (
                  <div style={{ fontSize:12, color:'#555', marginTop:8 }}>Merchant: {merchantNumber}</div>
                )}
                <div style={{ fontSize:12, marginTop: merchantNumber ? 0 : 8, color:'#555' }}>
                  {dateStr} · {timeStr}
                </div>
                {orderId && <div style={{ fontSize:12, color:'#555' }}>Order: <strong>{orderId}</strong></div>}
                {customerName && <div style={{ fontSize:12, color:'#555' }}>Customer: {customerName}</div>}
              </div>

              {/* Items */}
              <div style={{ padding:'12px 0', borderBottom:'2px dashed #000' }}>
                {items.map(item => {
                  const p = products.find(x => x.id === item.id);
                  if (!p) return null;
                  return (
                    <div key={item.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6 }}>
                      <div style={{ flex:1 }}>
                        <div style={{ fontWeight:600 }}>{p.name}</div>
                        <div style={{ fontSize:12, color:'#555' }}>
                          {item.qty} × ${p.price.toFixed(2)}
                        </div>
                      </div>
                      <div style={{ fontWeight:600, whiteSpace:'nowrap', marginLeft:8 }}>
                        ${(p.price * item.qty).toFixed(2)}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Totals */}
              <div style={{ padding:'12px 0', borderBottom:'2px dashed #000' }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                  <span>Subtotal</span><span>${subtotal.toFixed(2)}</span>
                </div>
                {discount > 0 && (
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4, color:'#444' }}>
                    <span>Discount</span><span>-${discount.toFixed(2)}</span>
                  </div>
                )}
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:15, fontWeight:700, borderTop:'1px solid #000', paddingTop:6, marginTop:6 }}>
                  <span>TOTAL</span><span>${total.toFixed(2)}</span>
                </div>
              </div>

              {/* QR — scan to open the live order (POS can hide it via Settings).
                  Never drawn on a plain print: there is no order to open. */}
              {wantQr && (
                <div style={{ textAlign:'center', padding:'12px 0', borderBottom:'2px dashed #000' }}>
                  {qrDataUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={qrDataUrl}
                      alt={`QR code for order ${orderId}`}
                      width={132}
                      height={132}
                      style={{ display:'block', margin:'0 auto' }}
                    />
                  )}
                  <div style={{ fontSize:12, color:'#555', marginTop:6, letterSpacing:1, textTransform:'uppercase' }}>
                    Scan to view this order
                  </div>
                </div>
              )}

              {/* Footer */}
              <div style={{ textAlign:'center', fontSize:12, color:'#555', marginTop:12 }}>
                <div style={{ display:'inline-block', border:'1px solid #000', borderRadius:4, padding:'2px 8px', fontSize:12, fontWeight:700, letterSpacing:1, textTransform:'uppercase', marginBottom:8 }}>
                  {pmLabel}
                </div>
                <div>Thank you for your purchase!</div>
                <div style={{ marginTop:4, opacity:0.6 }}>Powered by Hamar Mall</div>
              </div>
            </div>
          </div>

          {/* Print button */}
          <div style={{ padding:'16px 20px', borderTop:'1px solid #eee', display:'flex', gap:10 }}>
            <button
              onClick={handlePrint}
              style={{
                flex:1, background:'#4F46E5', color:'#fff', border:'none', borderRadius:10,
                padding:'12px 0', fontWeight:700, fontSize:'0.95rem', cursor:'pointer',
              }}
            >
              🖨️ Print Receipt
            </button>
            <button
              onClick={onClose}
              style={{
                background:'#f3f4f6', color:'#374151', border:'none', borderRadius:10,
                padding:'12px 16px', fontWeight:600, fontSize:'0.9rem', cursor:'pointer',
              }}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
