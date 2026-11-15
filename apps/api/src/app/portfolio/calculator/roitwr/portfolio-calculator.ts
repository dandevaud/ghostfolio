import { PortfolioCalculator } from '@ghostfolio/api/app/portfolio/calculator/portfolio-calculator';
import { AccumulatedValues } from '@ghostfolio/api/app/portfolio/interfaces/accumulated-values.interface';
import { HoldingPerformance } from '@ghostfolio/api/app/portfolio/interfaces/holding-performance.interface';
import { InvestedCapital } from '@ghostfolio/api/app/portfolio/interfaces/invested-capital.interface';
import { PortfolioCalculatorHolding } from '@ghostfolio/api/app/portfolio/interfaces/portfolio-calculator-holding.interface';
import { HoldingPerformanceValuation } from '@ghostfolio/api/app/portfolio/interfaces/holding-performance-valuation.interface';
import { PerformancePercentages } from '@ghostfolio/api/app/portfolio/types/performance-percentages.type';
import { getFactor } from '@ghostfolio/api/helper/portfolio.helper';
import {
  AssetProfileIdentifier,
  HistoricalDataItem
} from '@ghostfolio/common/interfaces';
import { PortfolioSnapshot } from '@ghostfolio/common/models';
import { DateRange } from '@ghostfolio/common/types';
import { PerformanceCalculationType } from '@ghostfolio/common/types/performance-calculation-type.type';

import { Big } from 'big.js';
import { mapValues } from 'lodash-es';

export class RoiTwrPortfolioCalculator extends PortfolioCalculator {
  private static readonly ACTIVITY_TYPES_FOR_COUNT = new Set([
    'BUY',
    'SELL',
    'STAKE'
  ]);

  protected calculateOverallPerformance({
    accumulatedValuesByDate,
    positions
  }: {
    accumulatedValuesByDate: { [date: string]: AccumulatedValues };
    positions: PortfolioCalculatorHolding[];
  }): PortfolioSnapshot {
    const { investedCapital, investedCapitalWithCurrencyEffect } =
      Object.values(
        this.getInvestedCapitalByDate({ accumulatedValuesByDate })
      ).at(-1) ?? {
        investedCapital: new Big(0),
        investedCapitalWithCurrencyEffect: new Big(0)
      };

    const snapshot = this.getOverallPerformance({
      investedCapital,
      investedCapitalWithCurrencyEffect,
      positions
    });

    return {
      ...snapshot,
      activitiesCount: this.activities.filter(({ type }) => {
        return RoiTwrPortfolioCalculator.ACTIVITY_TYPES_FOR_COUNT.has(type);
      }).length
    };
  }

  protected calculatePerformancePercentages({
    accumulatedValuesByDate
  }: {
    accumulatedValuesByDate: { [date: string]: AccumulatedValues };
  }): { [date: string]: PerformancePercentages } {
    const investedCapitalByDate = this.getInvestedCapitalByDate({
      accumulatedValuesByDate
    });

    return mapValues(accumulatedValuesByDate, (accumulatedValues, date) => {
      const performancePercentages =
        this.getPerformancePercentagesOfAccumulatedValues({
        accumulatedValues,
        ...investedCapitalByDate[date]
        });

      return {
        ...performancePercentages,
        timeWeightedPerformanceInPercentage:
        performancePercentages.netPerformanceInPercentage,
        timeWeightedPerformanceInPercentageWithCurrencyEffect:
        performancePercentages.netPerformanceInPercentageWithCurrencyEffect
      };
    });
  }

