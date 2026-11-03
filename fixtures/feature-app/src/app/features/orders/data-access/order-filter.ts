import { OrderStatus } from '../orders.models';
import type { CustomerRef } from '../customers/customer.model';

export type OrderFilter = {
  status: OrderStatus | 'all';
  customer?: CustomerRef;
};

export const ALL_ORDERS: OrderFilter = { status: 'all' };
