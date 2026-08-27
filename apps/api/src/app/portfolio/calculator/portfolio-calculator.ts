import { CurrentRateService } from '@ghostfolio/api/app/portfolio/current-rate.service';
import { PortfolioSnapshotComputationError } from '@ghostfolio/api/app/portfolio/errors/portfolio-snapshot-computation.error';
import { PortfolioCalculatorPosition } from '@ghostfolio/api/app/portfolio/interfaces/portfolio-calculator-position.interface';
import { PortfolioOrder } from '@ghostfolio/api/app/portfolio/interfaces/portfolio-order.interface';
import { PortfolioSnapshotValue } from '@ghostfolio/api/app/portfolio/interfaces/snapshot-value.interface';
import { TransactionPointSymbol } from '@ghostfolio/api/app/portfolio/interfaces/transaction-point-symbol.interface';
import { TransactionPoint } from '@ghostfolio/api/app/portfolio/interfaces/transaction-point.interface';
import { RedisCacheService } from '@ghostfolio/api/app/redis-cache/redis-cache.service';
import { getFactor } from '@ghostfolio/api/helper/portfolio.helper';
import { LogPerformance } from '@ghostfolio/api/interceptors/performance-logging/performance-logging.interceptor';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { ExchangeRateDataService } from '@ghostfolio/api/services/exchange-rate-data/exchange-rate-data.service';
import { DataGatheringItem } from '@ghostfolio/api/services/interfaces/interfaces';
import { PortfolioSnapshotService } from '@ghostfolio/api/services/queues/portfolio-snapshot/portfolio-snapshot.service';
import { getIntervalFromDateRange } from '@ghostfolio/common/calculation-helper';
import {
  INVESTMENT_ACTIVITY_TYPES,
  PORTFOLIO_SNAPSHOT_PROCESS_JOB_NAME,
  PORTFOLIO_SNAPSHOT_PROCESS_JOB_OPTIONS,
  PORTFOLIO_SNAPSHOT_COMPUTATION_QUEUE_PRIORITY_HIGH,
  PORTFOLIO_SNAPSHOT_COMPUTATION_QUEUE_PRIORITY_LOW,
  DATE_RANGES
} from '@ghostfolio/common/config';
import {
  DATE_FORMAT,
  getSum,
  parseDate,
  resetHours
} from '@ghostfolio/common/helper';
import {
  Activity,
  AssetProfileIdentifier,
  DataProviderInfo,
  Filter,
  HistoricalDataItem,
  InvestmentItem,
  ResponseError,
  SymbolMetrics
} from '@ghostfolio/common/interfaces';
import { PortfolioSnapshot } from '@ghostfolio/common/models';
import { GroupBy } from '@ghostfolio/common/types';
import { PerformanceCalculationType } from '@ghostfolio/common/types/performance-calculation-type.type';

import { Logger } from '@nestjs/common';
import { AssetSubClass } from '@prisma/client';
import { Big } from 'big.js';
import { plainToClass } from 'class-transformer';
import {
  addDays,
  differenceInDays,
  eachDayOfInterval,
  eachYearOfInterval,
  endOfDay,
  endOfYear,
  format,
  isAfter,
  isBefore,
  isFuture,
  isPast,
  isWithinInterval,
  min,
  startOfDay,
  startOfYear,
  subDays
} from 'date-fns';
import { groupBy, isNumber, sortBy, sum, uniqBy } from 'lodash';

import { ActivitiesService } from '../../activities/activities.service';

export abstract class PortfolioCalculator {
  protected static readonly ENABLE_LOGGING = false;

  private static readonly MAX_INITIALIZATION_ATTEMPTS = 3;

  protected readonly ONE = new Big(1);
  protected readonly ZERO = new Big(0);

  protected readonly logger = new Logger(PortfolioCalculator.name);

  protected accountBalanceItems: HistoricalDataItem[];
  protected activities: PortfolioOrder[];
  protected activitiesBySymbol: {
    [symbol: string]: PortfolioOrder[];
  };

  protected configurationService: ConfigurationService;
  protected currency: string;
  protected currentRateService: CurrentRateService;
  protected exchangeRateDataService: ExchangeRateDataService;
  protected activitiesService: ActivitiesService;
  protected snapshot: PortfolioSnapshot;
  protected snapshotPromise: Promise<void>;
  protected userId: string;
  protected marketMap: { [date: string]: { [symbol: string]: Big } } = {};
  private dataProviderInfos: DataProviderInfo[];
  private endDate: Date;
  private filters: Filter[];
  private portfolioSnapshotService: PortfolioSnapshotService;
  private redisCacheService: RedisCacheService;
  private startDate: Date;
  private transactionPoints: TransactionPoint[];
  private holdings: { [date: string]: { [symbol: string]: Big } } = {};
  private holdingCurrencies: { [symbol: string]: string } = {};
  private chartDateMap: { [date: string]: boolean } = {};

  public constructor({
    accountBalanceItems,
    activities,
    configurationService,
    currency,
    currentRateService,
    exchangeRateDataService,
    filters,
    portfolioSnapshotService,
    redisCacheService,
    userId,
    activitiesService
  }: {
    accountBalanceItems: HistoricalDataItem[];
    activities: Activity[];
    configurationService: ConfigurationService;
    currency: string;
    currentRateService: CurrentRateService;
    exchangeRateDataService: ExchangeRateDataService;
    filters: Filter[];
    portfolioSnapshotService: PortfolioSnapshotService;
    redisCacheService: RedisCacheService;
    userId: string;
    activitiesService: ActivitiesService;
  }) {
    this.accountBalanceItems = accountBalanceItems;
    this.configurationService = configurationService;
    this.currency = currency;
    this.currentRateService = currentRateService;
    this.exchangeRateDataService = exchangeRateDataService;
    this.filters = filters;
    this.activitiesService = activitiesService;

    let dateOfFirstActivity = new Date();

    if (this.accountBalanceItems[0]) {
      dateOfFirstActivity = parseDate(this.accountBalanceItems[0].date);
    }

    this.activities = activities
      .map(
        ({
          assetProfile,
          date,
          feeInAssetProfileCurrency,
          feeInBaseCurrency,
          quantity,
          tags = [],
          type,
          unitPriceInAssetProfileCurrency
        }) => {
          if (isBefore(date, dateOfFirstActivity)) {
            dateOfFirstActivity = date;
          }

          if (isFuture(date)) {
            // Adapt date to today if activity is in future (e.g. liability)
            // to include it in the interval
            date = endOfDay(new Date());
          }

          return {
            assetProfile,
            tags,
            type,
            date: format(date, DATE_FORMAT),
            fee: new Big(feeInAssetProfileCurrency),
            feeInBaseCurrency: new Big(feeInBaseCurrency),
            quantity: new Big(quantity),
            unitPrice: new Big(unitPriceInAssetProfileCurrency)
          };
        }
      )
      .sort((a, b) => {
        return a.date?.localeCompare(b.date);
      });

    this.activitiesBySymbol = groupBy(this.activities, ({ assetProfile }) => {
      return assetProfile.symbol;
    });

    this.portfolioSnapshotService = portfolioSnapshotService;
    this.redisCacheService = redisCacheService;
    this.userId = userId;

    const { endDate, startDate } = getIntervalFromDateRange({
      dateRange: 'max',
      startDate: subDays(dateOfFirstActivity, 1)
    });

    this.endDate = endOfDay(endDate);
    this.startDate = startOfDay(startDate);

    this.computeTransactionPoints();

    this.snapshotPromise = this.initialize();

    // Mark the rejection as handled to prevent an unhandled promise rejection
    // in case the snapshot promise is never awaited. Consumers awaiting it
    // still receive the error.
    this.snapshotPromise.catch(() => undefined);
  }

