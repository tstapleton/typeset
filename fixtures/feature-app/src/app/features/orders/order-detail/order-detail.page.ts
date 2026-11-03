import { Component, computed, input } from '@angular/core';
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
