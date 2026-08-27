import { PortfolioCalculator } from '@ghostfolio/api/app/portfolio/calculator/portfolio-calculator';
import { LogPerformance } from '@ghostfolio/api/interceptors/performance-logging/performance-logging.interceptor';
import {
  AssetProfileIdentifier,
  SymbolMetrics
} from '@ghostfolio/common/interfaces';
import { PortfolioSnapshot, TimelinePosition } from '@ghostfolio/common/models';
import { PerformanceCalculationType } from '@ghostfolio/common/types/performance-calculation-type.type';

import { Logger } from '@nestjs/common';
import { Big } from 'big.js';

import { PortfolioOrderItem } from '../../interfaces/portfolio-order-item.interface';
import { PerformanceAccumulator } from './portfolio-accumulator';
import { RoiPortfolioCalculatorSymbolMetricsHelper } from './portfolio-calculator-symbolmetrics-helper';

export class RoiPortfolioCalculator extends PortfolioCalculator {
  private chartDates: string[];
  private static readonly ACTIVITY_TYPES_FOR_COUNT = new Set([
    'BUY',
    'SELL',
    'STAKE'
  ]);

  @LogPerformance
  protected calculateOverallPerformance(
    positions: TimelinePosition[]
  ): PortfolioSnapshot {
    const acc: PerformanceAccumulator = {
      currentValueInBaseCurrency: this.ZERO,
      grossPerformance: this.ZERO,
      grossPerformanceWithCurrencyEffect: this.ZERO,
      hasErrors: false,
      netPerformance: this.ZERO,
      totalCashInBaseCurrency: this.ZERO,
      totalFeesWithCurrencyEffect: this.ZERO,
      totalInvestment: this.ZERO,
      totalInvestmentWithCurrencyEffect: this.ZERO,
      totalTimeWeightedInvestment: this.ZERO,
      totalTimeWeightedInvestmentWithCurrencyEffect: this.ZERO
    };

    for (const currentPosition of positions) {
      this.calculatePositionMetrics(currentPosition, acc);
    }

    return {
      currentValueInBaseCurrency: acc.currentValueInBaseCurrency,
      hasErrors: acc.hasErrors,
      positions,
      totalFeesWithCurrencyEffect: acc.totalFeesWithCurrencyEffect,
      totalInterestWithCurrencyEffect: this.ZERO,
      totalInvestment: acc.totalInvestment,
      totalInvestmentWithCurrencyEffect: acc.totalInvestmentWithCurrencyEffect,
      totalCashInBaseCurrency: acc.totalCashInBaseCurrency,
      activitiesCount: this.activities.filter(({ type }) => {
        return RoiPortfolioCalculator.ACTIVITY_TYPES_FOR_COUNT.has(type);
      }).length,
      createdAt: new Date(),
      errors: [],
      historicalData: [],
      totalLiabilitiesWithCurrencyEffect: this.ZERO
    };
  }