  protected abstract calculateOverallPerformance(
    positions: PortfolioCalculatorPosition[]
  ): PortfolioSnapshot;

  @LogPerformance
  public async computeSnapshot(): Promise<PortfolioSnapshot> {
    const lastTransactionPoint = this.transactionPoints.at(-1);

    const transactionPoints = this.transactionPoints?.filter(({ date }) => {
      return isBefore(parseDate(date), this.endDate);
    });

    if (!transactionPoints.length) {
      return {
        activitiesCount: 0,
        createdAt: new Date(),
        currentValueInBaseCurrency: this.ZERO,
        errors: [],
        hasErrors: false,
        historicalData: [],
        positions: [],
        totalCashInBaseCurrency: this.ZERO,
        totalFeesWithCurrencyEffect: this.ZERO,
        totalInterestWithCurrencyEffect: this.ZERO,
        totalInvestment: this.ZERO,
        totalInvestmentWithCurrencyEffect: this.ZERO,
        totalLiabilitiesWithCurrencyEffect: this.ZERO
      };
    }

    const cashSymbols = new Set<string>();
    const currencies: { [symbol: string]: string } = {};
    const dataGatheringItems: DataGatheringItem[] = [];
    let firstIndex = transactionPoints.length;
    let firstTransactionPoint: TransactionPoint = null;
    let totalCashInBaseCurrency = this.ZERO;
    let totalInterestWithCurrencyEffect = this.ZERO;
    let totalLiabilitiesWithCurrencyEffect = this.ZERO;

    for (const {
      assetSubClass,
      currency,
      dataSource,
      symbol
    } of transactionPoints[firstIndex - 1].items) {
      // Gather data for all assets except CASH
      if (assetSubClass !== 'CASH') {
        dataGatheringItems.push({
          dataSource,
          symbol
        });
      }

      currencies[symbol] = currency;
    }

    for (let i = 0; i < transactionPoints.length; i++) {
      if (
        !isBefore(parseDate(transactionPoints[i].date), this.startDate) &&
        firstTransactionPoint === null
      ) {
        firstTransactionPoint = transactionPoints[i];
        firstIndex = i;
      }
    }

    const exchangeRatesByCurrency =
      await this.exchangeRateDataService.getExchangeRatesByCurrency({
        currencies: Array.from(new Set(Object.values(currencies))),
        endDate: this.endDate,
        startDate: this.startDate,
        targetCurrency: this.currency
      });

    const {
      dataProviderInfos,
      errors: currentRateErrors,
      values: marketSymbols
    } = await this.currentRateService.getValues({
      dataGatheringItems,
      dateQuery: { gte: this.startDate, lt: this.endDate }
    });

    this.dataProviderInfos = dataProviderInfos;

    const marketSymbolMap: { [date: string]: { [symbol: string]: Big } } = {};

    for (const marketSymbol of marketSymbols) {
      const date = format(marketSymbol.date, DATE_FORMAT);

      if (!marketSymbolMap[date]) {
        marketSymbolMap[date] = {};
      }

      if (marketSymbol.marketPrice) {
        marketSymbolMap[date][marketSymbol.symbol] = new Big(
          marketSymbol.marketPrice
        );
      }
    }

    const endDateString = format(this.endDate, DATE_FORMAT);

    const daysInMarket = differenceInDays(this.endDate, this.startDate);

    this.chartDateMap = this.getChartDateMap({
      endDate: this.endDate,
      startDate: this.startDate,
      step: Math.round(
        daysInMarket /
          Math.min(
            daysInMarket,
            this.configurationService.get('MAX_CHART_ITEMS')
          )
      )
    });

    for (const accountBalanceItem of this.accountBalanceItems) {
      this.chartDateMap[accountBalanceItem.date] = true;
    }

    const chartDates = sortBy(Object.keys(this.chartDateMap), (chartDate) => {
      return chartDate;
    });

    if (firstIndex > 0) {
      firstIndex--;
    }

    const errors: ResponseError['errors'] = [];
    let hasAnySymbolMetricsErrors = false;

    const positions: PortfolioCalculatorPosition[] = [];

    const accumulatedValuesByDate: {
      [date: string]: {
        investmentValueWithCurrencyEffect: Big;
        totalCashValueWithCurrencyEffect: Big;
        totalCurrentValue: Big;
        totalCurrentValueWithCurrencyEffect: Big;
        totalInvestmentValue: Big;
        totalInvestmentValueWithCurrencyEffect: Big;
        totalNetPerformanceValue: Big;
        totalNetPerformanceValueWithCurrencyEffect: Big;
        totalNetWorthValueWithCurrencyEffect: Big;
        totalTimeWeightedInvestmentValue: Big;
        totalTimeWeightedInvestmentValueWithCurrencyEffect: Big;
      };
    } = {};

    const valuesBySymbol: {
      [symbol: string]: {
        currentValues: { [date: string]: Big };
        currentValuesWithCurrencyEffect: { [date: string]: Big };
        investmentValuesAccumulated: { [date: string]: Big };
        investmentValuesAccumulatedWithCurrencyEffect: { [date: string]: Big };
        investmentValuesWithCurrencyEffect: { [date: string]: Big };
        netPerformanceValues: { [date: string]: Big };
        netPerformanceValuesWithCurrencyEffect: { [date: string]: Big };
        netWorthValuesWithCurrencyEffect: { [date: string]: Big };
        timeWeightedInvestmentValues: { [date: string]: Big };
        timeWeightedInvestmentValuesWithCurrencyEffect: { [date: string]: Big };
      };
    } = {};

    for (const item of lastTransactionPoint.items) {
      const marketPriceInBaseCurrency = (
        marketSymbolMap[endDateString]?.[item.symbol] ?? item.averagePrice
      ).mul(
        exchangeRatesByCurrency[`${item.currency}${this.currency}`]?.[
          endDateString
        ] ?? 1
      );

      const valueInBaseCurrency = marketPriceInBaseCurrency.mul(item.quantity);

      const isCashInBaseCurrency =
        item.assetSubClass === AssetSubClass.CASH &&
        item.currency === this.currency &&
        item.symbol === this.currency;

      const {
        currentValues,
        currentValuesWithCurrencyEffect,
        grossPerformance,
        grossPerformancePercentage,
        grossPerformancePercentageWithCurrencyEffect,
        grossPerformanceWithCurrencyEffect,
        hasErrors,
        investmentValuesAccumulated,
        investmentValuesAccumulatedWithCurrencyEffect,
        investmentValuesWithCurrencyEffect,
        netPerformance,
        netPerformancePercentage,
        netPerformancePercentageWithCurrencyEffectMap,
        netPerformanceValues,
        netPerformanceValuesWithCurrencyEffect,
        netPerformanceWithCurrencyEffectMap,
        timeWeightedInvestment,
        timeWeightedInvestmentValues,
        timeWeightedInvestmentValuesWithCurrencyEffect,
        timeWeightedInvestmentWithCurrencyEffect,
        totalDividend,
        totalDividendInBaseCurrency,
        totalInterestInBaseCurrency,
        totalInvestment,
        totalInvestmentWithCurrencyEffect,
        totalLiabilitiesInBaseCurrency
      } = this.getSymbolMetrics({
        chartDateMap: this.chartDateMap,
        marketSymbolMap,
        dataSource: item.dataSource,
        end: this.endDate,
        exchangeRates:
          exchangeRatesByCurrency[`${item.currency}${this.currency}`],
        start: this.startDate,
        symbol: item.symbol
      });

      hasAnySymbolMetricsErrors = hasAnySymbolMetricsErrors || hasErrors;

      // Cash in the base currency cannot generate a currency effect and thus
      // contributes nothing but its balance to the performance calculation. It
      // is therefore excluded from the value and the investment, while still
      // contributing to the net worth.
      valuesBySymbol[item.symbol] = isCashInBaseCurrency
        ? {
            currentValues: {},
            currentValuesWithCurrencyEffect: {},
            investmentValuesAccumulated: {},
            investmentValuesAccumulatedWithCurrencyEffect: {},
            investmentValuesWithCurrencyEffect: {},
            netPerformanceValues: {},
            netPerformanceValuesWithCurrencyEffect: {},
            netWorthValuesWithCurrencyEffect: currentValuesWithCurrencyEffect,
            timeWeightedInvestmentValues: {},
            timeWeightedInvestmentValuesWithCurrencyEffect: {}
          }
        : {
            currentValues,
            currentValuesWithCurrencyEffect,
            investmentValuesAccumulated,
            investmentValuesAccumulatedWithCurrencyEffect,
            investmentValuesWithCurrencyEffect,
            netPerformanceValues,
            netPerformanceValuesWithCurrencyEffect,
            timeWeightedInvestmentValues,
            timeWeightedInvestmentValuesWithCurrencyEffect,
            netWorthValuesWithCurrencyEffect: currentValuesWithCurrencyEffect
          };

      positions.push({
        timeWeightedInvestment,
        timeWeightedInvestmentWithCurrencyEffect,
        activitiesCount: item.activitiesCount,
        averagePrice: item.averagePrice,
        currency: item.currency,
        dataSource: item.dataSource,
        dateOfFirstActivity: item.dateOfFirstActivity,
        dividend: totalDividend,
        dividendInBaseCurrency: totalDividendInBaseCurrency,
        fee: item.fee,
        feeInBaseCurrency: item.feeInBaseCurrency,
        grossPerformance: !hasErrors ? (grossPerformance ?? null) : null,
        grossPerformancePercentage: !hasErrors
          ? (grossPerformancePercentage ?? null)
          : null,
        grossPerformancePercentageWithCurrencyEffect: !hasErrors
          ? (grossPerformancePercentageWithCurrencyEffect ?? null)
          : null,
        grossPerformanceWithCurrencyEffect: !hasErrors
          ? (grossPerformanceWithCurrencyEffect ?? null)
          : null,
        includeInHoldings: item.includeInHoldings,
        includeInPerformance: !isCashInBaseCurrency,
        investment: totalInvestment,
        investmentWithCurrencyEffect: totalInvestmentWithCurrencyEffect,
        marketPrice:
          marketSymbolMap[endDateString]?.[item.symbol]?.toNumber() ?? 1,
        marketPriceInBaseCurrency: marketPriceInBaseCurrency?.toNumber() ?? 1,
        netPerformance: !hasErrors ? (netPerformance ?? null) : null,
        netPerformancePercentage: !hasErrors
          ? (netPerformancePercentage ?? null)
          : null,
        netPerformancePercentageWithCurrencyEffectMap: !hasErrors
          ? (netPerformancePercentageWithCurrencyEffectMap ?? null)
          : null,
        netPerformanceWithCurrencyEffectMap: !hasErrors
          ? (netPerformanceWithCurrencyEffectMap ?? null)
          : null,
        quantity: item.quantity,
        symbol: item.symbol,
        tags: item.tags,
        valueInBaseCurrency
      });

      if (item.assetSubClass === AssetSubClass.CASH) {
        cashSymbols.add(item.symbol);

        totalCashInBaseCurrency =
          totalCashInBaseCurrency.plus(valueInBaseCurrency);
      }

      totalInterestWithCurrencyEffect = totalInterestWithCurrencyEffect.plus(
        totalInterestInBaseCurrency
      );

      totalLiabilitiesWithCurrencyEffect =
        totalLiabilitiesWithCurrencyEffect.plus(totalLiabilitiesInBaseCurrency);

      if (
        (hasErrors ||
          currentRateErrors.find(({ dataSource, symbol }) => {
            return dataSource === item.dataSource && symbol === item.symbol;
          })) &&
        item.investment.gt(0) &&
        item.skipErrors === false
      ) {
        errors.push({ dataSource: item.dataSource, symbol: item.symbol });
      }
    }

    for (const dateString of chartDates) {
      let investmentValueWithCurrencyEffect = this.ZERO;
      let totalCashValueWithCurrencyEffect = this.ZERO;
      let totalCurrentValue = this.ZERO;
      let totalCurrentValueWithCurrencyEffect = this.ZERO;
      let totalInvestmentValue = this.ZERO;
      let totalInvestmentValueWithCurrencyEffect = this.ZERO;
      let totalNetPerformanceValue = this.ZERO;
      let totalNetPerformanceValueWithCurrencyEffect = this.ZERO;
      let totalNetWorthValueWithCurrencyEffect = this.ZERO;
      let totalTimeWeightedInvestmentValue = this.ZERO;
      let totalTimeWeightedInvestmentValueWithCurrencyEffect = this.ZERO;

      for (const symbol of Object.keys(valuesBySymbol)) {
        const symbolValues = valuesBySymbol[symbol];

        const currentValue =
          symbolValues.currentValues?.[dateString] ?? this.ZERO;
        const currentValueWithCurrencyEffect =
          symbolValues.currentValuesWithCurrencyEffect?.[dateString] ??
          this.ZERO;
        const investmentValueAccumulated =
          symbolValues.investmentValuesAccumulated?.[dateString] ?? this.ZERO;
        const investmentValueAccumulatedWithCurrencyEffect =
          symbolValues.investmentValuesAccumulatedWithCurrencyEffect?.[
            dateString
          ] ?? this.ZERO;
        const investmentValueWithCurrencyEffectForSymbol =
          symbolValues.investmentValuesWithCurrencyEffect?.[dateString] ??
          this.ZERO;
        const netPerformanceValue =
          symbolValues.netPerformanceValues?.[dateString] ?? this.ZERO;
        const netPerformanceValueWithCurrencyEffect =
          symbolValues.netPerformanceValuesWithCurrencyEffect?.[dateString] ??
          this.ZERO;
        const netWorthValueWithCurrencyEffect =
          symbolValues.netWorthValuesWithCurrencyEffect?.[dateString] ??
          this.ZERO;
        const timeWeightedInvestmentValue =
          symbolValues.timeWeightedInvestmentValues?.[dateString] ?? this.ZERO;
        const timeWeightedInvestmentValueWithCurrencyEffect =
          symbolValues.timeWeightedInvestmentValuesWithCurrencyEffect?.[
            dateString
          ] ?? this.ZERO;

        investmentValueWithCurrencyEffect =
          investmentValueWithCurrencyEffect.add(
            investmentValueWithCurrencyEffectForSymbol
          );
        totalCashValueWithCurrencyEffect = totalCashValueWithCurrencyEffect.add(
          cashSymbols.has(symbol) ? netWorthValueWithCurrencyEffect : this.ZERO
        );
        totalCurrentValue = totalCurrentValue.add(currentValue);
        totalCurrentValueWithCurrencyEffect =
          totalCurrentValueWithCurrencyEffect.add(
            currentValueWithCurrencyEffect
          );
        totalInvestmentValue = totalInvestmentValue.add(
          investmentValueAccumulated
        );
        totalInvestmentValueWithCurrencyEffect =
          totalInvestmentValueWithCurrencyEffect.add(
            investmentValueAccumulatedWithCurrencyEffect
          );
        totalNetPerformanceValue =
          totalNetPerformanceValue.add(netPerformanceValue);
        totalNetPerformanceValueWithCurrencyEffect =
          totalNetPerformanceValueWithCurrencyEffect.add(
            netPerformanceValueWithCurrencyEffect
          );
        totalNetWorthValueWithCurrencyEffect =
          totalNetWorthValueWithCurrencyEffect.add(
            netWorthValueWithCurrencyEffect
          );
        totalTimeWeightedInvestmentValue = totalTimeWeightedInvestmentValue.add(
          timeWeightedInvestmentValue
        );
        totalTimeWeightedInvestmentValueWithCurrencyEffect =
          totalTimeWeightedInvestmentValueWithCurrencyEffect.add(
            timeWeightedInvestmentValueWithCurrencyEffect
          );
      }

      accumulatedValuesByDate[dateString] = {
        investmentValueWithCurrencyEffect,
        totalCashValueWithCurrencyEffect,
        totalCurrentValue,
        totalCurrentValueWithCurrencyEffect,
        totalInvestmentValue,
        totalInvestmentValueWithCurrencyEffect,
        totalNetPerformanceValue,
        totalNetPerformanceValueWithCurrencyEffect,
        totalNetWorthValueWithCurrencyEffect,
        totalTimeWeightedInvestmentValue,
        totalTimeWeightedInvestmentValueWithCurrencyEffect
      };
    }

    const historicalData: HistoricalDataItem[] = this.getHistoricalDataItems(
      accumulatedValuesByDate
    );

    const overall = this.calculateOverallPerformance(positions);

    const positionsIncludedInHoldings = positions
      .filter(({ includeInHoldings }) => {
        return includeInHoldings;
      })
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .map(({ includeInHoldings, includeInPerformance, ...rest }) => {
        return rest;
      });

    return {
      ...overall,
      errors,
      historicalData,
      totalCashInBaseCurrency,
      totalInterestWithCurrencyEffect,
      totalLiabilitiesWithCurrencyEffect,
      hasErrors: hasAnySymbolMetricsErrors || overall.hasErrors,
      positions: positionsIncludedInHoldings
    };
  }

