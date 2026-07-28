/**
 * Client-safe data — only small look-up tables and utility functions.
 * Large product/supplier/order arrays live in lib/seed-data.ts (server-only).
 */
import type { Category, SubCategory } from './types';

/* ── Categories (13 total) ────────────────────────────────────── */
export const CATEGORIES: Category[] = [
  { id: 'electronics',  name: 'Electronics',  icon: '📱', color: '#6366F1' },
  { id: 'clothes',      name: 'Clothes',       icon: '👕', color: '#EC4899' },
  { id: 'home',         name: 'Home',          icon: '🏠', color: '#10B981' },
  { id: 'food',         name: 'Food',          icon: '🍎', color: '#F59E0B' },
  { id: 'health',       name: 'Health',        icon: '🩺', color: '#06B6D4' },
  { id: 'sports',       name: 'Sports',        icon: '⚽', color: '#F97316' },
  { id: 'medicine',     name: 'Medicine',      icon: '💊', color: '#EF4444' },
  { id: 'cosmetics',    name: 'Cosmetics',     icon: '💄', color: '#F472B6' },
  { id: 'construction', name: 'Construction',  icon: '🏗️', color: '#92400E' },
  { id: 'furniture',    name: 'Furniture',     icon: '🪑', color: '#78350F' },
  { id: 'cars',         name: 'Automotive',    icon: '🚗', color: '#1D4ED8' },
  { id: 'books',        name: 'Books',         icon: '📚', color: '#7C3AED' },
  { id: 'other',        name: 'Other',         icon: '📦', color: '#94A3B8' },
];

/* ── Subcategories per category ──────────────────────────────── */
export const SUBCATEGORIES: Record<string, SubCategory[]> = {
  electronics: [
    { id:'phones',     name:'Phones',          icon:'📱' },
    { id:'laptops',    name:'Laptops',          icon:'💻' },
    { id:'audio',      name:'Audio',            icon:'🎧' },
    { id:'tv',         name:'TV & Display',     icon:'📺' },
    { id:'wearables',  name:'Wearables',        icon:'⌚' },
    { id:'acc_elec',   name:'Accessories',      icon:'🔌' },
  ],
  clothes: [
    { id:'mens',        name:"Men's Clothing",  icon:'👔' },
    { id:'womens',      name:"Women's Clothing",icon:'👗' },
    { id:'kids_cloth',  name:"Children's",      icon:'🧒' },
    { id:'footwear',    name:'Footwear',         icon:'👟' },
    { id:'traditional', name:'Traditional',      icon:'🪡' },
    { id:'sportswear',  name:'Sportswear',       icon:'🩱' },
  ],
  home: [
    { id:'kitchen',    name:'Kitchen',          icon:'🍳' },
    { id:'cleaning',   name:'Cleaning',         icon:'🧹' },
    { id:'lighting',   name:'Lighting',         icon:'💡' },
    { id:'bedding',    name:'Bedding',          icon:'🛏️' },
    { id:'decor',      name:'Décor',            icon:'🖼️' },
    { id:'garden',     name:'Garden',           icon:'🌱' },
  ],
  food: [
    { id:'fresh',      name:'Fresh Produce',    icon:'🥦' },
    { id:'packaged',   name:'Packaged Foods',   icon:'📦' },
    { id:'beverages',  name:'Beverages',        icon:'🥤' },
    { id:'dairy',      name:'Dairy',            icon:'🥛' },
    { id:'snacks',     name:'Snacks',           icon:'🍿' },
    { id:'organic',    name:'Organic',          icon:'🌿' },
  ],
  health: [
    { id:'supplements',name:'Supplements',      icon:'💊' },
    { id:'devices',    name:'Medical Devices',  icon:'🩺' },
    { id:'personal',   name:'Personal Care',    icon:'🧴' },
    { id:'eye',        name:'Eye Care',         icon:'👁️' },
    { id:'dental',     name:'Dental',           icon:'🦷' },
    { id:'baby_health',name:'Baby & Child',     icon:'🍼' },
  ],
  sports: [
    { id:'gym',        name:'Gym Equipment',    icon:'🏋️' },
    { id:'team',       name:'Team Sports',      icon:'⚽' },
    { id:'outdoor',    name:'Outdoor',          icon:'⛺' },
    { id:'swimming',   name:'Swimming',         icon:'🏊' },
    { id:'cycling',    name:'Cycling',          icon:'🚴' },
    { id:'yoga_fit',   name:'Yoga & Fitness',   icon:'🧘' },
  ],
  medicine: [
    { id:'prescription',name:'Prescription',   icon:'📋' },
    { id:'otc',        name:'Over-the-Counter', icon:'💊' },
    { id:'vitamins',   name:'Vitamins',         icon:'🌞' },
    { id:'equipment',  name:'Equipment',        icon:'🩺' },
    { id:'first_aid',  name:'First Aid',        icon:'🩹' },
    { id:'baby_med',   name:'Baby Medicine',    icon:'🍼' },
  ],
  cosmetics: [
    { id:'skincare',   name:'Skincare',         icon:'🧴' },
    { id:'makeup',     name:'Makeup',           icon:'💋' },
    { id:'haircare',   name:'Hair Care',        icon:'💆' },
    { id:'fragrance',  name:'Fragrances',       icon:'🌺' },
    { id:'nail',       name:'Nail Care',        icon:'💅' },
    { id:'mens_groom', name:"Men's Grooming",   icon:'🪒' },
  ],
  construction: [
    { id:'materials',  name:'Building Materials',icon:'🧱' },
    { id:'tools',      name:'Tools',            icon:'🔧' },
    { id:'electrical', name:'Electrical',       icon:'⚡' },
    { id:'plumbing',   name:'Plumbing',         icon:'🚿' },
    { id:'paint',      name:'Paint & Finishing', icon:'🎨' },
    { id:'safety',     name:'Safety Equipment', icon:'🦺' },
  ],
  furniture: [
    { id:'living',      name:'Living Room',     icon:'🛋️' },
    { id:'bedroom',     name:'Bedroom',         icon:'🛏️' },
    { id:'office_furn', name:'Office',          icon:'🖥️' },
    { id:'kitchen_furn',name:'Kitchen & Dining',icon:'🪑' },
    { id:'outdoor_furn',name:'Outdoor',         icon:'⛱️' },
    { id:'storage',     name:'Storage',         icon:'📦' },
  ],
  cars: [
    { id:'car_acc',    name:'Accessories',      icon:'🔑' },
    { id:'car_parts',  name:'Spare Parts',      icon:'⚙️' },
    { id:'tires',      name:'Tires & Wheels',   icon:'🛞' },
    { id:'car_elec',   name:'Car Electronics',  icon:'📡' },
    { id:'car_clean',  name:'Cleaning',         icon:'🧽' },
    { id:'car_tools',  name:'Tools',            icon:'🔩' },
  ],
  books: [
    { id:'education',   name:'Education',       icon:'📖' },
    { id:'fiction',     name:'Fiction',         icon:'📗' },
    { id:'nonfiction',  name:'Non-Fiction',     icon:'📘' },
    { id:'religious',   name:'Religious',       icon:'📿' },
    { id:'childrens',   name:"Children's",      icon:'🧸' },
    { id:'business_bk', name:'Business',        icon:'💼' },
  ],
  other: [
    { id:'misc', name:'Miscellaneous', icon:'📦' },
  ],
};