  protected getSymbolMetrics({
    chartDateMap,
    dataSource,
    end,
    exchangeRates,
    marketSymbolMap,
    start,
    symbol
  }: {
    chartDateMap?: { [date: string]: boolean };
    end: Date;
    exchangeRates: { [dateString: string]: number };
    marketSymbolMap: {
      [date: string]: { [symbol: string]: Big };
    };
    start: Date;
  } & AssetProfileIdentifier): SymbolMetrics {
    if (!this.chartDates) {
      this.chartDates = Object.keys(chartDateMap).sort();
    }
    const symbolMetricsHelperClass =
      new RoiPortfolioCalculatorSymbolMetricsHelper(
        PortfolioCalculator.ENABLE_LOGGING,
        marketSymbolMap,
        this.chartDates
      );
    const symbolMetricsHelper =
      symbolMetricsHelperClass.getSymbolMetricHelperObject(
        exchangeRates,
        start,
        end,
        marketSymbolMap,
        symbol
      );

    let orders: PortfolioOrderItem[] = this.activities
      .filter(({ assetProfile }) => assetProfile.symbol === symbol)
      .map((activity) => ({ ...activity }));

    if (!orders.length) {
      return symbolMetricsHelper.symbolMetrics;
    }

    if (
      symbolMetricsHelperClass.hasNoUnitPriceAtEndOrStartDate(
        symbolMetricsHelper.unitPriceAtEndDate,
        symbolMetricsHelper.unitPriceAtStartDate,
        orders,
        start
      )
    ) {
      symbolMetricsHelper.symbolMetrics.hasErrors = true;
      return symbolMetricsHelper.symbolMetrics;
    }

    symbolMetricsHelperClass.addSyntheticStartAndEndOrder(
      orders,
      symbolMetricsHelper,
      dataSource,
      symbol,
      orders.some((order) => order.assetProfile.assetSubClass === 'CASH')
    );

    orders = symbolMetricsHelperClass.fillOrdersAndSortByTime(
      orders,
      symbolMetricsHelper,
      chartDateMap,
      marketSymbolMap,
      symbol,
      dataSource
    );

    symbolMetricsHelper.indexOfStartOrder = orders.findIndex(({ itemType }) => {
      return itemType === 'start';
    });
    symbolMetricsHelper.indexOfEndOrder = orders.findIndex(({ itemType }) => {
      return itemType === 'end';
    });

    for (let i = 0; i < orders.length; i++) {
      symbolMetricsHelperClass.processOrderMetrics(
        orders,
        i,
        exchangeRates,
        symbolMetricsHelper
      );
      if (i === symbolMetricsHelper.indexOfEndOrder) {
        break;
      }
    }

    symbolMetricsHelperClass.handleOverallPerformanceCalculation(
      symbolMetricsHelper
    );
    symbolMetricsHelperClass.calculateNetPerformanceByDateRange(
      start,
      symbolMetricsHelper
    );

    return symbolMetricsHelper.symbolMetrics;
  }

  protected getPerformanceCalculationType() {
    return PerformanceCalculationType.ROI;
  }

  private calculatePositionMetrics(
    currentPosition: TimelinePosition,
    acc: PerformanceAccumulator
  ) {
    if (currentPosition.feeInBaseCurrency) {
      acc.totalFeesWithCurrencyEffect = acc.totalFeesWithCurrencyEffect.plus(
        currentPosition.feeInBaseCurrency
      );
    }

    if (currentPosition.valueInBaseCurrency) {
      acc.currentValueInBaseCurrency = acc.currentValueInBaseCurrency.plus(
        currentPosition.valueInBaseCurrency
      );
    } else {
      acc.hasErrors = true;
    }

    if (currentPosition.investment) {
      acc.totalInvestment = acc.totalInvestment.plus(
        currentPosition.investment
      );

      acc.totalInvestmentWithCurrencyEffect =
        acc.totalInvestmentWithCurrencyEffect.plus(
          currentPosition.investmentWithCurrencyEffect
        );
    } else {
      acc.hasErrors = true;
    }

    if (currentPosition.grossPerformance) {
      acc.grossPerformance = acc.grossPerformance.plus(
        currentPosition.grossPerformance
      );

      acc.grossPerformanceWithCurrencyEffect =
        acc.grossPerformanceWithCurrencyEffect.plus(
          currentPosition.grossPerformanceWithCurrencyEffect
        );

      acc.netPerformance = acc.netPerformance.plus(
        currentPosition.netPerformance
      );
    } else if (!currentPosition.quantity.eq(0)) {
      acc.hasErrors = true;
    }

    if (currentPosition.timeWeightedInvestment) {
      acc.totalTimeWeightedInvestment = acc.totalTimeWeightedInvestment.plus(
        currentPosition.timeWeightedInvestment
      );

      acc.totalTimeWeightedInvestmentWithCurrencyEffect =
        acc.totalTimeWeightedInvestmentWithCurrencyEffect.plus(
          currentPosition.timeWeightedInvestmentWithCurrencyEffect
        );
    } else if (!currentPosition.quantity.eq(0)) {
      Logger.warn(
        `Missing historical market data for ${currentPosition.symbol} (${currentPosition.dataSource})`,
        'PortfolioCalculator'
      );

      acc.hasErrors = true;
    }
  }
}
