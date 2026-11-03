import type { Order, Page } from '../orders.models';
import type { OrderFilter } from './order-filter';

export interface OrdersApi {
  list(filter: OrderFilter, page: number): Promise<Page<Order>>;
  get(id: string): Promise<Order>;
}
