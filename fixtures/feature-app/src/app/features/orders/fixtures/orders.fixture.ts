import type { Order } from '../orders.models';

export interface FixtureOnly {
  order: Order;
}

export const ORDER: Partial<Order> = { id: '1' };