  @LogPerformance
  public async getUnfilteredNetWorth(currency: string): Promise<Big> {
    const activities = await this.activitiesService.getActivities({
      userId: this.userId,
      userCurrency: currency,
      types: ['BUY', 'SELL', 'STAKE'],
      withExcludedAccountsAndActivities: true
    });
    const orders = this.activitiesToPortfolioOrder(activities.activities);
    const activitiesBySymbol = groupBy(orders, ({ assetProfile }) => {
      return assetProfile.symbol;
    });
    const start = orders.reduce(
      (date, order) =>
        parseDate(date.date).getTime() < parseDate(order.date).getTime()
          ? date
          : order,
      { date: orders[0].date }
    ).date;

    const end = new Date(Date.now());

    const holdings = await this.getHoldings(orders, parseDate(start), end);
    const marketMap = await this.currentRateService.getValues({
      dataGatheringItems: this.mapToDataGatheringItems(orders),
      dateQuery: { in: [end] }
    });
    const endString = format(end, DATE_FORMAT);

    const exchangeRates = await Promise.all(
      Object.keys(holdings[endString]).map(async (holding) => {
        const symbolCurrency = this.getCurrencyFromActivities(
          activitiesBySymbol,
          holding
        );
        const exchangeRate =
          await this.exchangeRateDataService.toCurrencyAtDate(
            1,
            symbolCurrency,
            this.currency,
            end
          );
        return { symbolCurrency, exchangeRate };
      })
    );
    const currencyRates = exchangeRates.reduce<{ [currency: string]: number }>(
      (all, currency): { [currency: string]: number } => {
        all[currency.symbolCurrency] ??= currency.exchangeRate;
        return all;
      },
      {}
    );

    return Object.keys(holdings[endString]).reduce((sum, holding) => {
      if (!holdings[endString][holding].toNumber()) {
        return sum;
      }
      const symbol = marketMap.values.find((m) => m.symbol === holding);

      if (symbol?.marketPrice === undefined) {
        Logger.warn(
          `Missing historical market data for ${holding} (${end})`,
          'PortfolioCalculator'
        );
        return sum;
      } else {
        const symbolCurrency = this.getCurrency(holding);
        const price = new Big(currencyRates[symbolCurrency]).mul(
          symbol.marketPrice
        );
        return sum.plus(new Big(price).mul(holdings[endString][holding]));
      }
    }, this.ZERO);
  }

