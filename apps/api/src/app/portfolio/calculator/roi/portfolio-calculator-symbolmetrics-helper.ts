import { getIntervalFromDateRange } from '@ghostfolio/common/calculation-helper';
import { DATE_RANGES } from '@ghostfolio/common/config';
import { DATE_FORMAT } from '@ghostfolio/common/helper';
import { SymbolMetrics } from '@ghostfolio/common/interfaces';

import { DataSource } from '@prisma/client';
import { Big } from 'big.js';
import { isBefore, addMilliseconds, format } from 'date-fns';
import { sortBy } from 'lodash';

import { getFactor } from '../../../../helper/portfolio.helper';
import { PortfolioOrderItem } from '../../interfaces/portfolio-order-item.interface';
import { PortfolioCalculatorSymbolMetricsHelperObject } from './portfolio-calculator-helper-object';

export class RoiPortfolioCalculatorSymbolMetricsHelper {
  private ENABLE_LOGGING: boolean;
  private baseCurrencySuffix = 'InBaseCurrency';
  private chartDates: string[];
  private marketSymbolMap: { [date: string]: { [symbol: string]: Big } };
  private static readonly BUY_SELL_ORDER_TYPES = new Set(['BUY', 'SELL']);
  private readonly ZERO = new Big(0);
  public constructor(
    ENABLE_LOGGING: boolean,
    marketSymbolMap: { [date: string]: { [symbol: string]: Big } },
    chartDates: string[]
  ) {
    this.ENABLE_LOGGING = ENABLE_LOGGING;
    this.marketSymbolMap = marketSymbolMap;
    this.chartDates = chartDates;
  }

  public calculateNetPerformanceByDateRange(
    start: Date,
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject
  ) {
    for (const dateRange of DATE_RANGES) {
      const dateInterval = getIntervalFromDateRange({
        dateRange,
        startDate: start
      });
      const endDate = dateInterval.endDate;
      let startDate = dateInterval.startDate;

      if (isBefore(startDate, start)) {
        startDate = start;
      }

      const rangeEndDateString = format(endDate, DATE_FORMAT);
      const rangeStartDateString = format(startDate, DATE_FORMAT);

      symbolMetricsHelper.symbolMetrics.netPerformanceWithCurrencyEffectMap[
        dateRange
      ] =
        symbolMetricsHelper.symbolMetrics.netPerformanceValuesWithCurrencyEffect[
          rangeEndDateString
        ]?.minus(
          // If the date range is 'max', take 0 as a start value. Otherwise,
          // the value of the end of the day of the start date is taken which
          // differs from the buying price.
          dateRange === 'max'
            ? this.ZERO
            : (symbolMetricsHelper.symbolMetrics
                .netPerformanceValuesWithCurrencyEffect[rangeStartDateString] ??
                this.ZERO)
        ) ?? this.ZERO;

      const investmentBasis = this.calculateInvestmentBasis(
        symbolMetricsHelper,
        rangeStartDateString,
        rangeEndDateString
      );

      symbolMetricsHelper.symbolMetrics.netPerformancePercentageWithCurrencyEffectMap[
        dateRange
      ] = investmentBasis.gt(0)
        ? symbolMetricsHelper.symbolMetrics.netPerformanceWithCurrencyEffectMap[
            dateRange
          ].div(investmentBasis)
        : this.ZERO;
    }
  }

