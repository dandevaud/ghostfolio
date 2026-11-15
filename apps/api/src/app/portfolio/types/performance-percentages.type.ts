import { HistoricalDataItem } from '@ghostfolio/common/interfaces';

export type PerformancePercentages = Required<
  Pick<
    HistoricalDataItem,
    | 'dividendInPercentageWithCurrencyEffect'
    | 'netPerformanceInPercentage'
    | 'netPerformanceInPercentageWithCurrencyEffect'
  >
> &
  Partial<
    Pick<
      HistoricalDataItem,
      | 'timeWeightedPerformanceInPercentage'
      | 'timeWeightedPerformanceInPercentageWithCurrencyEffect'
    >
  >;
