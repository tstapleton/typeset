import { Injectable, signal } from '@angular/core';
import * as models from '../orders.models';
import { ALL_ORDERS, type OrderFilter } from './order-filter';
import type { OrdersApi } from './orders-api';

interface OrdersState {
  page: models.Page<models.Order>;
  selectedId: string | null;
  filter: OrderFilter;
  loading: boolean;
}

@Injectable()
export class OrdersStore {
  private readonly state = signal<OrdersState>({
    page: { items: [], total: 0 },
    selectedId: null,
    filter: ALL_ORDERS,
    loading: false,
  });

  constructor(private readonly api: OrdersApi) {}

  async load(): Promise<void> {
    const page = await this.api.list(this.state().filter, 0);
    this.state.update((s) => ({ ...s, page }));
  }

  isShipped(order: models.Order): boolean {
    return order.status === models.OrderStatus.Shipped;
  }
}