  protected calculatePerformancePercentagesForDateRange({
    historicalDataItems
  }: {
    historicalDataItems: HistoricalDataItem[];
  }): { [date: string]: PerformancePercentages } {
    let investedCapital = 0;
    let investedCapitalWithCurrencyEffect = 0;

    const performancePercentagesByDate: {
      [date: string]: PerformancePercentages;
    } = {};

    for (const [index, historicalDataItem] of historicalDataItems.entries()) {
      if (index === 0) {
        investedCapital = historicalDataItem.value;
        investedCapitalWithCurrencyEffect =
          historicalDataItem.valueWithCurrencyEffect;
      } else {
        const investmentChange =
          historicalDataItem.totalInvestment -
          historicalDataItems[index - 1].totalInvestment;

        if (investmentChange > 0) {
          investedCapital += investmentChange;
        }

        const investmentChangeWithCurrencyEffect =
          historicalDataItem.totalInvestmentValueWithCurrencyEffect -
          historicalDataItems[index - 1].totalInvestmentValueWithCurrencyEffect;

        if (investmentChangeWithCurrencyEffect > 0) {
          investedCapitalWithCurrencyEffect +=
            investmentChangeWithCurrencyEffect;
        }
      }

      performancePercentagesByDate[historicalDataItem.date] =
        this.getPerformancePercentagesOfHistoricalDataItem({
          historicalDataItem,
          investedCapital,
          investedCapitalWithCurrencyEffect
        });
    }

    return performancePercentagesByDate;
  }

  protected getHoldingPerformance({
    chartDates,
    dataSource,
    end,
    exchangeRates,
    marketSymbolMap,
    start,
    symbol
  }: {
    chartDates: string[];
    daysUntilNextChartDate: number[];
    end: Date;
    exchangeRates: { [dateString: string]: number };
    marketSymbolMap: {
      [date: string]: { [assetProfileIdentifier: string]: Big };
    };
    start: Date;
  } & AssetProfileIdentifier): HoldingPerformance {
    const { holdingPerformance, valuation } =
      this.getMethodIndependentHoldingPerformance({
        chartDates,
        dataSource,
        end,
        exchangeRates,
        marketSymbolMap,
        start,
        symbol
      });

    if (!valuation) {
      return holdingPerformance;
    }

    const {
      activities,
      currentValuesWithCurrencyEffect,
      dateRanges,
      daysInMarket,
      indexOfEndActivity,
      items
    } = valuation;

    let investedCapital = new Big(0);
    let investedCapitalWithCurrencyEffect = new Big(0);

    for (let i = 0; i <= indexOfEndActivity; i += 1) {
      const item = items[i];

      if (item.transactionInvestment.gt(0)) {
        investedCapital = investedCapital.plus(item.transactionInvestment);
        investedCapitalWithCurrencyEffect =
          investedCapitalWithCurrencyEffect.plus(
            item.transactionInvestmentWithCurrencyEffect
          );
      }
    }

    const {
      investmentValuesWithCurrencyEffect: legacyInvestmentValuesWithCurrencyEffect,
      investmentValuesAccumulated: legacyInvestmentValuesAccumulated,
      investmentValuesAccumulatedWithCurrencyEffect:
        legacyInvestmentValuesAccumulatedWithCurrencyEffect
    } = this.getLegacyInvestmentValues({
        activities,
        indexOfEndActivity
      });

    const netPerformancePercentageWithCurrencyEffectMap: {
      [key: DateRange]: Big;
    } = {};

    for (const { dateRange, endDateString, startDateString } of dateRanges) {
      const netPerformanceWithCurrencyEffect =
        holdingPerformance.netPerformanceValuesWithCurrencyEffect[
          endDateString
        ]?.minus(
          dateRange === 'max'
            ? this.ZERO
            : (holdingPerformance.netPerformanceValuesWithCurrencyEffect[
                startDateString
              ] ?? this.ZERO)
        ) ?? this.ZERO;

      let investmentBasis = (
        currentValuesWithCurrencyEffect[startDateString] ?? this.ZERO
      ).plus(
        (legacyInvestmentValuesAccumulatedWithCurrencyEffect[endDateString] ??
          this.ZERO)
          .minus(
            legacyInvestmentValuesAccumulatedWithCurrencyEffect[
              startDateString
            ] ?? this.ZERO
          )
      );

      if (!investmentBasis.gt(0)) {
        investmentBasis =
          legacyInvestmentValuesAccumulatedWithCurrencyEffect[endDateString] ??
          this.ZERO;
      }

      netPerformancePercentageWithCurrencyEffectMap[dateRange] =
        investmentBasis.gt(0)
          ? netPerformanceWithCurrencyEffect.div(investmentBasis)
          : this.ZERO;
    }

    return this.getHoldingPerformanceWithInvestedCapital({
      daysInMarket,
      holdingPerformance,
      investedCapital,
      investedCapitalByDateRange: {},
      investedCapitalValues: {},
      investedCapitalValuesWithCurrencyEffect: {},
      investmentValuesWithCurrencyEffect: legacyInvestmentValuesWithCurrencyEffect,
      investmentValuesAccumulated: legacyInvestmentValuesAccumulated,
      investmentValuesAccumulatedWithCurrencyEffect:
        legacyInvestmentValuesAccumulatedWithCurrencyEffect,
      investedCapitalWithCurrencyEffect,
      netPerformancePercentageWithCurrencyEffectMap
    });
  }