  @LogPerformance
  public getDataProviderInfos() {
    return this.dataProviderInfos;
  }

  @LogPerformance
  public async getDividendInBaseCurrency() {
    await this.snapshotPromise;

    return getSum(
      this.snapshot.positions.map(({ dividendInBaseCurrency }) => {
        return dividendInBaseCurrency;
      })
    );
  }

  @LogPerformance
  public async getFeesInBaseCurrency() {
    await this.snapshotPromise;

    return this.snapshot.totalFeesWithCurrencyEffect;
  }

  @LogPerformance
  public async getInterestInBaseCurrency() {
    await this.snapshotPromise;

    return this.snapshot.totalInterestWithCurrencyEffect;
  }

  @LogPerformance
  public getInvestments(): { date: string; investment: Big }[] {
    if (this.transactionPoints.length === 0) {
      return [];
    }

    return this.transactionPoints.map((transactionPoint) => {
      return {
        date: transactionPoint.date,
        investment: transactionPoint.items.reduce(
          (investment, transactionPointSymbol) =>
            investment.plus(transactionPointSymbol.investment),
          this.ZERO
        )
      };
    });
  }

  @LogPerformance
  public getInvestmentsByGroup({
    data,
    groupBy
  }: {
    data: HistoricalDataItem[];
    groupBy: GroupBy;
  }): InvestmentItem[] {
    const groupedData: { [dateGroup: string]: Big } = {};

    for (const { date, investmentValueWithCurrencyEffect } of data) {
      const dateGroup =
        groupBy === 'month' ? date.substring(0, 7) : date.substring(0, 4);
      groupedData[dateGroup] = (groupedData[dateGroup] ?? this.ZERO).plus(
        investmentValueWithCurrencyEffect
      );
    }

    return Object.keys(groupedData).map((dateGroup) => ({
      date: groupBy === 'month' ? `${dateGroup}-01` : `${dateGroup}-01-01`,
      investment: groupedData[dateGroup].toNumber()
    }));
  }

  @LogPerformance
  public async getLiabilitiesInBaseCurrency() {
    await this.snapshotPromise;

    return this.snapshot.totalLiabilitiesWithCurrencyEffect;
  }

