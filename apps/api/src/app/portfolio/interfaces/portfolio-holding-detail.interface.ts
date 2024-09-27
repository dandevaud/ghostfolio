import { Activity } from '@ghostfolio/api/app/order/interfaces/activities.interface';
import {
  DataProviderInfo,
  EnhancedSymbolProfile,
  HistoricalDataItem
} from '@ghostfolio/common/interfaces';

import { Tag } from '@prisma/client';

export interface PortfolioHoldingDetail {
  averagePrice: number;
  dataProviderInfo: DataProviderInfo;
  dividendInBaseCurrency: number;
  stakeRewards: number;
  dividendYieldPercent: number;
  dividendYieldPercentWithCurrencyEffect: number;
  feeInBaseCurrency: number;
  firstBuyDate: string;
  grossPerformance: number;
  grossPerformancePercent: number;
  grossPerformancePercentWithCurrencyEffect: number;
  grossPerformanceWithCurrencyEffect: number;
  historicalData: HistoricalDataItem[];
  investment: number;
  marketPrice: number;
  maxPrice: number;
  minPrice: number;
  netPerformance: number;
  netPerformancePercent: number;
  netPerformancePercentWithCurrencyEffect: number;
  netPerformanceWithCurrencyEffect: number;
  orders: Activity[];
  quantity: number;
  SymbolProfile: EnhancedSymbolProfile;
  tags: Tag[];
  transactionCount: number;
  value: number;
}