  public handleOverallPerformanceCalculation(
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject
  ) {
    symbolMetricsHelper.symbolMetrics.grossPerformance =
      symbolMetricsHelper.symbolMetrics.grossPerformance.minus(
        symbolMetricsHelper.grossPerformanceAtStartDate
      );
    symbolMetricsHelper.symbolMetrics.grossPerformanceWithCurrencyEffect =
      symbolMetricsHelper.symbolMetrics.grossPerformanceWithCurrencyEffect.minus(
        symbolMetricsHelper.grossPerformanceAtStartDateWithCurrencyEffect
      );

    symbolMetricsHelper.symbolMetrics.netPerformance =
      symbolMetricsHelper.symbolMetrics.grossPerformance.minus(
        symbolMetricsHelper.fees.minus(symbolMetricsHelper.feesAtStartDate)
      );

    symbolMetricsHelper.symbolMetrics.timeWeightedInvestment = new Big(
      symbolMetricsHelper.totalInvestmentFromBuyTransactions
    );
    symbolMetricsHelper.symbolMetrics.timeWeightedInvestmentWithCurrencyEffect =
      new Big(
        symbolMetricsHelper.totalInvestmentFromBuyTransactionsWithCurrencyEffect
      );

    if (symbolMetricsHelper.symbolMetrics.timeWeightedInvestment.gt(0)) {
      symbolMetricsHelper.symbolMetrics.netPerformancePercentage =
        symbolMetricsHelper.symbolMetrics.netPerformance.div(
          symbolMetricsHelper.symbolMetrics.timeWeightedInvestment
        );
      symbolMetricsHelper.symbolMetrics.grossPerformancePercentage =
        symbolMetricsHelper.symbolMetrics.grossPerformance.div(
          symbolMetricsHelper.symbolMetrics.timeWeightedInvestment
        );
      symbolMetricsHelper.symbolMetrics.grossPerformancePercentageWithCurrencyEffect =
        symbolMetricsHelper.symbolMetrics.grossPerformanceWithCurrencyEffect.div(
          symbolMetricsHelper.symbolMetrics
            .timeWeightedInvestmentWithCurrencyEffect
        );
    }
  }

  public processOrderMetrics(
    orders: PortfolioOrderItem[],
    i: number,
    exchangeRates: { [dateString: string]: number },
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject
  ) {
    const order = orders[i];
    this.writeOrderToLogIfNecessary(i, order);

    symbolMetricsHelper.exchangeRateAtOrderDate = exchangeRates[order.date];
    const value = order.quantity.gt(0)
      ? order.quantity.mul(order.unitPrice)
      : this.ZERO;

    this.handleNoneBuyAndSellOrders(order, value, symbolMetricsHelper);
    this.handleStartOrder(
      order,
      i,
      orders,
      symbolMetricsHelper.unitPriceAtStartDate
    );
    this.handleOrderFee(order, symbolMetricsHelper);
    symbolMetricsHelper.unitPrice = this.getUnitPriceAndFillCurrencyDeviations(
      order,
      symbolMetricsHelper
    );

    if (order.unitPriceInBaseCurrency) {
      symbolMetricsHelper.investmentValueBeforeTransaction =
        symbolMetricsHelper.totalUnits.mul(order.unitPriceInBaseCurrency);
      symbolMetricsHelper.investmentValueBeforeTransactionWithCurrencyEffect =
        symbolMetricsHelper.totalUnits.mul(
          order.unitPriceInBaseCurrencyWithCurrencyEffect
        );
    }

    this.handleInitialInvestmentValues(symbolMetricsHelper, i, order);

    const { transactionInvestment, transactionInvestmentWithCurrencyEffect } =
      this.handleBuyAndSellTranscation(order, symbolMetricsHelper);

    this.logTransactionValuesIfRequested(
      order,
      transactionInvestment,
      transactionInvestmentWithCurrencyEffect
    );

    symbolMetricsHelper.totalUnits = symbolMetricsHelper.totalUnits.plus(
      order.quantity.mul(getFactor(order.type))
    );

    this.updateTotalInvestments(
      symbolMetricsHelper,
      transactionInvestment,
      transactionInvestmentWithCurrencyEffect
    );

    this.setInitialValueIfNecessary(
      symbolMetricsHelper,
      transactionInvestment,
      transactionInvestmentWithCurrencyEffect
    );

    this.accumulateFees(symbolMetricsHelper, order);

    this.fillOrderUnitPricesIfMissing(order, symbolMetricsHelper);

    const valueOfInvestment = symbolMetricsHelper.totalUnits.mul(
      order.unitPriceInBaseCurrency
    );

    const valueOfInvestmentWithCurrencyEffect =
      symbolMetricsHelper.totalUnits.mul(
        order.unitPriceInBaseCurrencyWithCurrencyEffect
      );

    const valueOfPositionsSold =
      order.type === 'SELL'
        ? order.unitPriceInBaseCurrency.mul(order.quantity)
        : this.ZERO;

    const valueOfPositionsSoldWithCurrencyEffect =
      order.type === 'SELL'
        ? order.unitPriceInBaseCurrencyWithCurrencyEffect.mul(order.quantity)
        : this.ZERO;

    symbolMetricsHelper.totalValueOfPositionsSold =
      symbolMetricsHelper.totalValueOfPositionsSold.plus(valueOfPositionsSold);
    symbolMetricsHelper.totalValueOfPositionsSoldWithCurrencyEffect =
      symbolMetricsHelper.totalValueOfPositionsSoldWithCurrencyEffect.plus(
        valueOfPositionsSoldWithCurrencyEffect
      );

    this.handlePerformanceCalculation(
      valueOfInvestment,
      symbolMetricsHelper,
      valueOfInvestmentWithCurrencyEffect,
      order
    );

    symbolMetricsHelper.symbolMetrics.investmentValuesAccumulated[order.date] =
      symbolMetricsHelper.symbolMetrics.totalInvestment;

    symbolMetricsHelper.symbolMetrics.investmentValuesAccumulatedWithCurrencyEffect[
      order.date
    ] = symbolMetricsHelper.symbolMetrics.totalInvestmentWithCurrencyEffect;

    symbolMetricsHelper.symbolMetrics.investmentValuesWithCurrencyEffect[
      order.date
    ] = (
      symbolMetricsHelper.symbolMetrics.investmentValuesWithCurrencyEffect[
        order.date
      ] ?? this.ZERO
    ).add(transactionInvestmentWithCurrencyEffect);
  }