/* ── Mogadishu (Banaadir) delivery districts ─────────────────── */
// Shown in checkout when the customer chooses Delivery.
export const MOGADISHU_DISTRICTS: string[] = [
  'Abdiaziz', 'Bondhere', 'Daynile', 'Dharkenley', 'Hamar-Jajab', 'Hamar-Weyne',
  'Hodan', 'Howl-Wadag', 'Heliwaa', 'Karan', 'Kaxda', 'Shangani', 'Shibis',
  'Waberi', 'Wadajir (Medina)', 'Warta Nabada', 'Yaqshid', 'Darusalaam', 'Gubadley',
];

/* ── Utility helpers ─────────────────────────────────────────── */
export function getCategoryColor(id: string): string {
  return CATEGORIES.find(c => c.id === id)?.color ?? '#6366F1';
}
export function getCategoryById(id: string): Category | undefined {
  return CATEGORIES.find(c => c.id === id);
}
export function getSubcategories(categoryId: string): SubCategory[] {
  return SUBCATEGORIES[categoryId] ?? [];
}
/**
 * The categories actually represented in a set of products, in the canonical
 * CATEGORIES order.
 *
 * For filter chips over a *fixed* set of products — a single store's shelf,
 * not the marketplace. Listing all thirteen there means most are dead: a
 * grocery store scrolls past Automotive and Construction, and tapping either
 * filters the grid to nothing.
 *
 * Unknown category ids on a product are dropped rather than invented, so a
 * typo in imported data can't add a chip that no picker can produce.
 */
export function stockedCategories(items: { category: string }[]): Category[] {
  const stocked = new Set(items.map(i => i.category));
  return CATEGORIES.filter(c => stocked.has(c.id));
}
export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
export function discountPct(price: number, originalPrice: number): number {
  return Math.round((1 - price / originalPrice) * 100);
}
