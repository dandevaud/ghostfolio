import { Big } from 'big.js';

export interface PerformanceAccumulator {
  currentValueInBaseCurrency: Big;
  grossPerformance: Big;
  grossPerformanceWithCurrencyEffect: Big;
  hasErrors: boolean;
  netPerformance: Big;
  totalCashInBaseCurrency: Big;
  totalFeesWithCurrencyEffect: Big;
  totalInvestment: Big;
  totalInvestmentWithCurrencyEffect: Big;
  totalTimeWeightedInvestment: Big;
  totalTimeWeightedInvestmentWithCurrencyEffect: Big;
}