  @LogPerformance
  public async getPerformance({ end, start }): Promise<{
    chart: HistoricalDataItem[];
    netPerformance: number;
    netPerformanceInPercentage: number;
    netPerformanceWithCurrencyEffect: number;
    netPerformanceInPercentageWithCurrencyEffect: number;
    netWorth: number;
    totalInvestment: number;
    totalInvestmentValueWithCurrencyEffect: number;
    valueWithCurrencyEffect: number;
  }> {
    await this.snapshotPromise;

    const { historicalData } = this.snapshot;

    const chart: HistoricalDataItem[] = [];

    let netPerformanceAtStartDate: number;
    let netPerformanceWithCurrencyEffectAtStartDate: number;
    let lastTimeWeightedPerformancePercentage: number;
    let lastTimeWeightedPerformancePercentageWithCurrencyEffect: number;
    let timeWeightedPerformanceInPercentage: number;
    let timeWeightedPerformanceInPercentageWithCurrencyEffect: number;
    const totalInvestmentValuesWithCurrencyEffect: number[] = [];

    for (const historicalDataItem of historicalData) {
      const date = resetHours(parseDate(historicalDataItem.date));

      if (!isBefore(date, start) && !isAfter(date, end)) {
        if (!isNumber(netPerformanceAtStartDate)) {
          netPerformanceAtStartDate = historicalDataItem.netPerformance;

          netPerformanceWithCurrencyEffectAtStartDate =
            historicalDataItem.netPerformanceWithCurrencyEffect;
        }

        const netPerformanceSinceStartDate =
          historicalDataItem.netPerformance - netPerformanceAtStartDate;

        const netPerformanceWithCurrencyEffectSinceStartDate =
          historicalDataItem.netPerformanceWithCurrencyEffect -
          netPerformanceWithCurrencyEffectAtStartDate;

        if (historicalDataItem.totalInvestmentValueWithCurrencyEffect > 0) {
          totalInvestmentValuesWithCurrencyEffect.push(
            historicalDataItem.totalInvestmentValueWithCurrencyEffect
          );
        }

        const timeWeightedInvestmentValue =
          totalInvestmentValuesWithCurrencyEffect.length > 0
            ? sum(totalInvestmentValuesWithCurrencyEffect) /
              totalInvestmentValuesWithCurrencyEffect.length
            : 0;

        ({
          timeWeightedPerformanceInPercentage,
          timeWeightedPerformanceInPercentageWithCurrencyEffect,
          lastTimeWeightedPerformancePercentage,
          lastTimeWeightedPerformancePercentageWithCurrencyEffect
        } = this.calculateTimeWeightedPerformance(
          lastTimeWeightedPerformancePercentage,
          historicalDataItem,
          lastTimeWeightedPerformancePercentageWithCurrencyEffect,
          timeWeightedPerformanceInPercentage,
          timeWeightedPerformanceInPercentageWithCurrencyEffect
        ));

        chart.push({
          ...historicalDataItem,
          netPerformance:
            historicalDataItem.netPerformance - netPerformanceAtStartDate,
          netPerformanceWithCurrencyEffect:
            netPerformanceWithCurrencyEffectSinceStartDate,
          netPerformanceInPercentage:
            timeWeightedInvestmentValue === 0
              ? 0
              : netPerformanceSinceStartDate / timeWeightedInvestmentValue,
          netPerformanceInPercentageWithCurrencyEffect:
            timeWeightedInvestmentValue === 0
              ? 0
              : netPerformanceWithCurrencyEffectSinceStartDate /
                timeWeightedInvestmentValue,
          timeWeightedPerformanceInPercentage,
          timeWeightedPerformanceInPercentageWithCurrencyEffect
        });
      }
    }

    const last = chart.at(-1);

    return {
      chart,
      netPerformance: last?.netPerformance ?? 0,
      netPerformanceInPercentage: last?.netPerformanceInPercentage ?? 0,
      netPerformanceWithCurrencyEffect:
        last?.netPerformanceWithCurrencyEffect ?? 0,
      netPerformanceInPercentageWithCurrencyEffect:
        last?.netPerformanceInPercentageWithCurrencyEffect ?? 0,
      netWorth: last?.netWorth ?? 0,
      totalInvestment: last?.totalInvestment ?? 0,
      valueWithCurrencyEffect: last?.valueWithCurrencyEffect ?? 0,
      totalInvestmentValueWithCurrencyEffect:
        last?.totalInvestmentValueWithCurrencyEffect ?? 0
    };
  }

  @LogPerformance
  protected getHistoricalDataItems(accumulatedValuesByDate: {
    [date: string]: {
      investmentValueWithCurrencyEffect: Big;
      totalCashValueWithCurrencyEffect: Big;
      totalCurrentValue: Big;
      totalCurrentValueWithCurrencyEffect: Big;
      totalInvestmentValue: Big;
      totalInvestmentValueWithCurrencyEffect: Big;
      totalNetPerformanceValue: Big;
      totalNetPerformanceValueWithCurrencyEffect: Big;
      totalTimeWeightedInvestmentValue: Big;
      totalTimeWeightedInvestmentValueWithCurrencyEffect: Big;
      totalNetWorthValueWithCurrencyEffect: Big;
    };
  }): HistoricalDataItem[] {
    let previousDateString = '';
    let timeWeightedPerformancePreviousPeriod = this.ZERO;
    let timeWeightedPerformancePreviousPeriodWithCurrencyEffect = this.ZERO;
    return Object.entries(accumulatedValuesByDate).map(([date, values]) => {
      const {
        investmentValueWithCurrencyEffect,
        totalCurrentValue,
        totalCurrentValueWithCurrencyEffect,
        totalInvestmentValue,
        totalInvestmentValueWithCurrencyEffect,
        totalNetPerformanceValue,
        totalNetPerformanceValueWithCurrencyEffect,
        totalTimeWeightedInvestmentValue,
        totalTimeWeightedInvestmentValueWithCurrencyEffect,
        totalCashValueWithCurrencyEffect,
        totalNetWorthValueWithCurrencyEffect
      } = values;

      const netPerformanceInPercentage = totalTimeWeightedInvestmentValue.eq(0)
        ? 0
        : totalNetPerformanceValue
            .div(totalTimeWeightedInvestmentValue)
            .toNumber();

      const netPerformanceInPercentageWithCurrencyEffect =
        totalTimeWeightedInvestmentValueWithCurrencyEffect.eq(0)
          ? 0
          : totalNetPerformanceValueWithCurrencyEffect
              .div(totalTimeWeightedInvestmentValueWithCurrencyEffect)
              .toNumber();

      let timeWeightedPerformanceInPercentage: number;
      let timeWeightedPerformanceInPercentageWithCurrencyEffect: number;
      ({
        timeWeightedPerformanceInPercentage,
        timeWeightedPerformanceInPercentageWithCurrencyEffect,
        previousDateString,
        timeWeightedPerformancePreviousPeriod,
        timeWeightedPerformancePreviousPeriodWithCurrencyEffect
      } = this.handleTimeWeightedPerformance(
        accumulatedValuesByDate,
        previousDateString,
        totalNetPerformanceValue,
        totalNetPerformanceValueWithCurrencyEffect,
        timeWeightedPerformancePreviousPeriod,
        timeWeightedPerformancePreviousPeriodWithCurrencyEffect,
        date
      ));

      return {
        date,
        netPerformanceInPercentage,
        netPerformanceInPercentageWithCurrencyEffect,
        investmentValueWithCurrencyEffect:
          investmentValueWithCurrencyEffect.toNumber(),
        netPerformance: totalNetPerformanceValue.toNumber(),
        netPerformanceWithCurrencyEffect:
          totalNetPerformanceValueWithCurrencyEffect.toNumber(),
        // TODO: Add valuables
        totalCashInBaseCurrency: totalCashValueWithCurrencyEffect.toNumber(),
        netWorth: totalNetWorthValueWithCurrencyEffect.toNumber(),
        totalInvestment: totalInvestmentValue.toNumber(),
        totalInvestmentValueWithCurrencyEffect:
          totalInvestmentValueWithCurrencyEffect.toNumber(),
        value: totalCurrentValue.toNumber(),
        valueWithCurrencyEffect: totalCurrentValueWithCurrencyEffect.toNumber(),
        timeWeightedPerformanceInPercentage,
        timeWeightedPerformanceInPercentageWithCurrencyEffect
      };
    });
  }

