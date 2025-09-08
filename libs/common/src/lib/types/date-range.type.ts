export type DateRange =
  | '1d'
  | 'wtd'
  | '1w'
  | 'mtd'
  | '1m'
  | '3m'
  | 'ytd'
  | '1y'
  | '3y'
  | '5y'
  | '10y'
  | 'max'
  | string; // '2024', '2023', '2022', etc.

export const DateRangeTypes: DateRange[] = [
  '1d',
  'wtd',
  '1w',
  'mtd',
  '1m',
  '3m',
  'ytd',
  '1y',
  '3y',
  '5y',
  '10y',
  'max'
];
