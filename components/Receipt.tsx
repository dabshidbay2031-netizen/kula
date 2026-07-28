'use client';

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { isLogoUrl } from '@/components/StoreAvatar';
import type { CartItem, Product } from '@/lib/types';

interface ReceiptProps {
  orderId:       string;
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

  /**
   * QR code → live order page. Scanning it (store owner or customer)
   * opens the REAL order from the database — current status, items,
   * totals — not a static copy. Soft-deleted orders still resolve,
   * labeled as deleted.
   */
  const orderUrl = `${typeof window !== 'undefined' ? window.location.origin : ''}/#/orders/${orderId}`;
  const [qrDataUrl, setQrDataUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(orderUrl, { width: 132, margin: 1 })
      .then(url => { if (!cancelled) setQrDataUrl(url); })
      .catch(() => { /* receipt still works without the QR */ });
    return () => { cancelled = true; };
  }, [orderUrl]);

  // Auto-print (POS setting): when the QR is shown, give it a beat to render so
  // the printed copy isn't missing it; when the QR is hidden, print right away.
  const printedRef = useRef(false);
  useEffect(() => {
    if (!autoPrint || printedRef.current) return;
    if (showQr && !qrDataUrl) return;   // wait for the QR to finish rendering
    printedRef.current = true;
    const t = setTimeout(() => handlePrint(), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPrint, qrDataUrl, showQr]);

  function handlePrint() {
    const content = ref.current?.innerHTML ?? '';
    const win = window.open('', '_blank', 'width=400,height=700');
    if (!win) return;
    win.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8"/>
        <title>Receipt ${orderId}</title>
        <style>
          * { margin:0; padding:0; box-sizing:border-box; }
          body { font-family: 'Courier New', monospace; font-size: 13px; color:#000; background:#fff; padding:16px; }
          .receipt { max-width: 320px; margin: 0 auto; }
          .r-head { text-align:center; padding-bottom:12px; border-bottom:2px dashed #000; margin-bottom:12px; }
          .r-biz-icon { font-size:28px; }
          .r-biz-name { font-size:16px; font-weight:700; margin-top:4px; }
          .r-title { font-size:11px; letter-spacing:2px; text-transform:uppercase; color:#555; margin-top:2px; }
          .r-meta { font-size:11px; margin:8px 0 0; color:#555; }
          .r-items { padding:12px 0; border-bottom:2px dashed #000; }
          .r-item { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px; }
          .r-item-left { flex:1; }
          .r-item-name { font-weight:600; }
          .r-item-qty { font-size:11px; color:#555; }
          .r-item-price { font-weight:600; white-space:nowrap; margin-left:8px; }
          .r-totals { padding:12px 0; border-bottom:2px dashed #000; }
          .r-row { display:flex; justify-content:space-between; margin-bottom:4px; }
          .r-row.grand { font-size:15px; font-weight:700; border-top:1px solid #000; padding-top:6px; margin-top:6px; }
          .r-row.discount { color:#444; }
          .r-footer { text-align:center; font-size:11px; color:#555; margin-top:12px; }
          .r-pay-badge { display:inline-block; border:1px solid #000; border-radius:4px; padding:2px 8px; font-size:10px; font-weight:700; letter-spacing:1px; text-transform:uppercase; margin-top:4px; }
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
                <div style={{ fontSize:11, letterSpacing:2, textTransform:'uppercase', color:'#555', marginTop:2 }}>Receipt</div>
                {merchantNumber && (
                  <div style={{ fontSize:11, color:'#555', marginTop:8 }}>Merchant: {merchantNumber}</div>
                )}
                <div style={{ fontSize:11, marginTop: merchantNumber ? 0 : 8, color:'#555' }}>
                  {dateStr} · {timeStr}
                </div>
                <div style={{ fontSize:11, color:'#555' }}>Order: <strong>{orderId}</strong></div>
                {customerName && <div style={{ fontSize:11, color:'#555' }}>Customer: {customerName}</div>}
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
                        <div style={{ fontSize:11, color:'#555' }}>
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

              {/* QR — scan to open the live order (POS can hide it via Settings) */}
              {showQr && (
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
                  <div style={{ fontSize:10, color:'#555', marginTop:6, letterSpacing:1, textTransform:'uppercase' }}>
                    Scan to view this order
                  </div>
                </div>
              )}

              {/* Footer */}
              <div style={{ textAlign:'center', fontSize:11, color:'#555', marginTop:12 }}>
                <div style={{ display:'inline-block', border:'1px solid #000', borderRadius:4, padding:'2px 8px', fontSize:10, fontWeight:700, letterSpacing:1, textTransform:'uppercase', marginBottom:8 }}>
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
