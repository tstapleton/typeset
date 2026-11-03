import type { OrderFilter } from '../data-access/order-filter';

export interface CustomerOrders {
  customerId: string;
  filter: OrderFilter;
  savedFilters: OrderFilter[];
}