  protected getPerformanceCalculationType() {
    return PerformanceCalculationType.ROITWR;
  }

  private getInvestedCapitalByDate({
    accumulatedValuesByDate
  }: {
    accumulatedValuesByDate: { [date: string]: AccumulatedValues };
  }) {
    let investedCapital = new Big(0);
    let investedCapitalWithCurrencyEffect = new Big(0);
    let previousTotalInvestmentValue = new Big(0);
    let previousTotalInvestmentValueWithCurrencyEffect = new Big(0);

    const investedCapitalByDate: { [date: string]: InvestedCapital } = {};

    for (const [
      date,
      { totalInvestmentValue, totalInvestmentValueWithCurrencyEffect }
    ] of Object.entries(accumulatedValuesByDate)) {
      const investmentChange = totalInvestmentValue.minus(
        previousTotalInvestmentValue
      );

      if (investmentChange.gt(0)) {
        investedCapital = investedCapital.plus(investmentChange);
      }

      const investmentChangeWithCurrencyEffect =
        totalInvestmentValueWithCurrencyEffect.minus(
          previousTotalInvestmentValueWithCurrencyEffect
        );

      if (investmentChangeWithCurrencyEffect.gt(0)) {
        investedCapitalWithCurrencyEffect =
          investedCapitalWithCurrencyEffect.plus(
            investmentChangeWithCurrencyEffect
          );
      }

      previousTotalInvestmentValue = totalInvestmentValue;
      previousTotalInvestmentValueWithCurrencyEffect =
        totalInvestmentValueWithCurrencyEffect;

      investedCapitalByDate[date] = {
        investedCapital,
        investedCapitalWithCurrencyEffect
      };
    }

    return investedCapitalByDate;
  }

  private getLegacyInvestmentValues({
    activities,
    indexOfEndActivity
  }: {
    activities: HoldingPerformanceValuation['activities'];
    indexOfEndActivity: number;
  }) {
    const investmentValuesWithCurrencyEffect: {
      [date: string]: Big;
    } = {};

    const investmentValuesAccumulated: {
      [date: string]: Big;
    } = {};

    const investmentValuesAccumulatedWithCurrencyEffect: {
      [date: string]: Big;
    } = {};

    let totalUnits = this.ZERO;
    let totalInvestment = this.ZERO;
    let totalInvestmentWithCurrencyEffect = this.ZERO;

    for (let i = 0; i <= indexOfEndActivity; i += 1) {
      const activity = activities[i];

      if (activity.type === 'BUY') {
        investmentValuesWithCurrencyEffect[activity.date] = (
          investmentValuesWithCurrencyEffect[activity.date] ?? this.ZERO
        ).plus(
          activity.quantity.mul(
            activity.unitPriceInBaseCurrencyWithCurrencyEffect ?? this.ZERO
          )
        );

        totalInvestment = totalInvestment.plus(
          activity.quantity.mul(activity.unitPriceInBaseCurrency ?? this.ZERO)
        );

        totalInvestmentWithCurrencyEffect = totalInvestmentWithCurrencyEffect.plus(
          activity.quantity.mul(
            activity.unitPriceInBaseCurrencyWithCurrencyEffect ?? this.ZERO
          )
        );
      } else if (activity.type === 'SELL' && totalUnits.gt(0)) {
        investmentValuesWithCurrencyEffect[activity.date] = (
          investmentValuesWithCurrencyEffect[activity.date] ?? this.ZERO
        ).plus(
          activity.quantity
            .mul(
              activity.unitPriceInBaseCurrencyWithCurrencyEffect ?? this.ZERO
            )
            .mul(getFactor(activity.type))
        );

        totalInvestment = totalInvestment.plus(
          activity.quantity
            .mul(activity.unitPriceInBaseCurrency ?? this.ZERO)
            .mul(getFactor(activity.type))
        );

        totalInvestmentWithCurrencyEffect = totalInvestmentWithCurrencyEffect.plus(
          activity.quantity
            .mul(
              activity.unitPriceInBaseCurrencyWithCurrencyEffect ?? this.ZERO
            )
            .mul(getFactor(activity.type))
        );
      }

      totalUnits = totalUnits.plus(activity.quantity.mul(getFactor(activity.type)));

      if (totalUnits.eq(0)) {
        totalInvestment = this.ZERO;
        totalInvestmentWithCurrencyEffect = this.ZERO;
      } else if (totalInvestment.lt(0)) {
        totalInvestment = this.ZERO;
      } else if (totalInvestmentWithCurrencyEffect.lt(0)) {
        totalInvestmentWithCurrencyEffect = this.ZERO;
      }

      investmentValuesAccumulated[activity.date] = totalInvestment;
      investmentValuesAccumulatedWithCurrencyEffect[activity.date] =
        totalInvestmentWithCurrencyEffect;
    }

    return {
      investmentValuesWithCurrencyEffect,
      investmentValuesAccumulated,
      investmentValuesAccumulatedWithCurrencyEffect
    };
  }