  public handlePerformanceCalculation(
    valueOfInvestment: Big,
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject,
    valueOfInvestmentWithCurrencyEffect: Big,
    order: PortfolioOrderItem
  ) {
    this.calculateGrossPerformance(
      valueOfInvestment,
      symbolMetricsHelper,
      valueOfInvestmentWithCurrencyEffect
    );

    this.calculateNetPerformance(
      symbolMetricsHelper,
      order,
      valueOfInvestment,
      valueOfInvestmentWithCurrencyEffect
    );
  }

  public calculateNetPerformance(
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject,
    order: PortfolioOrderItem,
    valueOfInvestment: Big,
    valueOfInvestmentWithCurrencyEffect: Big
  ) {
    symbolMetricsHelper.symbolMetrics.currentValues[order.date] =
      valueOfInvestment;
    symbolMetricsHelper.symbolMetrics.currentValuesWithCurrencyEffect[
      order.date
    ] = valueOfInvestmentWithCurrencyEffect;

    symbolMetricsHelper.symbolMetrics.timeWeightedInvestmentValues[order.date] =
      symbolMetricsHelper.totalInvestmentFromBuyTransactions;
    symbolMetricsHelper.symbolMetrics.timeWeightedInvestmentValuesWithCurrencyEffect[
      order.date
    ] =
      symbolMetricsHelper.totalInvestmentFromBuyTransactionsWithCurrencyEffect;

    symbolMetricsHelper.symbolMetrics.netPerformanceValues[order.date] =
      symbolMetricsHelper.symbolMetrics.grossPerformance
        .minus(symbolMetricsHelper.grossPerformanceAtStartDate)
        .minus(
          symbolMetricsHelper.fees.minus(symbolMetricsHelper.feesAtStartDate)
        );

    symbolMetricsHelper.symbolMetrics.netPerformanceValuesWithCurrencyEffect[
      order.date
    ] = symbolMetricsHelper.symbolMetrics.grossPerformanceWithCurrencyEffect
      .minus(symbolMetricsHelper.grossPerformanceAtStartDateWithCurrencyEffect)
      .minus(
        symbolMetricsHelper.feesWithCurrencyEffect.minus(
          symbolMetricsHelper.feesAtStartDateWithCurrencyEffect
        )
      );
  }

