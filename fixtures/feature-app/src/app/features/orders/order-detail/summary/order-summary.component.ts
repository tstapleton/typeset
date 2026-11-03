import { Component, input } from '@angular/core';
import type { Money } from '../../orders.models';

/** What the summary shows. Overlaps Order, but `status` is a plain string here. */
export interface OrderSummary {
  id: string;
  status: string;
  total: Money;
  customerName: string;
}

@Component({
  selector: 'app-order-summary',
  template: `{{ summary().id }}`,
})
export class OrderSummaryComponent {
  readonly summary = input.required<OrderSummary>();
}
