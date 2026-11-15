import { HoldingPerformance } from '@ghostfolio/api/app/portfolio/interfaces/holding-performance.interface';

import { Big } from 'big.js';

import { PortfolioCalculatorActivityItem } from '../../interfaces/portfolio-calculator-activity-item.interface';

export class PortfolioCalculatorSymbolMetricsHelperObject {
  currentExchangeRate: number;
  endDateString: string;
  exchangeRateAtOrderDate: number;
  fees: Big = new Big(0);
  feesWithCurrencyEffect: Big = new Big(0);
  feesAtStartDate: Big = new Big(0);
  feesAtStartDateWithCurrencyEffect: Big = new Big(0);
  grossPerformanceAtStartDate: Big = new Big(0);
  grossPerformanceAtStartDateWithCurrencyEffect: Big = new Big(0);
  indexOfEndOrder: number;
  indexOfStartOrder: number;
  initialValue: Big;
  initialValueWithCurrencyEffect: Big;
  investmentAtStartDate: Big;
  investmentAtStartDateWithCurrencyEffect: Big;
  investmentValueBeforeTransaction: Big = new Big(0);
  investmentValueBeforeTransactionWithCurrencyEffect: Big = new Big(0);
  ordersByDate: { [date: string]: PortfolioCalculatorActivityItem[] } = {};
  startDateString: string;
  symbolMetrics: HoldingPerformance;
  totalUnits: Big = new Big(0);
  totalInvestmentFromBuyTransactions: Big = new Big(0);
  totalInvestmentFromBuyTransactionsWithCurrencyEffect: Big = new Big(0);
  totalQuantityFromBuyTransactions: Big = new Big(0);
  totalValueOfPositionsSold: Big = new Big(0);
  totalValueOfPositionsSoldWithCurrencyEffect: Big = new Big(0);
  unitPrice: Big;
  unitPriceAtEndDate: Big = new Big(0);
  unitPriceAtStartDate: Big = new Big(0);
  valueAtStartDate: Big = new Big(0);
  valueAtStartDateWithCurrencyEffect: Big = new Big(0);
}