  public calculateGrossPerformance(
    valueOfInvestment: Big,
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject,
    valueOfInvestmentWithCurrencyEffect: Big
  ) {
    const newGrossPerformance = valueOfInvestment
      .minus(symbolMetricsHelper.totalInvestmentFromBuyTransactions)
      .plus(symbolMetricsHelper.totalValueOfPositionsSold)
      .plus(
        symbolMetricsHelper.symbolMetrics.totalDividend.mul(
          symbolMetricsHelper.currentExchangeRate
        )
      )
      .plus(
        symbolMetricsHelper.symbolMetrics.totalInterest.mul(
          symbolMetricsHelper.currentExchangeRate
        )
      );

    const newGrossPerformanceWithCurrencyEffect =
      valueOfInvestmentWithCurrencyEffect
        .minus(
          symbolMetricsHelper.totalInvestmentFromBuyTransactionsWithCurrencyEffect
        )
        .plus(symbolMetricsHelper.totalValueOfPositionsSoldWithCurrencyEffect)
        .plus(symbolMetricsHelper.symbolMetrics.totalDividendInBaseCurrency)
        .plus(symbolMetricsHelper.symbolMetrics.totalInterestInBaseCurrency);

    symbolMetricsHelper.symbolMetrics.grossPerformance = newGrossPerformance;
    symbolMetricsHelper.symbolMetrics.grossPerformanceWithCurrencyEffect =
      newGrossPerformanceWithCurrencyEffect;
  }

  public accumulateFees(
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject,
    order: PortfolioOrderItem
  ) {
    symbolMetricsHelper.fees = symbolMetricsHelper.fees.plus(
      order.feeInBaseCurrency ?? 0
    );

    symbolMetricsHelper.feesWithCurrencyEffect =
      symbolMetricsHelper.feesWithCurrencyEffect.plus(
        order.feeInBaseCurrencyWithCurrencyEffect ?? 0
      );
  }

  public updateTotalInvestments(
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject,
    transactionInvestment: Big,
    transactionInvestmentWithCurrencyEffect: Big
  ) {
    if (symbolMetricsHelper.totalUnits.eq(0)) {
      symbolMetricsHelper.symbolMetrics.totalInvestment = this.ZERO;
      symbolMetricsHelper.symbolMetrics.totalInvestmentWithCurrencyEffect =
        this.ZERO;
      return;
    }

    const newTotalInvestment =
      symbolMetricsHelper.symbolMetrics.totalInvestment.plus(
        transactionInvestment
      );
    symbolMetricsHelper.symbolMetrics.totalInvestment = newTotalInvestment.lt(0)
      ? this.ZERO
      : newTotalInvestment;

    const newTotalInvestmentWithCurrencyEffect =
      symbolMetricsHelper.symbolMetrics.totalInvestmentWithCurrencyEffect.plus(
        transactionInvestmentWithCurrencyEffect
      );
    symbolMetricsHelper.symbolMetrics.totalInvestmentWithCurrencyEffect =
      newTotalInvestmentWithCurrencyEffect.lt(0)
        ? this.ZERO
        : newTotalInvestmentWithCurrencyEffect;
  }

  public setInitialValueIfNecessary(
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject,
    transactionInvestment: Big,
    transactionInvestmentWithCurrencyEffect: Big
  ) {
    if (!symbolMetricsHelper.initialValue && transactionInvestment.gt(0)) {
      symbolMetricsHelper.initialValue = transactionInvestment;
      symbolMetricsHelper.initialValueWithCurrencyEffect =
        transactionInvestmentWithCurrencyEffect;
    }
  }

  public logTransactionValuesIfRequested(
    order: PortfolioOrderItem,
    transactionInvestment: Big,
    transactionInvestmentWithCurrencyEffect: Big
  ) {
    if (this.ENABLE_LOGGING) {
      console.log('order.quantity', order.quantity.toNumber());
      console.log('transactionInvestment', transactionInvestment.toNumber());

      console.log(
        'transactionInvestmentWithCurrencyEffect',
        transactionInvestmentWithCurrencyEffect.toNumber()
      );
    }
  }

  public handleBuyAndSellTranscation(
    order: PortfolioOrderItem,
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject
  ) {
    switch (order.type) {
      case 'BUY':
        return this.handleBuyTransaction(order, symbolMetricsHelper);
      case 'SELL':
        return this.handleSellTransaction(symbolMetricsHelper, order);
      default:
        return {
          transactionInvestment: this.ZERO,
          transactionInvestmentWithCurrencyEffect: this.ZERO
        };
    }
  }