  private getHoldingPerformanceWithInvestedCapital({
    holdingPerformance,
    investedCapital,
    investedCapitalValues,
    investedCapitalValuesWithCurrencyEffect,
    investmentValuesWithCurrencyEffect,
    investmentValuesAccumulated,
    investmentValuesAccumulatedWithCurrencyEffect,
    investedCapitalWithCurrencyEffect,
    netPerformancePercentageWithCurrencyEffectMap
  }: {
    daysInMarket: number;
    holdingPerformance: HoldingPerformance;
    investedCapital: Big;
    investedCapitalByDateRange: { [key: DateRange]: Big };
    investedCapitalValues: { [date: string]: Big };
    investedCapitalValuesWithCurrencyEffect: { [date: string]: Big };
    investmentValuesWithCurrencyEffect: { [date: string]: Big };
    investmentValuesAccumulated: { [date: string]: Big };
    investmentValuesAccumulatedWithCurrencyEffect: { [date: string]: Big };
    investedCapitalWithCurrencyEffect: Big;
    netPerformancePercentageWithCurrencyEffectMap: { [key: DateRange]: Big };
  }): HoldingPerformance {
    const result = { ...holdingPerformance };

    for (const [date, value] of Object.entries(investedCapitalValues)) {
      result.averageInvestmentValues[date] = value;
    }

    for (const [date, value] of Object.entries(investedCapitalValuesWithCurrencyEffect)) {
      result.averageInvestmentValuesWithCurrencyEffect[date] = value;
    }

    result.investmentValuesAccumulated = investmentValuesAccumulated;
    result.investmentValuesAccumulatedWithCurrencyEffect =
      investmentValuesAccumulatedWithCurrencyEffect;
    result.investmentValuesWithCurrencyEffect =
      investmentValuesWithCurrencyEffect;

    result.averageInvestment = investedCapital;
    result.averageInvestmentWithCurrencyEffect = investedCapitalWithCurrencyEffect;
    result.netPerformancePercentage = investedCapital.gt(0)
      ? result.netPerformance.div(investedCapital)
      : this.ZERO;
    result.grossPerformancePercentage = investedCapital.gt(0)
      ? result.grossPerformance.div(investedCapital)
      : this.ZERO;
    result.grossPerformancePercentageWithCurrencyEffect =
      investedCapitalWithCurrencyEffect.gt(0)
        ? result.grossPerformanceWithCurrencyEffect.div(
            investedCapitalWithCurrencyEffect
          )
        : this.ZERO;
    result.netPerformancePercentageWithCurrencyEffectMap =
      netPerformancePercentageWithCurrencyEffectMap;

    return result;
  }
}
