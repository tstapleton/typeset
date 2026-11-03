import { Component, computed, input } from '@angular/core';
import type { CustomerRef } from '../customers/customer.model';
import { ALL_ORDERS, type OrderFilter } from '../data-access/order-filter';
import type { Money, Order, OrderLine } from '../orders.models';

interface LineView {
  line: OrderLine;
  total: Money;
}

@Component({
  selector: 'app-order-detail',
  template: `@for (row of rows(); track row.line.sku) {
    {{ row.total.amount }}
  }`,
})
export class OrderDetailPage {
  readonly order = input.required<Order>();
  readonly customer = input<CustomerRef>();
  readonly filter = input<OrderFilter>(ALL_ORDERS);
  readonly rows = computed<LineView[]>(() =>
    this.order().lines.map((line) => ({
      line,
      total: {
        amount: line.price.amount * line.quantity,
        currency: line.price.currency,
      },
    })),
  );
}