  public handleSellTransaction(
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject,
    order: PortfolioOrderItem
  ) {
    let transactionInvestment = this.ZERO;
    let transactionInvestmentWithCurrencyEffect = this.ZERO;
    if (symbolMetricsHelper.totalUnits.gt(0)) {
      transactionInvestment = new Big(
        order.quantity.mul(order.unitPriceInBaseCurrency).toNumber()
      ).mul(getFactor(order.type));
      transactionInvestmentWithCurrencyEffect = new Big(
        order.quantity
          .mul(order.unitPriceInBaseCurrencyWithCurrencyEffect)
          .toNumber()
      ).mul(getFactor(order.type));
    }
    return { transactionInvestment, transactionInvestmentWithCurrencyEffect };
  }

  public handleBuyTransaction(
    order: PortfolioOrderItem,
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject
  ) {
    const transactionInvestment = order.quantity
      .mul(order.unitPriceInBaseCurrency)
      .mul(getFactor(order.type));

    const transactionInvestmentWithCurrencyEffect = order.quantity
      .mul(order.unitPriceInBaseCurrencyWithCurrencyEffect)
      .mul(getFactor(order.type));

    symbolMetricsHelper.totalQuantityFromBuyTransactions =
      symbolMetricsHelper.totalQuantityFromBuyTransactions.plus(order.quantity);

    symbolMetricsHelper.totalInvestmentFromBuyTransactions =
      symbolMetricsHelper.totalInvestmentFromBuyTransactions.plus(
        transactionInvestment
      );

    symbolMetricsHelper.totalInvestmentFromBuyTransactionsWithCurrencyEffect =
      symbolMetricsHelper.totalInvestmentFromBuyTransactionsWithCurrencyEffect.plus(
        transactionInvestmentWithCurrencyEffect
      );
    return { transactionInvestment, transactionInvestmentWithCurrencyEffect };
  }

  public handleInitialInvestmentValues(
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject,
    i: number,
    order: PortfolioOrderItem
  ) {
    if (
      !symbolMetricsHelper.investmentAtStartDate &&
      i >= symbolMetricsHelper.indexOfStartOrder
    ) {
      symbolMetricsHelper.investmentAtStartDate =
        symbolMetricsHelper.symbolMetrics.totalInvestment;
      symbolMetricsHelper.investmentAtStartDateWithCurrencyEffect =
        symbolMetricsHelper.symbolMetrics.totalInvestmentWithCurrencyEffect;

      symbolMetricsHelper.valueAtStartDate =
        symbolMetricsHelper.investmentValueBeforeTransaction;

      symbolMetricsHelper.valueAtStartDateWithCurrencyEffect =
        symbolMetricsHelper.investmentValueBeforeTransactionWithCurrencyEffect;
    }

    if (order.itemType === 'start') {
      symbolMetricsHelper.feesAtStartDate = symbolMetricsHelper.fees;
      symbolMetricsHelper.feesAtStartDateWithCurrencyEffect =
        symbolMetricsHelper.feesWithCurrencyEffect;
      symbolMetricsHelper.grossPerformanceAtStartDate =
        symbolMetricsHelper.symbolMetrics.grossPerformance;

      symbolMetricsHelper.grossPerformanceAtStartDateWithCurrencyEffect =
        symbolMetricsHelper.symbolMetrics.grossPerformanceWithCurrencyEffect;
    }

    if (
      i >= symbolMetricsHelper.indexOfStartOrder &&
      !symbolMetricsHelper.initialValue
    ) {
      if (
        i === symbolMetricsHelper.indexOfStartOrder &&
        !symbolMetricsHelper.symbolMetrics.totalInvestment.eq(0)
      ) {
        symbolMetricsHelper.initialValue =
          symbolMetricsHelper.symbolMetrics.totalInvestment;

        symbolMetricsHelper.initialValueWithCurrencyEffect =
          symbolMetricsHelper.symbolMetrics.totalInvestmentWithCurrencyEffect;
      }
    }
  }

