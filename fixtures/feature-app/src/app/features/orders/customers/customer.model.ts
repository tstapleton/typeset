import type { User } from '@core/api/user';

export interface Address {
  line1: string;
  city: string;
  postcode: string;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  billing: Address;
  shipping?: Address;
  account: User;
}

export type CustomerRef = Pick<Customer, 'id' | 'name'>;