  @LogPerformance
  public async getSnapshot() {
    await this.snapshotPromise;

    return this.snapshot;
  }

  protected getCurrency(symbol: string) {
    return this.getCurrencyFromActivities(this.activitiesBySymbol, symbol);
  }

  protected getCurrencyFromActivities(
    activities: { [symbol: string]: PortfolioOrder[] },
    symbol: string
  ) {
    if (!this.holdingCurrencies[symbol]) {
      this.holdingCurrencies[symbol] =
        activities[symbol][0].assetProfile.currency;
    }

    return this.holdingCurrencies[symbol];
  }

  @LogPerformance
  protected computeTransactionPoints() {
    this.transactionPoints = [];
    const symbols: { [symbol: string]: TransactionPointSymbol } = {};

    let lastDate: string = null;
    let lastTransactionPoint: TransactionPoint = null;

    for (const {
      assetProfile,
      date,
      fee,
      feeInBaseCurrency,
      quantity,
      tags,
      type,
      unitPrice
    } of this.activities) {
      let currentTransactionPointItem: TransactionPointSymbol;

      const assetSubClass = assetProfile.assetSubClass;
      const currency = assetProfile.currency;
      const dataSource = assetProfile.dataSource;
      const factor = getFactor(type);
      const skipErrors = !!assetProfile.userId; // Skip errors for custom asset profiles
      const symbol = assetProfile.symbol;

      const oldAccumulatedSymbol = symbols[symbol];

      if (oldAccumulatedSymbol) {
        let investment = oldAccumulatedSymbol.investment;

        let newQuantity = quantity
          .mul(factor)
          .plus(oldAccumulatedSymbol.quantity);

        if (type === 'BUY') {
          if (oldAccumulatedSymbol.investment.gte(0)) {
            investment = oldAccumulatedSymbol.investment.plus(
              quantity.mul(unitPrice)
            );
          } else {
            investment = oldAccumulatedSymbol.investment.plus(
              quantity.mul(oldAccumulatedSymbol.averagePrice)
            );
          }
        } else if (type === 'SELL') {
          if (oldAccumulatedSymbol.investment.gt(0)) {
            investment = oldAccumulatedSymbol.investment.minus(
              quantity.mul(oldAccumulatedSymbol.averagePrice)
            );
          } else {
            investment = oldAccumulatedSymbol.investment.minus(
              quantity.mul(unitPrice)
            );
          }
        }

        if (newQuantity.abs().lt(Number.EPSILON)) {
          // Reset to zero if quantity is (almost) zero to avoid rounding issues
          investment = this.ZERO;
          newQuantity = this.ZERO;
        }

        currentTransactionPointItem = {
          assetSubClass,
          currency,
          dataSource,
          investment,
          skipErrors,
          symbol,
          activitiesCount: oldAccumulatedSymbol.activitiesCount + 1,
          averagePrice: newQuantity.eq(0)
            ? this.ZERO
            : investment.div(newQuantity).abs(),
          dateOfFirstActivity: oldAccumulatedSymbol.dateOfFirstActivity,
          dividend: this.ZERO,
          fee: oldAccumulatedSymbol.fee.plus(fee),
          feeInBaseCurrency:
            oldAccumulatedSymbol.feeInBaseCurrency.plus(feeInBaseCurrency),
          includeInHoldings: oldAccumulatedSymbol.includeInHoldings,
          quantity: newQuantity,
          tags: oldAccumulatedSymbol.tags.concat(tags)
        };
      } else {
        currentTransactionPointItem = {
          assetSubClass,
          currency,
          dataSource,
          fee,
          feeInBaseCurrency,
          skipErrors,
          symbol,
          tags,
          activitiesCount: 1,
          averagePrice: unitPrice,
          dateOfFirstActivity: date,
          dividend: this.ZERO,
          includeInHoldings: INVESTMENT_ACTIVITY_TYPES.includes(type),
          investment: unitPrice.mul(quantity).mul(factor),
          quantity: quantity.mul(factor)
        };
      }

      currentTransactionPointItem.tags = uniqBy(
        currentTransactionPointItem.tags,
        'id'
      );

      symbols[symbol] = currentTransactionPointItem;

      const items = lastTransactionPoint?.items ?? [];

      const newItems = items.filter(({ symbol }) => {
        return symbol !== assetProfile.symbol;
      });

      newItems.push(currentTransactionPointItem);

      newItems.sort((a, b) => {
        return a.symbol?.localeCompare(b.symbol);
      });

      let fees = this.ZERO;

      if (type === 'FEE') {
        fees = fee;
      }

      let interest = this.ZERO;

      if (type === 'INTEREST') {
        interest = quantity.mul(unitPrice);
      }

      let liabilities = this.ZERO;

      if (type === 'LIABILITY') {
        liabilities = quantity.mul(unitPrice);
      }

      if (lastDate !== date || lastTransactionPoint === null) {
        lastTransactionPoint = {
          date,
          fees,
          interest,
          liabilities,
          items: newItems
        };

        this.transactionPoints.push(lastTransactionPoint);
      } else {
        lastTransactionPoint.fees = lastTransactionPoint.fees.plus(fees);
        lastTransactionPoint.interest =
          lastTransactionPoint.interest.plus(interest);
        lastTransactionPoint.items = newItems;
        lastTransactionPoint.liabilities =
          lastTransactionPoint.liabilities.plus(liabilities);
      }

      lastDate = date;
    }
  }

  @LogPerformance
  protected async initialize(attempt = 1) {
    const startTimeTotal = performance.now();

    let cachedPortfolioSnapshot: PortfolioSnapshot;
    let isCachedPortfolioSnapshotExpired = false;
    const portfolioSnapshotKey = this.redisCacheService.getPortfolioSnapshotKey(
      {
        filters: this.filters,
        userId: this.userId
      }
    );

    const jobId = portfolioSnapshotKey;

    try {
      const cachedPortfolioSnapshotValue =
        await this.redisCacheService.get(portfolioSnapshotKey);

      const { expiration, portfolioSnapshot }: PortfolioSnapshotValue =
        JSON.parse(cachedPortfolioSnapshotValue);

      cachedPortfolioSnapshot = plainToClass(
        PortfolioSnapshot,
        portfolioSnapshot
      );

      if (isPast(new Date(expiration))) {
        isCachedPortfolioSnapshotExpired = true;
      }
    } catch {}

    if (cachedPortfolioSnapshot) {
      this.snapshot = cachedPortfolioSnapshot;

      this.logger.debug(
        `Fetched portfolio snapshot from cache in ${(
          (performance.now() - startTimeTotal) /
          1000
        ).toFixed(3)} seconds`
      );

      if (isCachedPortfolioSnapshotExpired) {
        // Compute in the background
        this.portfolioSnapshotService.addJobToQueue({
          data: {
            calculationType: this.getPerformanceCalculationType(),
            filters: this.filters,
            userCurrency: this.currency,
            userId: this.userId
          },
          name: PORTFOLIO_SNAPSHOT_PROCESS_JOB_NAME,
          opts: {
            ...PORTFOLIO_SNAPSHOT_PROCESS_JOB_OPTIONS,
            jobId,
            priority: PORTFOLIO_SNAPSHOT_COMPUTATION_QUEUE_PRIORITY_LOW
          }
        });
      }
    } else {
      if (attempt > PortfolioCalculator.MAX_INITIALIZATION_ATTEMPTS) {
        throw new PortfolioSnapshotComputationError(
          `Portfolio snapshot of user '${this.userId}' could not be computed after ${PortfolioCalculator.MAX_INITIALIZATION_ATTEMPTS} attempts`
        );
      }

      // Wait for computation
      await this.portfolioSnapshotService.addJobToQueue({
        data: {
          calculationType: this.getPerformanceCalculationType(),
          filters: this.filters,
          userCurrency: this.currency,
          userId: this.userId
        },
        name: PORTFOLIO_SNAPSHOT_PROCESS_JOB_NAME,
        opts: {
          ...PORTFOLIO_SNAPSHOT_PROCESS_JOB_OPTIONS,
          jobId,
          priority: PORTFOLIO_SNAPSHOT_COMPUTATION_QUEUE_PRIORITY_HIGH
        }
      });

      const job = await this.portfolioSnapshotService.getJob(jobId);

      if (job) {
        await job.finished();
      }

      await this.initialize(attempt + 1);
    }
  }