  public getSymbolMetricHelperObject(
    exchangeRates: { [dateString: string]: number },
    start: Date,
    end: Date,
    marketSymbolMap: { [date: string]: { [symbol: string]: Big } },
    symbol: string
  ): PortfolioCalculatorSymbolMetricsHelperObject {
    const symbolMetricsHelper =
      new PortfolioCalculatorSymbolMetricsHelperObject();
    symbolMetricsHelper.symbolMetrics = this.createEmptySymbolMetrics();
    symbolMetricsHelper.currentExchangeRate =
      exchangeRates[format(new Date(), DATE_FORMAT)];
    symbolMetricsHelper.startDateString = format(start, DATE_FORMAT);
    symbolMetricsHelper.endDateString = format(end, DATE_FORMAT);
    symbolMetricsHelper.unitPriceAtStartDate =
      marketSymbolMap[symbolMetricsHelper.startDateString]?.[symbol];
    symbolMetricsHelper.unitPriceAtEndDate =
      marketSymbolMap[symbolMetricsHelper.endDateString]?.[symbol];

    symbolMetricsHelper.totalUnits = this.ZERO;

    return symbolMetricsHelper;
  }

  public getUnitPriceAndFillCurrencyDeviations(
    order: PortfolioOrderItem,
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject
  ) {
    const unitprice =
      RoiPortfolioCalculatorSymbolMetricsHelper.BUY_SELL_ORDER_TYPES.has(
        order.type
      )
        ? order.unitPrice
        : order.unitPriceFromMarketData;
    if (unitprice) {
      order.unitPriceInBaseCurrency = unitprice.mul(
        symbolMetricsHelper.currentExchangeRate ?? 1
      );

      order.unitPriceInBaseCurrencyWithCurrencyEffect = unitprice.mul(
        symbolMetricsHelper.exchangeRateAtOrderDate ?? 1
      );
    }
    return unitprice;
  }

  public handleOrderFee(
    order: PortfolioOrderItem,
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject
  ) {
    if (order.fee) {
      order.feeInBaseCurrency = order.fee.mul(
        symbolMetricsHelper.currentExchangeRate ?? 1
      );
      order.feeInBaseCurrencyWithCurrencyEffect = order.fee.mul(
        symbolMetricsHelper.exchangeRateAtOrderDate ?? 1
      );
    }
  }

  public handleStartOrder(
    order: PortfolioOrderItem,
    i: number,
    orders: PortfolioOrderItem[],
    unitPriceAtStartDate: Big.Big
  ) {
    if (order.itemType === 'start') {
      // Take the unit price of the order as the market price if there are no
      // orders of this symbol before the start date
      order.unitPrice =
        i === 0 ? orders[i + 1]?.unitPrice : unitPriceAtStartDate;
    }
  }

  public handleNoneBuyAndSellOrders(
    order: PortfolioOrderItem,
    value: Big.Big,
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject
  ) {
    const symbolMetricsKey = this.getSymbolMetricsKeyFromOrderType(order.type);
    if (symbolMetricsKey) {
      this.calculateMetrics(value, symbolMetricsHelper, symbolMetricsKey);
    }
  }

  public getSymbolMetricsKeyFromOrderType(
    orderType: PortfolioOrderItem['type']
  ): keyof SymbolMetrics {
    switch (orderType) {
      case 'DIVIDEND':
        return 'totalDividend';
      case 'INTEREST':
        return 'totalInterest';
      case 'LIABILITY':
        return 'totalLiabilities';
      default:
        return undefined;
    }
  }

  public calculateMetrics(
    value: Big,
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject,
    key: keyof SymbolMetrics
  ) {
    const stringKey = key.toString();
    symbolMetricsHelper.symbolMetrics[stringKey] = (
      symbolMetricsHelper.symbolMetrics[stringKey] as Big
    ).plus(value);

    const baseCurrencyKey = stringKey + this.baseCurrencySuffix;

    if (baseCurrencyKey in symbolMetricsHelper.symbolMetrics) {
      symbolMetricsHelper.symbolMetrics[baseCurrencyKey] = (
        symbolMetricsHelper.symbolMetrics[baseCurrencyKey] as Big
      ).plus(value.mul(symbolMetricsHelper.exchangeRateAtOrderDate ?? 1));
    } else {
      throw new Error(`Key ${baseCurrencyKey} not found in symbolMetrics`);
    }
  }

  public writeOrderToLogIfNecessary(i: number, order: PortfolioOrderItem) {
    if (this.ENABLE_LOGGING) {
      console.log();
      console.log();
      console.log(
        i + 1,
        order.date,
        order.type,
        order.itemType ? `(${order.itemType})` : ''
      );
    }
  }

