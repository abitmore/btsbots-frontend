export type MongoId = string | number | { _str: string };

export function parseMongoId(id: MongoId | undefined | null): string {
  if (id === null || id === undefined) return '';
  if (typeof id === 'object' && '_str' in id) return id._str;
  return String(id);
}

/**
 * 健壮提取 BitShares 挂单对象 ID (1.7.X)
 */
export function extractBitsharesOrderId(orderDoc: any): string {
  if (!orderDoc) return '';
  const rawVal = orderDoc.id || orderDoc._id || '';
  const rawStr = typeof rawVal === 'object' && '_str' in rawVal ? rawVal._str : String(rawVal);
  const cleanDigits = rawStr.replace(/^~/, '').replace(/^1\.7\./, '').trim();
  return cleanDigits ? `1.7.${cleanDigits}` : '';
}

/**
 * 格式化 Vesting 归属对象 ID (1.13.X)
 */
export function formatVestingId(id: MongoId | undefined | null): string {
  const parsed = parseMongoId(id).replace(/^~/, '').replace(/^1\.3\./, '').trim();
  return parsed ? `1.13.${parsed}` : '';
}

export function parseMongoTime(t: string | number | Date | undefined | null): number {
  if (!t) return 0;
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') {
    return t < 10000000000 ? t * 1000 : t;
  }
  const parsedNum = Number(t);
  if (!isNaN(parsedNum)) {
    return parsedNum < 10000000000 ? parsedNum * 1000 : parsedNum;
  }
  const dateObj = new Date(t);
  return isNaN(dateObj.getTime()) ? 0 : dateObj.getTime();
}

export function formatFullDateTime(t: string | number | Date | undefined | null): string {
  const ms = parseMongoTime(t);
  if (!ms) return '--';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 智能时间拆分，方便移动端紧凑展示年月日与时分秒
 */
export function formatSmartDateTime(t: string | number | Date | undefined | null): { dateStr: string; timeStr: string; fullStr: string } {
  const ms = parseMongoTime(t);
  if (!ms) return { dateStr: '--', timeStr: '--', fullStr: '--' };
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return {
    dateStr,
    timeStr,
    fullStr: `${dateStr} ${timeStr}`
  };
}

/**
 * 价格有效位数格式化：保证至少 minSig 位有效数字，避免类似 0.000153432 被截断
 */
export function formatSignificantPrice(val: number | string | undefined | null, minSig = 3): string {
  if (val === null || val === undefined || val === '') return '--';
  const num = Number(val);
  if (isNaN(num)) return '--';
  if (num === 0) return '0.00';

  const absNum = Math.abs(num);
  if (absNum >= 1) {
    if (absNum >= 10000) {
      return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    }
    return num.toFixed(4).replace(/\.?0+$/, '');
  }

  // 小于 1 的小数，匹配首个非 0 位并保留至少 minSig 位有效数字
  const str = num.toFixed(10);
  const match = str.match(/^0\.(0*)([1-9]\d*)/);
  if (match) {
    const zeroCount = match[1].length;
    const decimals = Math.min(8, Math.max(4, zeroCount + minSig));
    return num.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '');
  }

  return num.toFixed(4);
}

export interface GlobalPropertyDoc {
  _id?: MongoId;
  id?: MongoId;
  B: number;
  T: string | number | Date;
  [key: string]: any;
}

export interface BalanceDoc {
  _id?: MongoId;
  id?: MongoId;
  a: string;
  b: number;
  f: number;
  u: string;
  [key: string]: any;
}

export interface OrderDoc {
  _id?: MongoId;
  id?: MongoId;
  a: {
    s: string;
    b: string;
  };
  b: number;
  p: number;
  u: string;
  displayPrice?: number;
  displayAmount?: number;
  [key: string]: any;
}

export interface AccountDoc {
  _id?: MongoId;
  id?: MongoId;
  T?: string | number | Date;
  f?: number;
  k?: {
    a: string[];
    o: string[];
    m: string;
  };
  o?: number;
  u: string;
  v?: boolean;
}

export interface AssetDoc {
  _id?: MongoId;
  id?: MongoId;
  a: string;
  u: string;
  p: number;
  b: number;
  T: string | number | Date;
}

export interface TransferDoc {
  _id?: MongoId;
  id?: MongoId;
  B?: number;
  T: string | number | Date;
  a: string;
  b: number;
  m?: boolean | string;
  u: [string, string];
  [key: string]: any;
}

export interface FillOrderDoc {
  _id?: MongoId;
  id?: MongoId;
  B?: number;
  T: string | number | Date;
  a: [string, string];
  b: [number, number];
  m: string;
  p: number;
  u: [string, string];
  t_side?: 'buy' | 'sell';
  displayPrice?: number;
  displayAmount?: number;
  isBuyerTaker?: boolean;
  [key: string]: any;
}

export interface OrderHistoryDoc {
  _id?: MongoId;
  id?: MongoId;
  T: string | number | Date;
  a: [string, string] | string[];
  b: number;
  m: string;
  p: number;
  t: 1 | 2 | 77;
  u: string;
  [key: string]: any;
}

export interface PriceDoc {
  _id?: MongoId;
  id?: MongoId;
  a: string;
  p: number;
  t?: number;
}

export interface TrustAssetDoc {
  _id?: MongoId;
  id?: MongoId;
  asset: string;
  rating: number;
}

export interface UserAssetSettingsDoc {
  _id?: MongoId;
  id?: MongoId;
  userId: string;
  hiddenAssets?: string[];
  allowedAssets?: string[];
  blockedUsers?: string[];
}

export interface WalletPaymentMetadataDoc {
  _id?: MongoId;
  id?: MongoId;
  block: number | string;
  userId: string;
  goods?: string;
  memo?: string;
  createdAt?: string | Date;
}

export interface VestingDoc {
  _id: MongoId;
  id?: MongoId;
  a: string;
  b: number;
  p: number;
  t: number;
  u: string;
}

export interface VestingWithdrawDoc {
  _id: MongoId;
  id?: MongoId;
  B: number;
  T: string | number | Date;
  a: string;
  b: number;
  u: string;
}

export interface InvitationDoc {
  _id?: MongoId;
  code: string;
  creator: string;
  status: 'unused' | 'used';
  usedBy?: string | null;
  createdAt: string | Date;
  usedAt?: string | Date | null;
}

export interface TopRankingsData {
  topAssets: Array<{ _id: MongoId; a: string; b?: number; v: number }>;
  topMarkets: Array<{ _id: MongoId; a: [string, string]; v: number }>;
  topTraders: Array<{ _id: MongoId; u: string; v: number }>;
}

export interface AssetRankingsData {
  topTraders: Array<{ username: string; volume: number }>;
  topRelatedAssets: Array<{ asset: string; volume: number }>;
}

export interface MarketSummaryData {
  price: number;
  change: number;
  high: number;
  low: number;
  volume: number;
}