  @LogPerformance
  protected activitiesToPortfolioOrder(
    activities: Activity[]
  ): PortfolioOrder[] {
    return activities
      .map(
        ({
          date,
          fee,
          quantity,
          assetProfile,
          tags = [],
          type,
          feeInBaseCurrency,
          unitPrice
        }) => {
          if (isAfter(date, new Date(Date.now()))) {
            // Adapt date to today if activity is in future (e.g. liability)
            // to include it in the interval
            date = endOfDay(new Date(Date.now()));
          }

          return {
            assetProfile,
            tags,
            type,
            date: format(date, DATE_FORMAT),
            fee: new Big(fee),
            quantity: new Big(quantity),
            unitPrice: new Big(unitPrice),
            feeInBaseCurrency: new Big(feeInBaseCurrency)
          };
        }
      )
      .sort((a, b) => {
        return a.date?.localeCompare(b.date);
      });
  }

  @LogPerformance
  protected async getHoldings(
    activities: PortfolioOrder[],
    start: Date,
    end: Date
  ) {
    if (
      this.holdings &&
      Object.keys(this.holdings).some((h) =>
        isAfter(parseDate(h), subDays(end, 1))
      ) &&
      Object.keys(this.holdings).some((h) =>
        isBefore(parseDate(h), addDays(start, 1))
      )
    ) {
      return this.holdings;
    }

    await this.computeHoldings(activities, start, end);
    return this.holdings;
  }

  @LogPerformance
  protected async computeHoldings(
    activities: PortfolioOrder[],
    start: Date,
    end: Date
  ) {
    const investmentByDate = this.getInvestmentByDate(activities);
    this.calculateHoldings(investmentByDate, start, end);
  }

  @LogPerformance
  protected calculateInitialHoldings(
    investmentByDate: { [date: string]: PortfolioOrder[] },
    start: Date,
    currentHoldings: { [date: string]: { [symbol: string]: Big } }
  ) {
    const preRangeTrades = Object.keys(investmentByDate)
      .filter((date) => resetHours(new Date(date)) <= start)
      .map((date) => investmentByDate[date])
      .reduce((a, b) => a.concat(b), [])
      .reduce((groupBySymbol, trade) => {
        if (!groupBySymbol[trade.assetProfile.symbol]) {
          groupBySymbol[trade.assetProfile.symbol] = [];
        }

        groupBySymbol[trade.assetProfile.symbol].push(trade);

        return groupBySymbol;
      }, {});

    currentHoldings[format(start, DATE_FORMAT)] = {};

    for (const symbol of Object.keys(preRangeTrades)) {
      const trades: PortfolioOrder[] = preRangeTrades[symbol];
      const startQuantity = trades.reduce((sum, trade) => {
        return sum.plus(trade.quantity.mul(getFactor(trade.type)));
      }, this.ZERO);
      currentHoldings[format(start, DATE_FORMAT)][symbol] = startQuantity;
    }
  }

  @LogPerformance
  protected getInvestmentByDate(activities: PortfolioOrder[]): {
    [date: string]: PortfolioOrder[];
  } {
    return activities.reduce((groupedByDate, order) => {
      if (!groupedByDate[order.date]) {
        groupedByDate[order.date] = [];
      }

      groupedByDate[order.date].push(order);

      return groupedByDate;
    }, {});
  }

  @LogPerformance
  protected mapToDataGatheringItems(
    orders: PortfolioOrder[]
  ): DataGatheringItem[] {
    return orders
      .map((activity) => {
        return {
          symbol: activity.assetProfile.symbol,
          dataSource: activity.assetProfile.dataSource
        };
      })
      .filter(
        (gathering, i, arr) =>
          arr.findIndex((t) => t.symbol === gathering.symbol) === i
      );
  }

  public getStartDate() {
    let firstAccountBalanceDate: Date;
    let firstActivityDate: Date;

    try {
      const firstAccountBalanceDateString = this.accountBalanceItems[0]?.date;
      firstAccountBalanceDate = firstAccountBalanceDateString
        ? parseDate(firstAccountBalanceDateString)
        : new Date();
    } catch (error) {
      firstAccountBalanceDate = new Date();
    }

    try {
      const firstActivityDateString = this.transactionPoints[0].date;
      firstActivityDate = firstActivityDateString
        ? parseDate(firstActivityDateString)
        : new Date();
    } catch (error) {
      firstActivityDate = new Date();
    }

    return min([firstAccountBalanceDate, firstActivityDate]);
  }

  public getTransactionPoints() {
    return this.transactionPoints;
  }

  private calculateTimeWeightedPerformance(
    lastTimeWeightedPerformancePercentage: number,
    historicalDataItem: HistoricalDataItem,
    lastTimeWeightedPerformancePercentageWithCurrencyEffect: number,
    timeWeightedPerformanceInPercentage: number,
    timeWeightedPerformanceInPercentageWithCurrencyEffect: number
  ): {
    timeWeightedPerformanceInPercentage: number;
    timeWeightedPerformanceInPercentageWithCurrencyEffect: number;
    lastTimeWeightedPerformancePercentage: number;
    lastTimeWeightedPerformancePercentageWithCurrencyEffect: number;
  } {
    timeWeightedPerformanceInPercentage = lastTimeWeightedPerformancePercentage
      ? (1 + timeWeightedPerformanceInPercentage) *
          ((1 + historicalDataItem.timeWeightedPerformanceInPercentage) /
            (1 + lastTimeWeightedPerformancePercentage)) -
        1
      : 0;
    timeWeightedPerformanceInPercentageWithCurrencyEffect =
      lastTimeWeightedPerformancePercentageWithCurrencyEffect
        ? (1 + timeWeightedPerformanceInPercentageWithCurrencyEffect) *
            ((1 +
              historicalDataItem.timeWeightedPerformanceInPercentageWithCurrencyEffect) /
              (1 + lastTimeWeightedPerformancePercentageWithCurrencyEffect)) -
          1
        : 0;
    return {
      timeWeightedPerformanceInPercentage,
      timeWeightedPerformanceInPercentageWithCurrencyEffect,
      lastTimeWeightedPerformancePercentage:
        historicalDataItem.timeWeightedPerformanceInPercentage,
      lastTimeWeightedPerformancePercentageWithCurrencyEffect:
        historicalDataItem.timeWeightedPerformanceInPercentageWithCurrencyEffect
    };
  }