  public fillOrdersAndSortByTime(
    orders: PortfolioOrderItem[],
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject,
    chartDateMap: { [date: string]: boolean },
    marketSymbolMap: { [date: string]: { [symbol: string]: Big.Big } },
    symbol: string,
    dataSource: DataSource
  ) {
    this.fillOrdersByDate(orders, symbolMetricsHelper.ordersByDate);

    this.chartDates ??= Object.keys(chartDateMap).sort();

    this.fillOrdersWithDatesFromChartDate(
      symbolMetricsHelper,
      marketSymbolMap,
      symbol,
      orders,
      dataSource
    );

    // Sort orders so that the start and end placeholder order are at the correct
    // position
    orders = this.sortOrdersByTime(orders);
    return orders;
  }

  public sortOrdersByTime(orders: PortfolioOrderItem[]) {
    orders = sortBy(orders, ({ date, itemType }) => {
      let sortIndex = new Date(date);

      if (itemType === 'end') {
        sortIndex = addMilliseconds(sortIndex, 1);
      } else if (itemType === 'start') {
        sortIndex = addMilliseconds(sortIndex, -1);
      }

      return sortIndex.getTime();
    });
    return orders;
  }

  public fillOrdersWithDatesFromChartDate(
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject,
    marketSymbolMap: { [date: string]: { [symbol: string]: Big.Big } },
    symbol: string,
    orders: PortfolioOrderItem[],
    dataSource: DataSource
  ) {
    let lastUnitPrice: Big;

    const isCash = orders.some(
      (order) => order.assetProfile.assetSubClass === 'CASH'
    );

    for (const dateString of this.chartDates) {
      if (dateString < symbolMetricsHelper.startDateString) {
        continue;
      } else if (dateString > symbolMetricsHelper.endDateString) {
        break;
      }

      if (symbolMetricsHelper.ordersByDate[dateString]?.length > 0) {
        for (const order of symbolMetricsHelper.ordersByDate[dateString]) {
          order.unitPriceFromMarketData =
            marketSymbolMap[dateString]?.[symbol] ?? lastUnitPrice;
        }
      } else {
        orders.push(
          this.getFakeOrder(
            dateString,
            dataSource,
            symbol,
            marketSymbolMap,
            lastUnitPrice,
            isCash
          )
        );
      }

      const lastOrder = orders.at(-1);

      lastUnitPrice = lastOrder.unitPriceFromMarketData ?? lastOrder.unitPrice;
    }
    return lastUnitPrice;
  }

  public getFakeOrder(
    dateString: string,
    dataSource: DataSource,
    symbol: string,
    marketSymbolMap: { [date: string]: { [symbol: string]: Big.Big } },
    lastUnitPrice: Big.Big,
    isCash: boolean
  ): PortfolioOrderItem {
    return {
      date: dateString,
      fee: this.ZERO,
      feeInBaseCurrency: this.ZERO,
      quantity: this.ZERO,
      assetProfile: {
        dataSource,
        symbol,
        assetSubClass: isCash ? 'CASH' : undefined
      },
      type: 'BUY',
      unitPrice: marketSymbolMap[dateString]?.[symbol] ?? lastUnitPrice,
      unitPriceFromMarketData:
        marketSymbolMap[dateString]?.[symbol] ?? lastUnitPrice
    };
  }

  public fillOrdersByDate(
    orders: PortfolioOrderItem[],
    ordersByDate: { [date: string]: PortfolioOrderItem[] }
  ) {
    for (const order of orders) {
      ordersByDate[order.date] = ordersByDate[order.date] ?? [];
      ordersByDate[order.date].push(order);
    }
  }

  public addSyntheticStartAndEndOrder(
    orders: PortfolioOrderItem[],
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject,
    dataSource: DataSource,
    symbol: string,
    isCash: boolean
  ) {
    orders.push({
      date: symbolMetricsHelper.startDateString,
      fee: this.ZERO,
      feeInBaseCurrency: this.ZERO,
      itemType: 'start',
      quantity: this.ZERO,
      assetProfile: {
        dataSource,
        symbol,
        assetSubClass: isCash ? 'CASH' : undefined
      },
      type: 'BUY',
      unitPrice: symbolMetricsHelper.unitPriceAtStartDate
    });

    orders.push({
      date: symbolMetricsHelper.endDateString,
      fee: this.ZERO,
      feeInBaseCurrency: this.ZERO,
      itemType: 'end',
      assetProfile: {
        dataSource,
        symbol,
        assetSubClass: isCash ? 'CASH' : undefined
      },
      quantity: this.ZERO,
      type: 'BUY',
      unitPrice: symbolMetricsHelper.unitPriceAtEndDate
    });
  }

