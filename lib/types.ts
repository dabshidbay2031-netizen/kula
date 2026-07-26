import type { Gender } from '@/lib/demographics';

export interface Category {
  id:    string;
  name:  string;
  icon:  string;
  color: string;
}

export interface SubCategory {
  id:   string;
  name: string;
  icon: string;
}

export interface PriceTier {
  minQty: number;
  maxQty: number | null;
  price:  number;
}

export interface Product {
  id:            number;
  name:          string;
  price:         number;
  originalPrice: number;
  cost?:         number; // what it costs to acquire/produce — drives profit on the dashboard
  category:      string;
  subCategory?:  string;
  stock:         number;
  sku:           string;
  supplierId:    number | null;
  rating:        number;
  reviews:       number;
  sold:          number;
  description:   string;
  barcode?:      string;        // EAN-13 / UPC-A / EAN-8
  tags?:         string[];      // feature tags e.g. ["Wireless","USB-C"]
  brand?:        string;
  imageUrl?:     string | null; // legacy single photo (kept for backwards compat)
  imageUrls?:    string[];      // multiple product photos (preferred)
  priceTiers?:   PriceTier[];   // wholesale tier pricing
  isB2b?:        boolean;       // only visible to business/supplier accounts
  moq?:          number;        // minimum order quantity
  taxMode?:      'none' | 'included' | 'excluded'; // VAT handling (5%)
  /** Set when this listing was COPIED from another store's catalog row (the
   *  "Add to my store" flow) — this row is owned outright by the copying store.
   *  Null for an original. Ships in migration_v4_0.sql. */
  copiedFromProductId?: number | null;
  /** The store pays the 3% platform fee for this product instead of the buyer
   *  ("transaction fee on us"). Ships in migration_v4_2.sql. */
  feeAbsorbedByStore?: boolean;
}

/** A product that a specific business has claimed from the global catalog */
export interface BusinessProduct {
  id:          number;
  supplierId:  number;
  productId:   number;
  product?:    Product; // populated on GET
  customPrice: number;
  stockQty:    number;
  moq:         number;  // minimum order quantity
  isActive:    boolean;
  createdAt:   string;
}

export interface Supplier {
  id:             number;
  name:           string;
  rating:         number;
  reviews:        number;
  location:       string;
  minOrder:       number;
  categories:     string[];
  icon:           string;
  description:    string;
  productIds:     number[];
  discount:       number;
  deliveryDays:   string;
  verified:       boolean;
  badge:          string;
  bio?:           string;
  contactNumbers?:string[];
  authUserId?:    string;
  slug?:          string | null;  // storefront URL slug (#/:slug)
  latitude?:      number | null;  // store GPS location (for map + directions)
  longitude?:     number | null;
  hideStock?:     boolean;  // hide stock count from public customers
  onlineOnly?:    boolean;  // internet-only store — no physical shopfront, no pickup
  accountType?:   'business' | 'supplier' | 'agent';
  /* Trial + approval lifecycle (absent on pre-migration schemas = approved) */
  approvalStatus?:      'trial' | 'pending' | 'approved' | 'rejected' | null;
  trialStartedAt?:      string | null;
  approvalRequestedAt?: string | null;
  /* Field-agent onboarding (migration_v3_9). A store is either self-registered
     (registeredByAgentId null) or was signed up by a field agent who set it up
     during trial/pending and is paid a fixed bounty once it's approved+paying. */
  registeredByAgentId?: number | null;   // the agent (supplier id) who onboarded this store
  agentLinkCode?:       string | null;   // code the OWNER hands to an agent (owner/admin only)
  agentSubmittedAt?:    string | null;   // when the agent submitted it for review
  agentBountyAmount?:   number | null;   // fixed bounty the admin agreed to pay the agent
  agentBountyPaidAt?:   string | null;   // when the admin paid that bounty
  /* Subscription billing (absent on pre-migration schemas) */
  billingEnabled?:         boolean;   // false = billing columns not deployed yet
  monthlyBillingEnabled?:  boolean;   // false = subscription_period_end not deployed yet
  subscriptionPaidAt?:     string | null;
  subscriptionRefundedAt?: string | null;
  subscriptionPeriodEnd?:  string | null;   // end of the paid month
  subscriptionPlan?:       string | null;
  subscriptionAmount?:     number | null;
}

