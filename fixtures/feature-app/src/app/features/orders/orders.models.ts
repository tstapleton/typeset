import type { Currency } from '@core/api/user';
import type { CustomerRef } from './customers/customer.model';

export enum OrderStatus {
  Draft = 'draft',
  Placed = 'placed',
  Shipped = 'shipped',
}

export type Money = { amount: number; currency: Currency };

export interface OrderLine {
  sku: string;
  quantity: number;
  price: Money;
}

/** An order as the API returns it. */
export interface Order {
  readonly id: string;
  status: OrderStatus;
  customer: CustomerRef;
  lines: OrderLine[];
  /** Keyed by SKU. */
  discounts?: Record<string, Money>;
  placedAt: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
}