  public hasNoUnitPriceAtEndOrStartDate(
    unitPriceAtEndDate: Big.Big,
    unitPriceAtStartDate: Big.Big,
    orders: PortfolioOrderItem[],
    start: Date
  ) {
    return (
      !unitPriceAtEndDate ||
      (!unitPriceAtStartDate && isBefore(new Date(orders[0].date), start))
    );
  }

  public createEmptySymbolMetrics(): SymbolMetrics {
    return {
      currentValues: {},
      currentValuesWithCurrencyEffect: {},
      feesWithCurrencyEffect: this.ZERO,
      grossPerformance: this.ZERO,
      grossPerformancePercentage: this.ZERO,
      grossPerformancePercentageWithCurrencyEffect: this.ZERO,
      grossPerformanceWithCurrencyEffect: this.ZERO,
      hasErrors: false,
      initialValue: this.ZERO,
      initialValueWithCurrencyEffect: this.ZERO,
      investmentValuesAccumulated: {},
      investmentValuesAccumulatedWithCurrencyEffect: {},
      investmentValuesWithCurrencyEffect: {},
      netPerformance: this.ZERO,
      netPerformancePercentage: this.ZERO,
      netPerformancePercentageWithCurrencyEffectMap: {},
      netPerformanceValues: {},
      netPerformanceValuesWithCurrencyEffect: {},
      netPerformanceWithCurrencyEffectMap: {},
      timeWeightedInvestment: this.ZERO,
      timeWeightedInvestmentValues: {},
      timeWeightedInvestmentValuesWithCurrencyEffect: {},
      timeWeightedInvestmentWithCurrencyEffect: this.ZERO,
      totalAccountBalanceInBaseCurrency: this.ZERO,
      totalDividend: this.ZERO,
      totalDividendInBaseCurrency: this.ZERO,
      totalInterest: this.ZERO,
      totalInterestInBaseCurrency: this.ZERO,
      totalInvestment: this.ZERO,
      totalInvestmentWithCurrencyEffect: this.ZERO,
      unitPrices: {},
      totalLiabilities: this.ZERO,
      totalLiabilitiesInBaseCurrency: this.ZERO
    };
  }

  private fillOrderUnitPricesIfMissing(
    order: PortfolioOrderItem,
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject
  ) {
    order.unitPriceInBaseCurrency ??= this.marketSymbolMap[order.date]?.[
      order.assetProfile.symbol
    ].mul(symbolMetricsHelper.currentExchangeRate);

    order.unitPriceInBaseCurrencyWithCurrencyEffect ??= this.marketSymbolMap[
      order.date
    ]?.[order.assetProfile.symbol].mul(
      symbolMetricsHelper.exchangeRateAtOrderDate
    );
  }

  private calculateInvestmentBasis(
    symbolMetricsHelper: PortfolioCalculatorSymbolMetricsHelperObject,
    rangeStartDateString: string,
    rangeEndDateString: string
  ) {
    let investmentBasis = this.getValueOrZero(
      symbolMetricsHelper.symbolMetrics.currentValuesWithCurrencyEffect[
        rangeStartDateString
      ]
    ).plus(
      this.getValueOrZero(
        symbolMetricsHelper.symbolMetrics
          .timeWeightedInvestmentValuesWithCurrencyEffect[rangeEndDateString]
      )?.minus(
        this.getValueOrZero(
          symbolMetricsHelper.symbolMetrics
            .timeWeightedInvestmentValuesWithCurrencyEffect[
            rangeStartDateString
          ]
        )
      )
    );

    if (!investmentBasis.gt(0)) {
      investmentBasis =
        symbolMetricsHelper.symbolMetrics
          .timeWeightedInvestmentValuesWithCurrencyEffect[rangeEndDateString];
    }
    return investmentBasis;
  }

  private getValueOrZero(value: Big | undefined) {
    return value ?? this.ZERO;
  }
}
