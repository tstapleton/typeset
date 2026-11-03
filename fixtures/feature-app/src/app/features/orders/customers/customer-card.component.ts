import { Component, input } from '@angular/core';
import type { Customer } from '../index';

@Component({
  selector: 'app-customer-card',
  template: `<p>{{ customer().name }}</p>`,
})
export class CustomerCardComponent {
  readonly customer = input.required<Customer>();
}