export interface CartItem {
  id:  number;
  qty: number;
  /**
   * Unit price FROZEN at the moment of sale (server-written on the order's
   * line items — tier-adjusted, never the client's number). Absent on the
   * cart itself and on legacy orders placed before snapshotting existed.
   * Reporting must prefer this over today's catalog price, or changing a
   * price silently re-values past sales.
   */
  price?:     number;
  unitPrice?: number;
}

export interface Order {
  id:            string;
  customerName:  string;
  customerPhone: string;
  items:         CartItem[];
  subtotal:      number;
  discount:      number;
  total:         number;
  paymentMethod: string;
  status:        string;
  /** The store that SOLD this order (v3.7 attribution); null on legacy orders. */
  supplierId?:   number | null;
  /** POS register session + cashier — present ONLY on in-store (POS) sales, so
   *  they distinguish an in-store sale from an online (web checkout) order. */
  sessionId?:    string | null;
  cashierName?:  string | null;
  /** Platform fee charged ON TOP to the buyer (3%, online payments only). */
  platformFee?:     number | null;
  /** Platform fee the STORE absorbed ("fee on us") — deducted from its payout,
   *  so any seller-facing revenue figure must subtract it to match the wallet. */
  feePaidByStore?:  number | null;
  createdAt:     string;
}

export interface Notification {
  id:      number;
  type:    string;
  title:   string;
  message: string;
  time:    string;
  read:    boolean;
  icon:    string;
}

export interface Toast {
  id:      string;
  message: string;
  type:    'default' | 'success' | 'error' | 'warning';
}

export interface UserProfile {
  id:        string;
  fullName:  string;
  phone:     string;
  avatar:    string;
  avatarUrl: string | null;
  bio:       string;
  verified:  boolean;
  createdAt: string;
  /* Optional shopper demographics (migration_v4_5), for audience
     segmentation. '' / null means the shopper chose not to say. */
  gender?:     Gender;
  birthYear?:  number | null;
  /** Derived server-side from birthYear on every read — never stored. */
  age?:        number | null;
  ageBracket?: string | null;
}

export type AccountType   = 'user' | 'business' | 'supplier' | 'agent';
export type PaymentMethod = 'waafi' | 'cash' | 'card' | 'sifalo';

/** Sifalo Pay sub-gateways (which wallet the customer pays from). */
export type SifaloGateway = 'waafi' | 'edahab' | 'pbwallet';
export type PaymentState  = 'idle'  | 'pending' | 'success' | 'error';

export interface PaymentSplit {
  method: PaymentMethod;
  amount: string;
}

export interface PosSession {
  id:             string;
  openedBy:       string;
  cashierName:    string;
  openedAt:       string;
  closedAt:       string | null;
  openingFloat:   number;
  closingCounted: number | null;
  expectedCash:   number | null;
  discrepancy:    number | null;
  status:         'open' | 'closed';
  notes:          string | null;
  totalOrders?:   number;
  totalRevenue?:  number;
  cashRevenue?:   number;
  /** Register opened while OFFLINE — exists only on this device until the
   *  connection returns. Its sales attribute by supplier + cashier, not by a
   *  (non-existent) DB session row. */
  local?:         boolean;
}

/** Minimal user info carried inside chat responses */
export interface ChatUser {
  id:             string;
  name:           string;
  avatar:         string;   // emoji or URL
  type:           'user' | 'business';
  verified:       boolean;
  bio?:           string;
  location?:      string;
  categories?:    string[];
  contactNumbers?:string[];
}

export interface Conversation {
  id:           string;   // UUID
  userId1:      string;
  userId2:      string;
  otherUser?:   ChatUser; // populated on GET
  lastMessage?: Message;
  unreadCount:  number;
  createdAt:    string;
  updatedAt:    string;
}

export interface Message {
  id:             string;   // UUID
  conversationId: string;
  senderId:       string;
  content:        string | null;
  imageUrl:       string | null;
  messageType:    'text' | 'image';
  readAt:         string | null;
  createdAt:      string;
  senderInfo?:    ChatUser; // populated on GET
  /** Client-only: the send failed and this is sitting in the outbox awaiting
   *  a retry. Never returned by the API. */
  failed?:        boolean;
}

export interface Customer {
  id:        string;
  name:      string;
  phone:     string;
  email:     string;
  address:   string;
  gender?:   'male' | 'female' | '';
  notes:     string;
  createdAt: string;
}
