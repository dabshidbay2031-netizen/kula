/**
 * Receipt customization stored in the shared `mogarenta_settings` localStorage
 * blob (per-device, same as the other POS settings in SettingsView). These are
 * POS-only: online-sale receipts don't read them.
 */
export interface ReceiptSettings {
  /** Print the order-tracking QR on POS receipts. Default on. */
  receiptQr:      boolean;
  /** Free-text merchant ID / phone printed under the business name. */
  merchantNumber: string;
  /** Up to 3 single-line text rows printed at the top of the receipt. */
  receiptHeader1: string;
  receiptHeader2: string;
  receiptHeader3: string;
}

const DEFAULTS: ReceiptSettings = {
  receiptQr:      true,
  merchantNumber: '',
  receiptHeader1: '',
  receiptHeader2: '',
  receiptHeader3: '',
};

/** Read the auto-print flag (existing POS setting). */
export function readReceiptAutoPrintSetting(): boolean {
  try {
    const raw = localStorage.getItem('mogarenta_settings');
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { autoPrint?: unknown };
    return !!parsed.autoPrint;
  } catch {
    return false;
  }
}

/** Read the POS receipt-customization block. Missing keys fall back to defaults. */
export function readReceiptSettings(): ReceiptSettings {
  try {
    const raw = localStorage.getItem('mogarenta_settings');
    if (!raw) return { ...DEFAULTS };
    const s = JSON.parse(raw) as Partial<ReceiptSettings>;
    return {
      receiptQr:      s.receiptQr !== undefined ? !!s.receiptQr : DEFAULTS.receiptQr,
      merchantNumber: typeof s.merchantNumber === 'string' ? s.merchantNumber : '',
      receiptHeader1: typeof s.receiptHeader1 === 'string' ? s.receiptHeader1 : '',
      receiptHeader2: typeof s.receiptHeader2 === 'string' ? s.receiptHeader2 : '',
      receiptHeader3: typeof s.receiptHeader3 === 'string' ? s.receiptHeader3 : '',
    };
  } catch {
    return { ...DEFAULTS };
  }
}