  @LogPerformance
  private calculateHoldings(
    investmentByDate: { [date: string]: PortfolioOrder[] },
    start: Date,
    end: Date
  ) {
    const transactionDates = Object.keys(investmentByDate).sort();
    const dates = eachDayOfInterval({ start, end }, { step: 1 })
      .map((date) => {
        return resetHours(date);
      })
      .sort((a, b) => a.getTime() - b.getTime());
    const currentHoldings: { [date: string]: { [symbol: string]: Big } } = {};

    this.calculateInitialHoldings(investmentByDate, start, currentHoldings);

    for (let i = 1; i < dates.length; i++) {
      const dateString = format(dates[i], DATE_FORMAT);
      const previousDateString = format(dates[i - 1], DATE_FORMAT);
      if (transactionDates.some((d) => d === dateString)) {
        const holdings = { ...currentHoldings[previousDateString] };
        investmentByDate[dateString].forEach((trade) => {
          holdings[trade.assetProfile.symbol] ??= this.ZERO;
          holdings[trade.assetProfile.symbol] = holdings[
            trade.assetProfile.symbol
          ].plus(trade.quantity.mul(getFactor(trade.type)));
        });
        currentHoldings[dateString] = holdings;
      } else {
        currentHoldings[dateString] = currentHoldings[previousDateString];
      }
    }

    this.holdings = currentHoldings;
  }

  @LogPerformance
  private getChartDateMap({
    endDate,
    startDate,
    step
  }: {
    endDate: Date;
    startDate: Date;
    step: number;
  }): { [date: string]: true } {
    // Create a map of all relevant chart dates:
    // 1. Add transaction point dates
    const chartDateMap = this.transactionPoints.reduce((result, { date }) => {
      result[date] = true;
      return result;
    }, {});

    // 2. Add dates between transactions respecting the specified step size
    for (const date of eachDayOfInterval(
      { end: endDate, start: startDate },
      { step }
    )) {
      chartDateMap[format(date, DATE_FORMAT)] = true;
    }

    if (step > 1) {
      // Reduce the step size of last 90 days
      for (const date of eachDayOfInterval(
        { end: endDate, start: subDays(endDate, 90) },
        { step: 3 }
      )) {
        chartDateMap[format(date, DATE_FORMAT)] = true;
      }

      // Reduce the step size of last 30 days
      for (const date of eachDayOfInterval(
        { end: endDate, start: subDays(endDate, 30) },
        { step: 1 }
      )) {
        chartDateMap[format(date, DATE_FORMAT)] = true;
      }
    }

    // Make sure the end date is present
    chartDateMap[format(endDate, DATE_FORMAT)] = true;

    // Make sure some key dates are present
    for (const dateRange of DATE_RANGES) {
      const { endDate: dateRangeEnd, startDate: dateRangeStart } =
        getIntervalFromDateRange({ dateRange, startDate });

      if (
        !isBefore(dateRangeStart, startDate) &&
        !isAfter(dateRangeStart, endDate)
      ) {
        chartDateMap[format(dateRangeStart, DATE_FORMAT)] = true;
      }

      if (
        !isBefore(dateRangeEnd, startDate) &&
        !isAfter(dateRangeEnd, endDate)
      ) {
        chartDateMap[format(dateRangeEnd, DATE_FORMAT)] = true;
      }
    }

    // Make sure the first and last date of each calendar year is present
    const interval = { start: this.startDate, end: this.endDate };

    for (const date of eachYearOfInterval(interval)) {
      const yearStart = startOfYear(date);
      const yearEnd = endOfYear(date);

      if (isWithinInterval(yearStart, interval)) {
        // Add start of year (YYYY-01-01)
        this.chartDateMap[format(yearStart, DATE_FORMAT)] = true;
      }

      if (isWithinInterval(yearEnd, interval)) {
        // Add end of year (YYYY-12-31)
        this.chartDateMap[format(yearEnd, DATE_FORMAT)] = true;
      }
    }

    return chartDateMap;
  }

  private handleTimeWeightedPerformance(
    accumulatedValuesByDate: {
      [date: string]: {
        investmentValueWithCurrencyEffect: Big;
        totalCurrentValue: Big;
        totalCurrentValueWithCurrencyEffect: Big;
        totalInvestmentValue: Big;
        totalInvestmentValueWithCurrencyEffect: Big;
        totalNetPerformanceValue: Big;
        totalNetPerformanceValueWithCurrencyEffect: Big;
        totalTimeWeightedInvestmentValue: Big;
        totalTimeWeightedInvestmentValueWithCurrencyEffect: Big;
      };
    },
    previousDateString: string,
    totalNetPerformanceValue: Big,
    totalNetPerformanceValueWithCurrencyEffect: Big,
    timeWeightedPerformancePreviousPeriod: Big,
    timeWeightedPerformancePreviousPeriodWithCurrencyEffect: Big,
    date: string
  ): {
    timeWeightedPerformanceInPercentage: number;
    timeWeightedPerformanceInPercentageWithCurrencyEffect: number;
    previousDateString: string;
    timeWeightedPerformancePreviousPeriod: Big;
    timeWeightedPerformancePreviousPeriodWithCurrencyEffect: Big;
  } {
    const previousValues = accumulatedValuesByDate[previousDateString] ?? {
      totalNetPerformanceValue: this.ZERO,
      totalNetPerformanceValueWithCurrencyEffect: this.ZERO,
      totalTimeWeightedInvestmentValue: this.ZERO,
      totalTimeWeightedInvestmentValueWithCurrencyEffect: this.ZERO,
      totalCurrentValue: this.ZERO,
      totalCurrentValueWithCurrencyEffect: this.ZERO
    };

    const timeWeightedPerformanceCurrentPeriod = this.divideByOrZero(
      (div) =>
        totalNetPerformanceValue
          .minus(previousValues.totalNetPerformanceValue)
          .div(div),
      previousValues.totalCurrentValue
    );
    const timeWeightedPerformanceCurrentPeriodWithCurrencyEffect =
      this.divideByOrZero(
        (div) =>
          totalNetPerformanceValueWithCurrencyEffect
            .minus(previousValues.totalNetPerformanceValueWithCurrencyEffect)
            .div(div),
        previousValues.totalCurrentValueWithCurrencyEffect
      );

    const timeWeightedPerformanceInPercentage = this.ONE.plus(
      timeWeightedPerformancePreviousPeriod
    )
      .mul(this.ONE.plus(timeWeightedPerformanceCurrentPeriod))
      .minus(1);
    const timeWeightedPerformanceInPercentageWithCurrencyEffect = this.ONE.plus(
      timeWeightedPerformancePreviousPeriodWithCurrencyEffect
    )
      .mul(
        this.ONE.plus(timeWeightedPerformanceCurrentPeriodWithCurrencyEffect)
      )
      .minus(1);

    return {
      timeWeightedPerformanceInPercentage:
        timeWeightedPerformanceInPercentage.toNumber(),
      timeWeightedPerformanceInPercentageWithCurrencyEffect:
        timeWeightedPerformanceInPercentageWithCurrencyEffect.toNumber(),
      previousDateString: date,
      timeWeightedPerformancePreviousPeriod:
        timeWeightedPerformanceInPercentage,
      timeWeightedPerformancePreviousPeriodWithCurrencyEffect:
        timeWeightedPerformanceInPercentageWithCurrencyEffect
    };
  }

  private divideByOrZero(fn: (big: Big) => Big, divisor: Big): Big {
    if (divisor.eq(0)) {
      return this.ZERO;
    } else {
      return fn(divisor);
    }
  }

  protected abstract getSymbolMetrics({
    chartDateMap,
    dataSource,
    end,
    exchangeRates,
    marketSymbolMap,
    start,
    symbol
  }: {
    chartDateMap: { [date: string]: boolean };
    end: Date;
    exchangeRates: { [dateString: string]: number };
    marketSymbolMap: { [date: string]: { [symbol: string]: Big } };
    start: Date;
  } & AssetProfileIdentifier): SymbolMetrics;

  protected abstract getPerformanceCalculationType(): PerformanceCalculationType;
}
