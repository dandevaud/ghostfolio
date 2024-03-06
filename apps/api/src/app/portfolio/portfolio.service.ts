import { LogPerformance } from '@ghostfolio/api/aop/logging.interceptor';
import { AccountBalanceService } from '@ghostfolio/api/app/account-balance/account-balance.service';
import { AccountService } from '@ghostfolio/api/app/account/account.service';
import { CashDetails } from '@ghostfolio/api/app/account/interfaces/cash-details.interface';
import { Activity } from '@ghostfolio/api/app/order/interfaces/activities.interface';
import { OrderService } from '@ghostfolio/api/app/order/order.service';
import { CurrentRateService } from '@ghostfolio/api/app/portfolio/current-rate.service';
import { PortfolioOrder } from '@ghostfolio/api/app/portfolio/interfaces/portfolio-order.interface';
import { TransactionPoint } from '@ghostfolio/api/app/portfolio/interfaces/transaction-point.interface';
import { UserService } from '@ghostfolio/api/app/user/user.service';
import { AccountClusterRiskCurrentInvestment } from '@ghostfolio/api/models/rules/account-cluster-risk/current-investment';
import { AccountClusterRiskSingleAccount } from '@ghostfolio/api/models/rules/account-cluster-risk/single-account';
import { CurrencyClusterRiskBaseCurrencyCurrentInvestment } from '@ghostfolio/api/models/rules/currency-cluster-risk/base-currency-current-investment';
import { CurrencyClusterRiskCurrentInvestment } from '@ghostfolio/api/models/rules/currency-cluster-risk/current-investment';
import { EmergencyFundSetup } from '@ghostfolio/api/models/rules/emergency-fund/emergency-fund-setup';
import { FeeRatioInitialInvestment } from '@ghostfolio/api/models/rules/fees/fee-ratio-initial-investment';
import { DataProviderService } from '@ghostfolio/api/services/data-provider/data-provider.service';
import { ExchangeRateDataService } from '@ghostfolio/api/services/exchange-rate-data/exchange-rate-data.service';
import { ImpersonationService } from '@ghostfolio/api/services/impersonation/impersonation.service';
import { IDataProviderResponse } from '@ghostfolio/api/services/interfaces/interfaces';
import { SymbolProfileService } from '@ghostfolio/api/services/symbol-profile/symbol-profile.service';
import {
  DEFAULT_CURRENCY,
  EMERGENCY_FUND_TAG_ID,
  MAX_CHART_ITEMS,
  UNKNOWN_KEY
} from '@ghostfolio/common/config';
import { DATE_FORMAT, getSum, parseDate } from '@ghostfolio/common/helper';
import {
  Accounts,
  EnhancedSymbolProfile,
  Filter,
  HistoricalDataItem,
  PortfolioDetails,
  PortfolioInvestments,
  PortfolioPerformanceResponse,
  PortfolioPosition,
  PortfolioReport,
  PortfolioSummary,
  Position,
  TimelinePosition,
  UserSettings
} from '@ghostfolio/common/interfaces';
import { InvestmentItem } from '@ghostfolio/common/interfaces/investment-item.interface';
import type {
  AccountWithValue,
  DateRange,
  GroupBy,
  OrderWithAccount,
  RequestWithUser,
  UserWithSettings
} from '@ghostfolio/common/types';

import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
  Account,
  Type as ActivityType,
  AssetClass,
  DataSource,
  Order,
  Platform,
  Prisma,
  Tag
} from '@prisma/client';
import Big from 'big.js';
import { isUUID } from 'class-validator';
import {
  differenceInDays,
  format,
  isAfter,
  isBefore,
  isSameMonth,
  isSameYear,
  isValid,
  max,
  min,
  parseISO,
  set,
  startOfWeek,
  startOfMonth,
  startOfYear,
  subDays,
  subMonths,
  subYears
} from 'date-fns';
import { isEmpty, last, uniq, uniqBy } from 'lodash';

import { CurrentPositions } from './interfaces/current-positions.interface';
import {
  HistoricalDataContainer,
  PortfolioPositionDetail
} from './interfaces/portfolio-position-detail.interface';
import { PortfolioCalculator } from './portfolio-calculator';
import { RulesService } from './rules.service';

const asiaPacificMarkets = require('../../assets/countries/asia-pacific-markets.json');
const developedMarkets = require('../../assets/countries/developed-markets.json');
const emergingMarkets = require('../../assets/countries/emerging-markets.json');
const europeMarkets = require('../../assets/countries/europe-markets.json');

@Injectable()
export class PortfolioService {
  public constructor(
    private readonly accountBalanceService: AccountBalanceService,
    private readonly accountService: AccountService,
    private readonly currentRateService: CurrentRateService,
    private readonly dataProviderService: DataProviderService,
    private readonly exchangeRateDataService: ExchangeRateDataService,
    private readonly impersonationService: ImpersonationService,
    private readonly orderService: OrderService,
    @Inject(REQUEST) private readonly request: RequestWithUser,
    private readonly rulesService: RulesService,
    private readonly symbolProfileService: SymbolProfileService,
    private readonly userService: UserService
  ) {}

  @LogPerformance
  public async getAccounts({
    filters,
    userId,
    withExcludedAccounts = false
  }: {
    filters?: Filter[];
    userId: string;
    withExcludedAccounts?: boolean;
  }): Promise<AccountWithValue[]> {
    const where: Prisma.AccountWhereInput = { userId };

    const accountFilter = filters?.find(({ type }) => {
      return type === 'ACCOUNT';
    });

    if (accountFilter) {
      where.id = accountFilter.id;
    }

    const [accounts, details] = await Promise.all([
      this.accountService.accounts({
        where,
        include: { Order: true, Platform: true },
        orderBy: { name: 'asc' }
      }),
      this.getDetails({
        filters,
        withExcludedAccounts,
        impersonationId: userId,
        userId: this.request.user.id
      })
    ]);

    const userCurrency = this.request.user.Settings.settings.baseCurrency;

    return accounts.map((account) => {
      let transactionCount = 0;

      for (const order of account.Order) {
        if (!order.isDraft) {
          transactionCount += 1;
        }
      }

      const valueInBaseCurrency =
        details.accounts[account.id]?.valueInBaseCurrency ?? 0;

      const result = {
        ...account,
        transactionCount,
        valueInBaseCurrency,
        balanceInBaseCurrency: this.exchangeRateDataService.toCurrency(
          account.balance,
          account.currency,
          userCurrency
        ),
        value: this.exchangeRateDataService.toCurrency(
          valueInBaseCurrency,
          userCurrency,
          account.currency
        )
      };

      delete result.Order;

      return result;
    });
  }

  @LogPerformance
  public async getAccountsWithAggregations({
    filters,
    userId,
    withExcludedAccounts = false
  }: {
    filters?: Filter[];
    userId: string;
    withExcludedAccounts?: boolean;
  }): Promise<Accounts> {
    const accounts = await this.getAccounts({
      filters,
      userId,
      withExcludedAccounts
    });
    let totalBalanceInBaseCurrency = new Big(0);
    let totalValueInBaseCurrency = new Big(0);
    let transactionCount = 0;

    for (const account of accounts) {
      totalBalanceInBaseCurrency = totalBalanceInBaseCurrency.plus(
        account.balanceInBaseCurrency
      );
      totalValueInBaseCurrency = totalValueInBaseCurrency.plus(
        account.valueInBaseCurrency
      );
      transactionCount += account.transactionCount;
    }

    return {
      accounts,
      transactionCount,
      totalBalanceInBaseCurrency: totalBalanceInBaseCurrency.toNumber(),
      totalValueInBaseCurrency: totalValueInBaseCurrency.toNumber()
    };
  }

  @LogPerformance
  public async getDividends({
    dateRange,
    filters,
    groupBy,
    impersonationId
  }: {
    dateRange: DateRange;
    filters?: Filter[];
    groupBy?: GroupBy;
    impersonationId: string;
  }): Promise<InvestmentItem[]> {
    const userId = await this.getUserId(impersonationId, this.request.user.id);
    const user = await this.userService.user({ id: userId });
    const userCurrency = this.getUserCurrency(user);

    const { activities } = await this.orderService.getOrders({
      filters,
      userCurrency,
      userId,
      types: ['DIVIDEND']
    });

    let dividends = activities.map(({ date, valueInBaseCurrency }) => {
      return {
        date: format(date, DATE_FORMAT),
        investment: valueInBaseCurrency
      };
    });

    if (groupBy) {
      dividends = this.getDividendsByGroup({ dividends, groupBy });
    }

    const startDate = this.getStartDate(
      dateRange,
      parseDate(dividends[0]?.date)
    );

    return dividends.filter(({ date }) => {
      return !isBefore(parseDate(date), startDate);
    });
  }

  @LogPerformance
  public async getInvestments({
    dateRange,
    filters,
    groupBy,
    impersonationId,
    savingsRate
  }: {
    dateRange: DateRange;
    filters?: Filter[];
    groupBy?: GroupBy;
    impersonationId: string;
    savingsRate: number;
  }): Promise<PortfolioInvestments> {
    const userId = await this.getUserId(impersonationId, this.request.user.id);

    const { portfolioOrders, transactionPoints } =
      await this.getTransactionPoints({
        filters,
        userId,
        includeDrafts: true,
        types: ['BUY', 'SELL']
      });

    if (transactionPoints.length === 0) {
      return {
        investments: [],
        streaks: { currentStreak: 0, longestStreak: 0 }
      };
    }

    const portfolioCalculator = new PortfolioCalculator({
      currency: this.request.user.Settings.settings.baseCurrency,
      currentRateService: this.currentRateService,
      exchangeRateDataService: this.exchangeRateDataService,
      orders: portfolioOrders
    });

    portfolioCalculator.setTransactionPoints(transactionPoints);

    const { items } = await this.getChart({
      dateRange,
      impersonationId,
      portfolioOrders,
      transactionPoints,
      userCurrency: this.request.user.Settings.settings.baseCurrency,
      userId,
      calculateTimeWeightedPerformance: false,
      withDataDecimation: false
    });

    let investments = items.map(
      ({ date, investmentValueWithCurrencyEffect }) => {
        return {
          date,
          investment: investmentValueWithCurrencyEffect
        };
      }
    );

    let streaks: PortfolioInvestments['streaks'];

    if (savingsRate) {
      streaks = this.getStreaks({
        investments,
        savingsRate: groupBy === 'year' ? 12 * savingsRate : savingsRate
      });
    }

    return {
      investments,
      streaks
    };
  }

  @LogPerformance
  public async getDetails({
    dateRange = 'max',
    filters,
    impersonationId,
    userId,
    withExcludedAccounts = false,
    isAllocation = false
  }: {
    dateRange?: DateRange;
    filters?: Filter[];
    impersonationId: string;
    userId: string;
    withExcludedAccounts?: boolean;
    isAllocation?: boolean;
  }): Promise<PortfolioDetails & { hasErrors: boolean }> {
    userId = await this.getUserId(impersonationId, userId);
    const user = await this.userService.user({ id: userId });
    const userCurrency = this.getUserCurrency(user);

    const emergencyFund = new Big(
      (user.Settings?.settings as UserSettings)?.emergencyFund ?? 0
    );

    const { orders, portfolioOrders, transactionPoints } =
      await this.getTransactionPoints({
        filters,
        userId,
        withExcludedAccounts
      });

    const portfolioCalculator = new PortfolioCalculator({
      currency: userCurrency,
      currentRateService: this.currentRateService,
      exchangeRateDataService: this.exchangeRateDataService,
      orders: portfolioOrders
    });

    portfolioCalculator.setTransactionPoints(transactionPoints);

    const portfolioStart = parseDate(
      transactionPoints[0]?.date ?? format(new Date(), DATE_FORMAT)
    );
    const startDate = this.getStartDate(dateRange, portfolioStart);
    const currentPositions = await portfolioCalculator.getCurrentPositions(
      startDate,
      new Date(Date.now()),
      !isAllocation
    );

    const cashDetails = await this.accountService.getCashDetails({
      filters,
      userId,
      currency: userCurrency
    });

    const holdings: PortfolioDetails['holdings'] = {};
    const totalValueInBaseCurrency = currentPositions.currentValue.plus(
      cashDetails.balanceInBaseCurrency
    );

    const isFilteredByAccount =
      filters?.some((filter) => {
        return filter.type === 'ACCOUNT';
      }) ?? false;

    let filteredValueInBaseCurrency = isFilteredByAccount
      ? totalValueInBaseCurrency
      : currentPositions.currentValue;

    if (
      filters?.length === 0 ||
      (filters?.length === 1 &&
        filters[0].type === 'ASSET_CLASS' &&
        filters[0].id === 'CASH')
    ) {
      filteredValueInBaseCurrency = filteredValueInBaseCurrency.plus(
        cashDetails.balanceInBaseCurrency
      );
    }

    const dataGatheringItems = currentPositions.positions.map(
      ({ dataSource, symbol }) => {
        return {
          dataSource,
          symbol
        };
      }
    );

    const [dataProviderResponses, symbolProfiles] = await Promise.all([
      this.dataProviderService.getQuotes({ user, items: dataGatheringItems }),
      this.symbolProfileService.getSymbolProfiles(dataGatheringItems)
    ]);

    const symbolProfileMap: { [symbol: string]: EnhancedSymbolProfile } = {};
    for (const symbolProfile of symbolProfiles) {
      symbolProfileMap[symbolProfile.symbol] = symbolProfile;
    }

    const portfolioItemsNow: { [symbol: string]: TimelinePosition } = {};

    this.handlePositions(
      currentPositions,
      portfolioItemsNow,
      symbolProfileMap,
      dataProviderResponses,
      holdings,
      filteredValueInBaseCurrency
    );

    await this.handleCashPosition(
      filters,
      isFilteredByAccount,
      cashDetails,
      userCurrency,
      filteredValueInBaseCurrency,
      holdings
    );

    const { accounts, platforms } = await this.getValueOfAccountsAndPlatforms({
      filters,
      orders,
      portfolioItemsNow,
      userCurrency,
      userId,
      withExcludedAccounts
    });

    filteredValueInBaseCurrency = await this.handleEmergencyFunds(
      filters,
      cashDetails,
      userCurrency,
      filteredValueInBaseCurrency,
      emergencyFund,
      orders,
      accounts,
      holdings
    );
    let summary;
    if (!isAllocation) {
      summary = await this.getSummary({
        impersonationId,
        userCurrency,
        userId,
        holdings,
        balanceInBaseCurrency: cashDetails.balanceInBaseCurrency,
        emergencyFundPositionsValueInBaseCurrency:
          this.getEmergencyFundPositionsValueInBaseCurrency({
            holdings
          })
      });
    }

    var netWorth =
      summary?.netWorth ??
      (await this.getNetWorth(impersonationId, userId, userCurrency));

    return {
      accounts,
      holdings,
      platforms,
      summary,
      filteredValueInBaseCurrency: filteredValueInBaseCurrency.toNumber(),
      filteredValueInPercentage: netWorth
        ? filteredValueInBaseCurrency.div(netWorth).toNumber()
        : 0,
      hasErrors: currentPositions.hasErrors,
      totalValueInBaseCurrency: netWorth
    };
  }

  @LogPerformance
  private handlePositions(
    currentPositions: CurrentPositions,
    portfolioItemsNow: { [symbol: string]: TimelinePosition },
    symbolProfileMap: { [symbol: string]: EnhancedSymbolProfile },
    dataProviderResponses: {
      [symbol: string]: IDataProviderResponse;
    },
    holdings: { [symbol: string]: PortfolioPosition },
    filteredValueInBaseCurrency: Big
  ) {
    for (const item of currentPositions.positions) {
      portfolioItemsNow[item.symbol] = item;
      if (item.quantity.lte(0)) {
        // Ignore positions without any quantity
        continue;
      }

      const value = item.quantity.mul(item.marketPriceInBaseCurrency ?? 0);
      const symbolProfile = symbolProfileMap[item.symbol];
      const dataProviderResponse = dataProviderResponses[item.symbol];

      const markets: PortfolioPosition['markets'] = {
        [UNKNOWN_KEY]: 0,
        developedMarkets: 0,
        emergingMarkets: 0,
        otherMarkets: 0
      };
      const marketsAdvanced: PortfolioPosition['marketsAdvanced'] = {
        [UNKNOWN_KEY]: 0,
        asiaPacific: 0,
        emergingMarkets: 0,
        europe: 0,
        japan: 0,
        northAmerica: 0,
        otherMarkets: 0
      };

      this.calculateMarketsAllocation(
        symbolProfile,
        markets,
        marketsAdvanced,
        value
      );

      holdings[item.symbol] = {
        markets,
        marketsAdvanced,
        allocationInPercentage: filteredValueInBaseCurrency.eq(0)
          ? 0
          : value.div(filteredValueInBaseCurrency).toNumber(),
        assetClass: symbolProfile.assetClass,
        assetSubClass: symbolProfile.assetSubClass,
        countries: symbolProfile.countries,
        currency: item.currency,
        dataSource: symbolProfile.dataSource,
        dateOfFirstActivity: parseDate(item.firstBuyDate),
        grossPerformance: item.grossPerformance?.toNumber() ?? 0,
        grossPerformancePercent:
          item.grossPerformancePercentage?.toNumber() ?? 0,
        grossPerformancePercentWithCurrencyEffect:
          item.grossPerformancePercentageWithCurrencyEffect?.toNumber() ?? 0,
        grossPerformanceWithCurrencyEffect:
          item.grossPerformanceWithCurrencyEffect?.toNumber() ?? 0,
        investment: item.investment.toNumber(),
        marketPrice: item.marketPrice,
        marketState: dataProviderResponse?.marketState ?? 'delayed',
        name: symbolProfile.name,
        netPerformance: item.netPerformance?.toNumber() ?? 0,
        netPerformancePercent: item.netPerformancePercentage?.toNumber() ?? 0,
        netPerformancePercentWithCurrencyEffect:
          item.netPerformancePercentageWithCurrencyEffect?.toNumber() ?? 0,
        netPerformanceWithCurrencyEffect:
          item.netPerformanceWithCurrencyEffect?.toNumber() ?? 0,
        quantity: item.quantity.toNumber(),
        sectors: symbolProfile.sectors,
        symbol: item.symbol,
        tags: item.tags,
        transactionCount: item.transactionCount,
        url: symbolProfile.url,
        valueInBaseCurrency: value.toNumber()
      };
    }
  }

  @LogPerformance
  private async handleCashPosition(
    filters: Filter[],
    isFilteredByAccount: boolean,
    cashDetails: CashDetails,
    userCurrency: string,
    filteredValueInBaseCurrency: Big,
    holdings: { [symbol: string]: PortfolioPosition }
  ) {
    const isFilteredByCash = filters?.some((filter) => {
      return filter.type === 'ASSET_CLASS' && filter.id === 'CASH';
    });

    if (filters?.length === 0 || isFilteredByAccount || isFilteredByCash) {
      const cashPositions = await this.getCashPositions({
        cashDetails,
        userCurrency,
        value: filteredValueInBaseCurrency
      });

      for (const symbol of Object.keys(cashPositions)) {
        holdings[symbol] = cashPositions[symbol];
      }
    }
  }

  @LogPerformance
  private async handleEmergencyFunds(
    filters: Filter[],
    cashDetails: CashDetails,
    userCurrency: string,
    filteredValueInBaseCurrency: Big,
    emergencyFund: Big,
    orders: Activity[],
    accounts: {
      [id: string]: {
        balance: number;
        currency: string;
        name: string;
        valueInBaseCurrency: number;
        valueInPercentage?: number;
      };
    },
    holdings: { [symbol: string]: PortfolioPosition }
  ) {
    if (
      filters?.length === 1 &&
      filters[0].id === EMERGENCY_FUND_TAG_ID &&
      filters[0].type === 'TAG'
    ) {
      const emergencyFundCashPositions = await this.getCashPositions({
        cashDetails,
        userCurrency,
        value: filteredValueInBaseCurrency
      });

      const emergencyFundInCash = emergencyFund
        .minus(
          this.getEmergencyFundPositionsValueInBaseCurrency({
            holdings
          })
        )
        .toNumber();

      filteredValueInBaseCurrency = emergencyFund;

      accounts[UNKNOWN_KEY] = {
        balance: 0,
        currency: userCurrency,
        name: UNKNOWN_KEY,
        valueInBaseCurrency: emergencyFundInCash
      };

      holdings[userCurrency] = {
        ...emergencyFundCashPositions[userCurrency],
        investment: emergencyFundInCash,
        valueInBaseCurrency: emergencyFundInCash
      };
    }
    return filteredValueInBaseCurrency;
  }

  @LogPerformance
  private calculateMarketsAllocation(
    symbolProfile: EnhancedSymbolProfile,
    markets: {
      developedMarkets: number;
      emergingMarkets: number;
      otherMarkets: number;
    },
    marketsAdvanced: {
      asiaPacific: number;
      emergingMarkets: number;
      europe: number;
      japan: number;
      northAmerica: number;
      otherMarkets: number;
    },
    value: Big
  ) {
    if (symbolProfile.countries.length > 0) {
      for (const country of symbolProfile.countries) {
        if (developedMarkets.includes(country.code)) {
          markets.developedMarkets = new Big(markets.developedMarkets)
            .plus(country.weight)
            .toNumber();
        } else if (emergingMarkets.includes(country.code)) {
          markets.emergingMarkets = new Big(markets.emergingMarkets)
            .plus(country.weight)
            .toNumber();
        } else {
          markets.otherMarkets = new Big(markets.otherMarkets)
            .plus(country.weight)
            .toNumber();
        }

        if (country.code === 'JP') {
          marketsAdvanced.japan = new Big(marketsAdvanced.japan)
            .plus(country.weight)
            .toNumber();
        } else if (country.code === 'CA' || country.code === 'US') {
          marketsAdvanced.northAmerica = new Big(marketsAdvanced.northAmerica)
            .plus(country.weight)
            .toNumber();
        } else if (asiaPacificMarkets.includes(country.code)) {
          marketsAdvanced.asiaPacific = new Big(marketsAdvanced.asiaPacific)
            .plus(country.weight)
            .toNumber();
        } else if (emergingMarkets.includes(country.code)) {
          marketsAdvanced.emergingMarkets = new Big(
            marketsAdvanced.emergingMarkets
          )
            .plus(country.weight)
            .toNumber();
        } else if (europeMarkets.includes(country.code)) {
          marketsAdvanced.europe = new Big(marketsAdvanced.europe)
            .plus(country.weight)
            .toNumber();
        } else {
          marketsAdvanced.otherMarkets = new Big(marketsAdvanced.otherMarkets)
            .plus(country.weight)
            .toNumber();
        }
      }
    } else {
      markets[UNKNOWN_KEY] = new Big(markets[UNKNOWN_KEY])
        .plus(value)
        .toNumber();

      marketsAdvanced[UNKNOWN_KEY] = new Big(marketsAdvanced[UNKNOWN_KEY])
        .plus(value)
        .toNumber();
    }
  }

  @LogPerformance
  public async getPosition(
    aDataSource: DataSource,
    aImpersonationId: string,
    aSymbol: string
  ): Promise<PortfolioPositionDetail> {
    const userId = await this.getUserId(aImpersonationId, this.request.user.id);
    const user = await this.userService.user({ id: userId });
    const userCurrency = this.getUserCurrency(user);

    const { activities } = await this.orderService.getOrders({
      userCurrency,
      userId,
      withExcludedAccounts: true
    });

    const orders = activities.filter(({ SymbolProfile }) => {
      return (
        SymbolProfile.dataSource === aDataSource &&
        SymbolProfile.symbol === aSymbol
      );
    });

    let tags: Tag[] = [];

    if (orders.length <= 0) {
      return {
        tags,
        accounts: [],
        averagePrice: undefined,
        dataProviderInfo: undefined,
        dividendInBaseCurrency: undefined,
        stakeRewards: undefined,
        feeInBaseCurrency: undefined,
        firstBuyDate: undefined,
        grossPerformance: undefined,
        grossPerformancePercent: undefined,
        grossPerformancePercentWithCurrencyEffect: undefined,
        grossPerformanceWithCurrencyEffect: undefined,
        historicalData: [],
        investment: undefined,
        marketPrice: undefined,
        maxPrice: undefined,
        minPrice: undefined,
        netPerformance: undefined,
        netPerformancePercent: undefined,
        netPerformancePercentWithCurrencyEffect: undefined,
        netPerformanceWithCurrencyEffect: undefined,
        orders: [],
        quantity: undefined,
        SymbolProfile: undefined,
        transactionCount: undefined,
        value: undefined
      };
    }

    const [SymbolProfile] = await this.symbolProfileService.getSymbolProfiles([
      { dataSource: aDataSource, symbol: aSymbol }
    ]);

    const portfolioOrders: PortfolioOrder[] = orders
      .filter((order) => {
        tags = tags.concat(order.tags);

        return (
          order.type === 'BUY' ||
          order.type === 'SELL' ||
          order.type === 'STAKE' ||
          order.type === 'ITEM'
        );
      })
      .map((order) => ({
        currency: order.SymbolProfile.currency,
        dataSource: order.SymbolProfile.dataSource,
        date: format(order.date, DATE_FORMAT),
        fee: new Big(order.fee),
        name: order.SymbolProfile?.name,
        quantity: new Big(order.quantity),
        symbol: order.SymbolProfile.symbol,
        tags: order.tags,
        type: order.type,
        unitPrice: new Big(order.unitPrice)
      }));

    tags = uniqBy(tags, 'id');

    const portfolioCalculator = new PortfolioCalculator({
      currency: userCurrency,
      currentRateService: this.currentRateService,
      exchangeRateDataService: this.exchangeRateDataService,
      orders: portfolioOrders
    });

    portfolioCalculator.computeTransactionPoints();
    const transactionPoints = portfolioCalculator.getTransactionPoints();

    const portfolioStart = parseDate(transactionPoints[0].date);

    const currentPositions =
      await portfolioCalculator.getCurrentPositions(portfolioStart);

    const position = currentPositions.positions.find(({ symbol }) => {
      return symbol === aSymbol;
    });

    if (position) {
      const {
        averagePrice,
        currency,
        dataSource,
        fee,
        firstBuyDate,
        marketPrice,
        quantity,
        transactionCount
      } = position;

      const accounts: PortfolioPositionDetail['accounts'] = uniqBy(
        orders.filter(({ Account }) => {
          return Account;
        }),
        'Account.id'
      ).map(({ Account }) => {
        return Account;
      });

      const dividendInBaseCurrency = getSum(
        orders
          .filter(({ type }) => {
            return type === 'DIVIDEND';
          })
          .map(({ valueInBaseCurrency }) => {
            return new Big(valueInBaseCurrency);
          })
      );

      const stakeRewards = getSum(
        orders
          .filter(({ type }) => {
            return type === 'STAKE';
          })
          .map(({ quantity }) => {
            return new Big(quantity);
          })
      );

      // Convert investment, gross and net performance to currency of user
      const investment = this.exchangeRateDataService.toCurrency(
        position.investment?.toNumber(),
        currency,
        userCurrency
      );
      const grossPerformance = this.exchangeRateDataService.toCurrency(
        position.grossPerformance?.toNumber(),
        currency,
        userCurrency
      );
      const netPerformance = this.exchangeRateDataService.toCurrency(
        position.netPerformance?.toNumber(),
        currency,
        userCurrency
      );

      const historicalData = await this.dataProviderService.getHistorical(
        [{ dataSource, symbol: aSymbol }],
        'day',
        parseISO(firstBuyDate),
        new Date()
      );

      const historicalDataArray: HistoricalDataItem[] = [];
      let maxPrice = Math.max(orders[0].unitPrice, marketPrice);
      let minPrice = Math.min(orders[0].unitPrice, marketPrice);

      if (historicalData[aSymbol]) {
        let j = -1;
        for (const [date, { marketPrice }] of Object.entries(
          historicalData[aSymbol]
        )) {
          while (
            j + 1 < transactionPoints.length &&
            !isAfter(parseDate(transactionPoints[j + 1].date), parseDate(date))
          ) {
            j++;
          }

          let currentAveragePrice = 0;
          let currentQuantity = 0;

          const currentSymbol = transactionPoints[j]?.items.find(
            ({ symbol }) => {
              return symbol === aSymbol;
            }
          );

          if (currentSymbol) {
            currentAveragePrice = currentSymbol.quantity.eq(0)
              ? 0
              : currentSymbol.investment.div(currentSymbol.quantity).toNumber();
            currentQuantity = currentSymbol.quantity.toNumber();
          }

          historicalDataArray.push({
            date,
            averagePrice: currentAveragePrice,
            marketPrice:
              historicalDataArray.length > 0
                ? marketPrice
                : currentAveragePrice,
            quantity: currentQuantity
          });

          maxPrice = Math.max(marketPrice ?? 0, maxPrice);
          minPrice = Math.min(marketPrice ?? Number.MAX_SAFE_INTEGER, minPrice);
        }
      } else {
        // Add historical entry for buy date, if no historical data available
        historicalDataArray.push({
          averagePrice: orders[0].unitPrice,
          date: firstBuyDate,
          marketPrice: orders[0].unitPrice,
          quantity: orders[0].quantity
        });
      }

      return {
        accounts,
        firstBuyDate,
        marketPrice,
        maxPrice,
        minPrice,
        orders,
        SymbolProfile,
        tags,
        transactionCount,
        averagePrice: averagePrice.toNumber(),
        dataProviderInfo: portfolioCalculator.getDataProviderInfos()?.[0],
        dividendInBaseCurrency: dividendInBaseCurrency.toNumber(),
        stakeRewards: stakeRewards.toNumber(),
        feeInBaseCurrency: this.exchangeRateDataService.toCurrency(
          fee.toNumber(),
          SymbolProfile.currency,
          userCurrency
        ),
        grossPerformance: position.grossPerformance?.toNumber(),
        grossPerformancePercent:
          position.grossPerformancePercentage?.toNumber(),
        grossPerformancePercentWithCurrencyEffect:
          position.grossPerformancePercentageWithCurrencyEffect?.toNumber(),
        grossPerformanceWithCurrencyEffect:
          position.grossPerformanceWithCurrencyEffect?.toNumber(),
        historicalData: historicalDataArray,
        investment: position.investment?.toNumber(),
        netPerformance: position.netPerformance?.toNumber(),
        netPerformancePercent: position.netPerformancePercentage?.toNumber(),
        netPerformancePercentWithCurrencyEffect:
          position.netPerformancePercentageWithCurrencyEffect?.toNumber(),
        netPerformanceWithCurrencyEffect:
          position.netPerformanceWithCurrencyEffect?.toNumber(),
        quantity: quantity.toNumber(),
        value: this.exchangeRateDataService.toCurrency(
          quantity.mul(marketPrice ?? 0).toNumber(),
          currency,
          userCurrency
        )
      };
    } else {
      const currentData = await this.dataProviderService.getQuotes({
        user,
        items: [{ dataSource: DataSource.YAHOO, symbol: aSymbol }]
      });
      const marketPrice = currentData[aSymbol]?.marketPrice;

      let historicalData = await this.dataProviderService.getHistorical(
        [{ dataSource: DataSource.YAHOO, symbol: aSymbol }],
        'day',
        portfolioStart,
        new Date()
      );

      if (isEmpty(historicalData)) {
        historicalData = await this.dataProviderService.getHistoricalRaw(
          [{ dataSource: DataSource.YAHOO, symbol: aSymbol }],
          portfolioStart,
          new Date()
        );
      }

      const historicalDataArray: HistoricalDataItem[] = [];
      let maxPrice = marketPrice;
      let minPrice = marketPrice;

      for (const [date, { marketPrice }] of Object.entries(
        historicalData[aSymbol]
      )) {
        historicalDataArray.push({
          date,
          value: marketPrice
        });

        maxPrice = Math.max(marketPrice ?? 0, maxPrice);
        minPrice = Math.min(marketPrice ?? Number.MAX_SAFE_INTEGER, minPrice);
      }

      return {
        marketPrice,
        maxPrice,
        minPrice,
        orders,
        SymbolProfile,
        tags,
        accounts: [],
        averagePrice: 0,
        dataProviderInfo: undefined,
        dividendInBaseCurrency: 0,
        stakeRewards: 0,
        feeInBaseCurrency: 0,
        firstBuyDate: undefined,
        grossPerformance: undefined,
        grossPerformancePercent: undefined,
        grossPerformancePercentWithCurrencyEffect: undefined,
        grossPerformanceWithCurrencyEffect: undefined,
        historicalData: historicalDataArray,
        investment: 0,
        netPerformance: undefined,
        netPerformancePercent: undefined,
        netPerformancePercentWithCurrencyEffect: undefined,
        netPerformanceWithCurrencyEffect: undefined,
        quantity: 0,
        transactionCount: undefined,
        value: 0
      };
    }
  }

  @LogPerformance
  public async getPositions({
    dateRange = 'max',
    filters,
    impersonationId
  }: {
    dateRange?: DateRange;
    filters?: Filter[];
    impersonationId: string;
  }): Promise<{ hasErrors: boolean; positions: Position[] }> {
    const searchQuery = filters.find(({ type }) => {
      return type === 'SEARCH_QUERY';
    })?.id;
    const userId = await this.getUserId(impersonationId, this.request.user.id);
    const user = await this.userService.user({ id: userId });

    const { portfolioOrders, transactionPoints } =
      await this.getTransactionPoints({
        filters,
        userId,
        types: ['BUY', 'SELL']
      });

    if (transactionPoints?.length <= 0) {
      return {
        hasErrors: false,
        positions: []
      };
    }

    const portfolioCalculator = new PortfolioCalculator({
      currency: this.request.user.Settings.settings.baseCurrency,
      currentRateService: this.currentRateService,
      exchangeRateDataService: this.exchangeRateDataService,
      orders: portfolioOrders
    });

    portfolioCalculator.setTransactionPoints(transactionPoints);

    const portfolioStart = parseDate(transactionPoints[0].date);
    const startDate = this.getStartDate(dateRange, portfolioStart);
    const currentPositions =
      await portfolioCalculator.getCurrentPositions(startDate);

    let positions = currentPositions.positions.filter(({ quantity }) => {
      return !quantity.eq(0);
    });

    const dataGatheringItems = positions.map(({ dataSource, symbol }) => {
      return {
        dataSource,
        symbol
      };
    });

    const [dataProviderResponses, symbolProfiles] = await Promise.all([
      this.dataProviderService.getQuotes({ user, items: dataGatheringItems }),
      this.symbolProfileService.getSymbolProfiles(
        positions.map(({ dataSource, symbol }) => {
          return { dataSource, symbol };
        })
      )
    ]);

    const symbolProfileMap: { [symbol: string]: EnhancedSymbolProfile } = {};

    for (const symbolProfile of symbolProfiles) {
      symbolProfileMap[symbolProfile.symbol] = symbolProfile;
    }

    if (searchQuery) {
      positions = positions.filter(({ symbol }) => {
        const enhancedSymbolProfile = symbolProfileMap[symbol];

        return (
          enhancedSymbolProfile.isin?.toLowerCase().startsWith(searchQuery) ||
          enhancedSymbolProfile.name?.toLowerCase().startsWith(searchQuery) ||
          enhancedSymbolProfile.symbol?.toLowerCase().startsWith(searchQuery)
        );
      });
    }

    return {
      hasErrors: currentPositions.hasErrors,
      positions: positions.map(
        ({
          averagePrice,
          currency,
          dataSource,
          firstBuyDate,
          grossPerformance,
          grossPerformancePercentage,
          grossPerformancePercentageWithCurrencyEffect,
          grossPerformanceWithCurrencyEffect,
          investment,
          investmentWithCurrencyEffect,
          netPerformance,
          netPerformancePercentage,
          netPerformancePercentageWithCurrencyEffect,
          netPerformanceWithCurrencyEffect,
          quantity,
          symbol,
          timeWeightedInvestment,
          timeWeightedInvestmentWithCurrencyEffect,
          transactionCount
        }) => {
          return {
            currency,
            dataSource,
            firstBuyDate,
            symbol,
            transactionCount,
            assetClass: symbolProfileMap[symbol].assetClass,
            assetSubClass: symbolProfileMap[symbol].assetSubClass,
            averagePrice: averagePrice.toNumber(),
            grossPerformance: grossPerformance?.toNumber() ?? null,
            grossPerformancePercentage:
              grossPerformancePercentage?.toNumber() ?? null,
            grossPerformancePercentageWithCurrencyEffect:
              grossPerformancePercentageWithCurrencyEffect?.toNumber() ?? null,
            grossPerformanceWithCurrencyEffect:
              grossPerformanceWithCurrencyEffect?.toNumber() ?? null,
            investment: investment.toNumber(),
            investmentWithCurrencyEffect:
              investmentWithCurrencyEffect?.toNumber(),
            marketState:
              dataProviderResponses[symbol]?.marketState ?? 'delayed',
            name: symbolProfileMap[symbol].name,
            netPerformance: netPerformance?.toNumber() ?? null,
            tags: symbolProfileMap[symbol].tags,
            netPerformancePercentage:
              netPerformancePercentage?.toNumber() ?? null,
            netPerformancePercentageWithCurrencyEffect:
              netPerformancePercentageWithCurrencyEffect?.toNumber() ?? null,
            netPerformanceWithCurrencyEffect:
              netPerformanceWithCurrencyEffect?.toNumber() ?? null,
            quantity: quantity.toNumber(),
            timeWeightedInvestment: timeWeightedInvestment?.toNumber(),
            timeWeightedInvestmentWithCurrencyEffect:
              timeWeightedInvestmentWithCurrencyEffect?.toNumber()
          };
        }
      )
    };
  }

  @LogPerformance
  public async getPerformance({
    dateRange = 'max',
    filters,
    impersonationId,
    userId,
    withExcludedAccounts = false,
    calculateTimeWeightedPerformance = false,
    withItems = false
  }: {
    dateRange?: DateRange;
    filters?: Filter[];
    impersonationId: string;
    userId: string;
    withExcludedAccounts?: boolean;
    calculateTimeWeightedPerformance?: boolean;
    withItems?: boolean;
  }): Promise<PortfolioPerformanceResponse> {
    userId = await this.getUserId(impersonationId, userId);
    const user = await this.userService.user({ id: userId });
    const userCurrency = this.getUserCurrency(user);

    const accountBalances = await this.accountBalanceService.getAccountBalances(
      { filters, user, withExcludedAccounts }
    );

    let accountBalanceItems: HistoricalDataItem[] = Object.values(
      // Reduce the array to a map with unique dates as keys
      accountBalances.balances.reduce(
        (
          map: { [date: string]: HistoricalDataItem },
          { date, valueInBaseCurrency }
        ) => {
          const formattedDate = format(date, DATE_FORMAT);

          // Store the item in the map, overwriting if the date already exists
          map[formattedDate] = {
            date: formattedDate,
            value: valueInBaseCurrency
          };

          return map;
        },
        {}
      )
    );

    const { portfolioOrders, transactionPoints } =
      await this.getTransactionPoints({
        filters,
        userId,
        withExcludedAccounts,
        types: withItems
          ? ['BUY', 'ITEM', 'STAKE', 'SELL']
          : ['BUY', 'STAKE', 'SELL']
      });

    const portfolioCalculator = new PortfolioCalculator({
      currency: userCurrency,
      currentRateService: this.currentRateService,
      exchangeRateDataService: this.exchangeRateDataService,
      orders: portfolioOrders
    });

    if (accountBalanceItems?.length <= 0 && transactionPoints?.length <= 0) {
      return {
        chart: [],
        firstOrderDate: undefined,
        hasErrors: false,
        performance: {
          currentGrossPerformance: 0,
          currentGrossPerformancePercent: 0,
          currentGrossPerformancePercentWithCurrencyEffect: 0,
          currentGrossPerformanceWithCurrencyEffect: 0,
          currentNetPerformance: 0,
          currentNetPerformancePercent: 0,
          currentNetPerformancePercentWithCurrencyEffect: 0,
          currentNetPerformanceWithCurrencyEffect: 0,
          currentNetWorth: 0,
          currentValue: 0,
          totalInvestment: 0
        }
      };
    }

    portfolioCalculator.setTransactionPoints(transactionPoints);

    const portfolioStart = min(
      [
        parseDate(accountBalanceItems[0]?.date),
        parseDate(transactionPoints[0]?.date)
      ].filter((date) => {
        return isValid(date);
      })
    );

    const startDate = this.getStartDate(dateRange, portfolioStart);
    const {
      currentValue,
      errors,
      grossPerformance,
      grossPerformancePercentage,
      grossPerformancePercentageWithCurrencyEffect,
      grossPerformanceWithCurrencyEffect,
      hasErrors,
      netPerformance,
      netPerformancePercentage,
      netPerformancePercentageWithCurrencyEffect,
      netPerformanceWithCurrencyEffect,
      totalInvestment
    } = await portfolioCalculator.getCurrentPositions(startDate);

    let currentNetPerformance = netPerformance;

    let currentNetPerformancePercent = netPerformancePercentage;

    let currentNetPerformancePercentWithCurrencyEffect =
      netPerformancePercentageWithCurrencyEffect;

    let currentNetPerformanceWithCurrencyEffect =
      netPerformanceWithCurrencyEffect;

    const { items } = await this.getChart({
      dateRange,
      impersonationId,
      portfolioOrders,
      transactionPoints,
      userCurrency,
      userId,
      calculateTimeWeightedPerformance
    });

    const itemOfToday = items.find(({ date }) => {
      return date === format(new Date(), DATE_FORMAT);
    });

    if (itemOfToday) {
      currentNetPerformance = new Big(itemOfToday.netPerformance);

      currentNetPerformancePercent = new Big(
        itemOfToday.netPerformanceInPercentage
      ).div(100);

      currentNetPerformancePercentWithCurrencyEffect = new Big(
        itemOfToday.netPerformanceInPercentageWithCurrencyEffect
      ).div(100);

      currentNetPerformanceWithCurrencyEffect = new Big(
        itemOfToday.netPerformanceWithCurrencyEffect
      );
    }

    accountBalanceItems = accountBalanceItems.filter(({ date }) => {
      return !isBefore(parseDate(date), startDate);
    });

    const accountBalanceItemOfToday = accountBalanceItems.find(({ date }) => {
      return date === format(new Date(), DATE_FORMAT);
    });

    if (!accountBalanceItemOfToday) {
      accountBalanceItems.push({
        date: format(new Date(), DATE_FORMAT),
        value: last(accountBalanceItems)?.value ?? 0
      });
    }

    const mergedHistoricalDataItems = this.mergeHistoricalDataItems(
      accountBalanceItems,
      items
    );

    const currentHistoricalDataItem = last(mergedHistoricalDataItems);
    const currentNetWorth = currentHistoricalDataItem?.netWorth ?? 0;

    return {
      errors,
      hasErrors,
      chart: mergedHistoricalDataItems,
      firstOrderDate: parseDate(items[0]?.date),
      performance: {
        currentNetWorth,
        currentGrossPerformance: grossPerformance.toNumber(),
        currentGrossPerformancePercent: grossPerformancePercentage.toNumber(),
        currentGrossPerformancePercentWithCurrencyEffect:
          grossPerformancePercentageWithCurrencyEffect.toNumber(),
        currentGrossPerformanceWithCurrencyEffect:
          grossPerformanceWithCurrencyEffect.toNumber(),
        currentNetPerformance: currentNetPerformance.toNumber(),
        currentNetPerformancePercent: currentNetPerformancePercent.toNumber(),
        currentNetPerformancePercentWithCurrencyEffect:
          currentNetPerformancePercentWithCurrencyEffect.toNumber(),
        currentNetPerformanceWithCurrencyEffect:
          currentNetPerformanceWithCurrencyEffect.toNumber(),
        currentValue: currentValue.toNumber(),
        totalInvestment: totalInvestment.toNumber()
      }
    };
  }

  @LogPerformance
  public async getReport(impersonationId: string): Promise<PortfolioReport> {
    const userId = await this.getUserId(impersonationId, this.request.user.id);
    const user = await this.userService.user({ id: userId });
    const userCurrency = this.getUserCurrency(user);

    const { orders, portfolioOrders, transactionPoints } =
      await this.getTransactionPoints({
        userId,
        types: ['BUY', 'SELL']
      });

    const portfolioCalculator = new PortfolioCalculator({
      currency: userCurrency,
      currentRateService: this.currentRateService,
      exchangeRateDataService: this.exchangeRateDataService,
      orders: portfolioOrders
    });

    portfolioCalculator.setTransactionPoints(transactionPoints);

    const portfolioStart = parseDate(
      transactionPoints[0]?.date ?? format(new Date(), DATE_FORMAT)
    );
    const currentPositions =
      await portfolioCalculator.getCurrentPositions(portfolioStart);

    const positions = currentPositions.positions.filter(
      (item) => !item.quantity.eq(0)
    );

    const portfolioItemsNow: { [symbol: string]: TimelinePosition } = {};

    for (const position of positions) {
      portfolioItemsNow[position.symbol] = position;
    }

    const { accounts } = await this.getValueOfAccountsAndPlatforms({
      orders,
      portfolioItemsNow,
      userCurrency,
      userId
    });

    const userSettings = <UserSettings>this.request.user.Settings.settings;

    return {
      rules: {
        accountClusterRisk: isEmpty(orders)
          ? undefined
          : await this.rulesService.evaluate(
              [
                new AccountClusterRiskCurrentInvestment(
                  this.exchangeRateDataService,
                  accounts
                ),
                new AccountClusterRiskSingleAccount(
                  this.exchangeRateDataService,
                  accounts
                )
              ],
              userSettings
            ),
        currencyClusterRisk: isEmpty(orders)
          ? undefined
          : await this.rulesService.evaluate(
              [
                new CurrencyClusterRiskBaseCurrencyCurrentInvestment(
                  this.exchangeRateDataService,
                  positions
                ),
                new CurrencyClusterRiskCurrentInvestment(
                  this.exchangeRateDataService,
                  positions
                )
              ],
              userSettings
            ),
        emergencyFund: await this.rulesService.evaluate(
          [
            new EmergencyFundSetup(
              this.exchangeRateDataService,
              userSettings.emergencyFund
            )
          ],
          userSettings
        ),
        fees: await this.rulesService.evaluate(
          [
            new FeeRatioInitialInvestment(
              this.exchangeRateDataService,
              currentPositions.totalInvestment.toNumber(),
              this.getFees({ userCurrency, activities: orders }).toNumber()
            )
          ],
          userSettings
        )
      }
    };
  }

  @LogPerformance
  private async getCashPositions({
    cashDetails,
    userCurrency,
    value
  }: {
    cashDetails: CashDetails;
    userCurrency: string;
    value: Big;
  }) {
    const cashPositions: PortfolioDetails['holdings'] = {
      [userCurrency]: this.getInitialCashPosition({
        balance: 0,
        currency: userCurrency
      })
    };

    for (const account of cashDetails.accounts) {
      const convertedBalance = this.exchangeRateDataService.toCurrency(
        account.balance,
        account.currency,
        userCurrency
      );

      if (convertedBalance === 0) {
        continue;
      }

      if (cashPositions[account.currency]) {
        cashPositions[account.currency].investment += convertedBalance;
        cashPositions[account.currency].valueInBaseCurrency += convertedBalance;
      } else {
        cashPositions[account.currency] = this.getInitialCashPosition({
          balance: convertedBalance,
          currency: account.currency
        });
      }
    }

    for (const symbol of Object.keys(cashPositions)) {
      // Calculate allocations for each currency
      cashPositions[symbol].allocationInPercentage = value.gt(0)
        ? new Big(cashPositions[symbol].valueInBaseCurrency)
            .div(value)
            .toNumber()
        : 0;
    }

    return cashPositions;
  }

  @LogPerformance
  private async getChart({
    dateRange = 'max',
    impersonationId,
    portfolioOrders,
    transactionPoints,
    userCurrency,
    userId,
    calculateTimeWeightedPerformance,
    withDataDecimation = true
  }: {
    dateRange?: DateRange;
    impersonationId: string;
    portfolioOrders: PortfolioOrder[];
    transactionPoints: TransactionPoint[];
    userCurrency: string;
    userId: string;
    calculateTimeWeightedPerformance: boolean;
    withDataDecimation?: boolean;
  }): Promise<HistoricalDataContainer> {
    if (transactionPoints.length === 0) {
      return {
        isAllTimeHigh: false,
        isAllTimeLow: false,
        items: []
      };
    }

    userId = await this.getUserId(impersonationId, userId);

    const portfolioCalculator = new PortfolioCalculator({
      currency: userCurrency,
      currentRateService: this.currentRateService,
      exchangeRateDataService: this.exchangeRateDataService,
      orders: portfolioOrders
    });

    portfolioCalculator.setTransactionPoints(transactionPoints);

    const endDate = new Date();

    const portfolioStart = parseDate(transactionPoints[0].date);
    const startDate = this.getStartDate(dateRange, portfolioStart);

    let step = 1;

    if (withDataDecimation) {
      const daysInMarket = differenceInDays(new Date(), startDate);
      step = Math.round(daysInMarket / Math.min(daysInMarket, MAX_CHART_ITEMS));
    }

    const items = await portfolioCalculator.getChartData({
      start: startDate,
      end: endDate,
      step,
      calculateTimeWeightedPerformance
    });

    return {
      items,
      isAllTimeHigh: false,
      isAllTimeLow: false
    };
  }

  @LogPerformance
  private getDividendsByGroup({
    dividends,
    groupBy
  }: {
    dividends: InvestmentItem[];
    groupBy: GroupBy;
  }): InvestmentItem[] {
    if (dividends.length === 0) {
      return [];
    }

    const dividendsByGroup: InvestmentItem[] = [];
    let currentDate: Date;
    let investmentByGroup = new Big(0);

    for (const [index, dividend] of dividends.entries()) {
      if (
        isSameYear(parseDate(dividend.date), currentDate) &&
        (groupBy === 'year' ||
          isSameMonth(parseDate(dividend.date), currentDate))
      ) {
        // Same group: Add up dividends

        investmentByGroup = investmentByGroup.plus(dividend.investment);
      } else {
        // New group: Store previous group and reset

        if (currentDate) {
          dividendsByGroup.push({
            date: format(
              set(currentDate, {
                date: 1,
                month: groupBy === 'year' ? 0 : currentDate.getMonth()
              }),
              DATE_FORMAT
            ),
            investment: investmentByGroup.toNumber()
          });
        }

        currentDate = parseDate(dividend.date);
        investmentByGroup = new Big(dividend.investment);
      }

      if (index === dividends.length - 1) {
        // Store current month (latest order)
        dividendsByGroup.push({
          date: format(
            set(currentDate, {
              date: 1,
              month: groupBy === 'year' ? 0 : currentDate.getMonth()
            }),
            DATE_FORMAT
          ),
          investment: investmentByGroup.toNumber()
        });
      }
    }

    return dividendsByGroup;
  }

  @LogPerformance
  private getEmergencyFundPositionsValueInBaseCurrency({
    holdings
  }: {
    holdings: PortfolioDetails['holdings'];
  }) {
    const emergencyFundHoldings = Object.values(holdings).filter(({ tags }) => {
      return (
        tags?.some(({ id }) => {
          return id === EMERGENCY_FUND_TAG_ID;
        }) ?? false
      );
    });

    let valueInBaseCurrencyOfEmergencyFundPositions = new Big(0);

    for (const { valueInBaseCurrency } of emergencyFundHoldings) {
      valueInBaseCurrencyOfEmergencyFundPositions =
        valueInBaseCurrencyOfEmergencyFundPositions.plus(valueInBaseCurrency);
    }

    return valueInBaseCurrencyOfEmergencyFundPositions.toNumber();
  }

  @LogPerformance
  private getFees({
    activities,
    date = new Date(0),
    userCurrency
  }: {
    activities: OrderWithAccount[];
    date?: Date;
    userCurrency: string;
  }) {
    return activities
      .filter((activity) => {
        // Filter out all activities before given date (drafts)
        return isBefore(date, new Date(activity.date));
      })
      .map(({ fee, SymbolProfile }) => {
        return this.exchangeRateDataService.toCurrency(
          fee,
          SymbolProfile.currency,
          userCurrency
        );
      })
      .reduce(
        (previous, current) => new Big(previous).plus(current),
        new Big(0)
      );
  }

  @LogPerformance
  private getInitialCashPosition({
    balance,
    currency
  }: {
    balance: number;
    currency: string;
  }): PortfolioPosition {
    return {
      currency,
      allocationInPercentage: 0,
      assetClass: AssetClass.CASH,
      assetSubClass: AssetClass.CASH,
      countries: [],
      dataSource: undefined,
      dateOfFirstActivity: undefined,
      grossPerformance: 0,
      grossPerformancePercent: 0,
      grossPerformancePercentWithCurrencyEffect: 0,
      grossPerformanceWithCurrencyEffect: 0,
      investment: balance,
      marketPrice: 0,
      marketState: 'open',
      name: currency,
      netPerformance: 0,
      netPerformancePercent: 0,
      netPerformancePercentWithCurrencyEffect: 0,
      netPerformanceWithCurrencyEffect: 0,
      quantity: 0,
      sectors: [],
      symbol: currency,
      tags: [],
      transactionCount: 0,
      valueInBaseCurrency: balance
    };
  }

  @LogPerformance
  private getStartDate(aDateRange: DateRange, portfolioStart: Date) {
    switch (aDateRange) {
      case '1d':
        portfolioStart = max([
          portfolioStart,
          subDays(new Date().setHours(0, 0, 0, 0), 1)
        ]);
        break;
      case 'mtd':
        portfolioStart = max([
          portfolioStart,
          subDays(startOfMonth(new Date().setHours(0, 0, 0, 0)), 1)
        ]);
        break;
      case 'wtd':
        portfolioStart = max([
          portfolioStart,
          subDays(
            startOfWeek(new Date().setHours(0, 0, 0, 0), { weekStartsOn: 1 }),
            1
          )
        ]);
        break;
      case 'ytd':
        portfolioStart = max([
          portfolioStart,
          subDays(startOfYear(new Date().setHours(0, 0, 0, 0)), 1)
        ]);
        break;

      case '1w':
        portfolioStart = max([
          portfolioStart,
          subDays(new Date().setHours(0, 0, 0, 0), 7)
        ]);
        break;

      case '1m':
        portfolioStart = max([
          portfolioStart,
          subMonths(new Date().setHours(0, 0, 0, 0), 1)
        ]);
        break;

      case '3m':
        portfolioStart = max([
          portfolioStart,
          subMonths(new Date().setHours(0, 0, 0, 0), 3)
        ]);
        break;

      case '1y':
        portfolioStart = max([
          portfolioStart,
          subYears(new Date().setHours(0, 0, 0, 0), 1)
        ]);
        break;
      case '5y':
        portfolioStart = max([
          portfolioStart,
          subYears(new Date().setHours(0, 0, 0, 0), 5)
        ]);
        break;
    }

    return portfolioStart;
  }

  @LogPerformance
  private getStreaks({
    investments,
    savingsRate
  }: {
    investments: InvestmentItem[];
    savingsRate: number;
  }) {
    let currentStreak = 0;
    let longestStreak = 0;

    for (const { investment } of investments) {
      if (investment >= savingsRate) {
        currentStreak++;
        longestStreak = Math.max(longestStreak, currentStreak);
      } else {
        currentStreak = 0;
      }
    }

    return { currentStreak, longestStreak };
  }

  @LogPerformance
  private async getNetWorth(
    impersonationId: string,
    userId: string,
    userCurrency: string
  ) {
    userId = await this.getUserId(impersonationId, userId);

    const { orders, portfolioOrders, transactionPoints } =
      await this.getTransactionPoints({
        userId,
        withExcludedAccounts: true
      });

    const portfolioCalculator = new PortfolioCalculator({
      currency: userCurrency,
      currentRateService: this.currentRateService,
      exchangeRateDataService: this.exchangeRateDataService,
      orders: portfolioOrders
    });

    const portfolioStart = parseDate(
      transactionPoints[0]?.date ?? format(new Date(), DATE_FORMAT)
    );

    portfolioCalculator.setTransactionPoints(transactionPoints);

    const { currentValue } = await portfolioCalculator.getCurrentPositions(
      portfolioStart,
      new Date(Date.now()),
      false
    );

    return currentValue;
  }

  @LogPerformance
  private async getSummary({
    balanceInBaseCurrency,
    emergencyFundPositionsValueInBaseCurrency,
    holdings,
    impersonationId,
    userCurrency,
    userId
  }: {
    balanceInBaseCurrency: number;
    emergencyFundPositionsValueInBaseCurrency: number;
    holdings: PortfolioDetails['holdings'];
    impersonationId: string;
    userCurrency: string;
    userId: string;
  }): Promise<PortfolioSummary> {
    userId = await this.getUserId(impersonationId, userId);
    const user = await this.userService.user({ id: userId });
    let performanceInformation: PortfolioPerformanceResponse = {
      chart: [],
      firstOrderDate: undefined,
      performance: {
        annualizedPerformancePercent: 0,
        currentGrossPerformance: 0,
        currentGrossPerformancePercent: 0,
        currentGrossPerformancePercentWithCurrencyEffect: 0,
        currentGrossPerformanceWithCurrencyEffect: 0,
        currentNetPerformance: 0,
        currentNetPerformancePercent: 0,
        currentNetPerformancePercentWithCurrencyEffect: 0,
        currentNetPerformanceWithCurrencyEffect: 0,
        currentNetWorth: 0,
        currentValue: 0,
        totalInvestment: 0
      },
      errors: [],
      hasErrors: false
    };

    const { activities } = await this.orderService.getOrders({
      userCurrency,
      userId,
      withExcludedAccounts: true
    });
    const excludedActivities: Activity[] = [];
    let dividend = 0;
    let fees = 0;
    let items = 0;
    let interest = 0;

    let liabilities = 0;

    let totalBuy = 0;
    let totalSell = 0;
    let activitiesUsed: Activity[] = [];
    let ordersCount = 0;
    let excludedAccountsAndActivities = 0;
    const firstOrderDate = activities[0]?.date;

    performanceInformation = await this.getPerformance({
      impersonationId,
      userId
    });
    for (let order of activities) {
      if (order.Account?.isExcluded ?? false) {
        excludedActivities.push(order);
      } else {
        activitiesUsed.push(order);
        fees += this.exchangeRateDataService.toCurrency(
          order.fee,
          order.SymbolProfile.currency,
          userCurrency
        );
        let amount = this.exchangeRateDataService.toCurrency(
          new Big(order.quantity).mul(order.unitPrice).toNumber(),
          order.SymbolProfile.currency,
          userCurrency
        );
        switch (order.type) {
          case 'DIVIDEND':
            dividend += amount;
            break;
          case 'ITEM':
            items += amount;
            break;
          case 'SELL':
            totalSell += amount;
            ordersCount++;
            break;
          case 'BUY':
            totalBuy += amount;
            ordersCount++;
            break;
          case 'LIABILITY':
            liabilities += amount;
            break;
          case 'INTEREST':
            interest += amount;
            break;
        }
      }
    }
    const emergencyFund = new Big(
      Math.max(
        emergencyFundPositionsValueInBaseCurrency,
        (user.Settings?.settings as UserSettings)?.emergencyFund ?? 0
      )
    );

    const cash = new Big(balanceInBaseCurrency)
      .minus(emergencyFund)
      .plus(emergencyFundPositionsValueInBaseCurrency)
      .toNumber();

    const committedFunds = new Big(totalBuy).minus(totalSell);

    const totalOfExcludedActivities = this.getSumOfActivityType({
      userCurrency,
      activities: excludedActivities,
      activityType: 'BUY'
    }).minus(
      this.getSumOfActivityType({
        userCurrency,
        activities: excludedActivities,
        activityType: 'SELL'
      })
    );

    const cashDetailsWithExcludedAccounts =
      await this.accountService.getCashDetails({
        userId,
        currency: userCurrency,
        withExcludedAccounts: true
      });
    const excludedBalanceInBaseCurrency = new Big(
      cashDetailsWithExcludedAccounts.balanceInBaseCurrency
    ).minus(balanceInBaseCurrency);

    excludedAccountsAndActivities = excludedBalanceInBaseCurrency
      .plus(totalOfExcludedActivities)
      .toNumber();

    const netWorth = new Big(balanceInBaseCurrency)
      .plus(performanceInformation.performance.currentValue)
      .plus(items)
      .plus(excludedAccountsAndActivities)
      .minus(liabilities)
      .toNumber();

    const daysInMarket = differenceInDays(new Date(), firstOrderDate);

    const annualizedPerformancePercent = new PortfolioCalculator({
      currency: userCurrency,
      currentRateService: this.currentRateService,
      exchangeRateDataService: this.exchangeRateDataService,
      orders: []
    })
      .getAnnualizedPerformancePercent({
        daysInMarket,
        netPerformancePercent: new Big(
          performanceInformation.performance.currentNetPerformancePercent
        )
      })
      ?.toNumber();

    const annualizedPerformancePercentWithCurrencyEffect =
      new PortfolioCalculator({
        currency: userCurrency,
        currentRateService: this.currentRateService,
        exchangeRateDataService: this.exchangeRateDataService,
        orders: []
      })
        .getAnnualizedPerformancePercent({
          daysInMarket,
          netPerformancePercent: new Big(
            performanceInformation.performance.currentNetPerformancePercentWithCurrencyEffect
          )
        })
        ?.toNumber();

    return {
      ...performanceInformation.performance,
      annualizedPerformancePercent,
      annualizedPerformancePercentWithCurrencyEffect,
      cash,
      dividend,
      excludedAccountsAndActivities,
      fees,
      firstOrderDate,
      interest,
      items,
      liabilities,
      netWorth,
      totalBuy,
      totalSell,
      committedFunds: committedFunds.toNumber(),
      emergencyFund: {
        assets: emergencyFundPositionsValueInBaseCurrency,
        cash: emergencyFund
          .minus(emergencyFundPositionsValueInBaseCurrency)
          .toNumber(),
        total: emergencyFund.toNumber()
      },
      fireWealth: new Big(performanceInformation.performance.currentValue)
        .minus(emergencyFundPositionsValueInBaseCurrency)
        .toNumber(),
      ordersCount: ordersCount
    };
  }

  @LogPerformance
  private getSumOfActivityType({
    activities,
    activityType,
    date = new Date(0),
    userCurrency
  }: {
    activities: OrderWithAccount[];
    activityType: ActivityType;
    date?: Date;
    userCurrency: string;
  }) {
    return activities
      .filter((activity) => {
        // Filter out all activities before given date (drafts) and
        // activity type
        return (
          isBefore(date, new Date(activity.date)) &&
          activity.type === activityType
        );
      })
      .map(({ quantity, SymbolProfile, unitPrice }) => {
        return this.exchangeRateDataService.toCurrency(
          new Big(quantity).mul(unitPrice).toNumber(),
          SymbolProfile.currency,
          userCurrency
        );
      })
      .reduce(
        (previous, current) => new Big(previous).plus(current),
        new Big(0)
      );
  }

  @LogPerformance
  private async getTransactionPoints({
    filters,
    includeDrafts = false,
    types = ['BUY', 'ITEM', 'SELL', 'STAKE'],
    userId,
    withExcludedAccounts = false
  }: {
    filters?: Filter[];
    includeDrafts?: boolean;
    types?: ActivityType[];
    userId: string;
    withExcludedAccounts?: boolean;
  }): Promise<{
    transactionPoints: TransactionPoint[];
    orders: Activity[];
    portfolioOrders: PortfolioOrder[];
  }> {
    const userCurrency =
      this.request.user?.Settings?.settings.baseCurrency ?? DEFAULT_CURRENCY;

    const { activities, count } = await this.orderService.getOrders({
      filters,
      includeDrafts,
      types,
      userCurrency,
      userId,
      withExcludedAccounts
    });

    if (count <= 0) {
      return { transactionPoints: [], orders: [], portfolioOrders: [] };
    }

    const portfolioOrders: PortfolioOrder[] = activities.map((order) => ({
      currency: order.SymbolProfile.currency,
      dataSource: order.SymbolProfile.dataSource,
      date: format(order.date, DATE_FORMAT),
      fee: new Big(order.fee),
      name: order.SymbolProfile?.name,
      quantity: new Big(order.quantity),
      symbol: order.SymbolProfile.symbol,
      tags: order.tags,
      type: order.type,
      unitPrice: new Big(order.unitPrice)
    }));

    const portfolioCalculator = new PortfolioCalculator({
      currency: userCurrency,
      currentRateService: this.currentRateService,
      exchangeRateDataService: this.exchangeRateDataService,
      orders: portfolioOrders
    });

    portfolioCalculator.computeTransactionPoints();

    return {
      portfolioOrders,
      orders: activities,
      transactionPoints: portfolioCalculator.getTransactionPoints()
    };
  }

  private getUserCurrency(aUser: UserWithSettings) {
    return (
      aUser.Settings?.settings.baseCurrency ??
      this.request.user?.Settings?.settings.baseCurrency ??
      DEFAULT_CURRENCY
    );
  }

  private async getUserId(aImpersonationId: string, aUserId: string) {
    const impersonationUserId =
      await this.impersonationService.validateImpersonationId(aImpersonationId);

    return impersonationUserId || aUserId;
  }

  @LogPerformance
  private async getValueOfAccountsAndPlatforms({
    filters = [],
    orders,
    portfolioItemsNow,
    userCurrency,
    userId,
    withExcludedAccounts = false
  }: {
    filters?: Filter[];
    orders: Activity[];
    portfolioItemsNow: { [p: string]: TimelinePosition };
    userCurrency: string;
    userId: string;
    withExcludedAccounts?: boolean;
  }) {
    const { activities: ordersOfTypeItemOrLiability } =
      await this.orderService.getOrders({
        filters,
        userCurrency,
        userId,
        withExcludedAccounts,
        types: ['LIABILITY']
      });

    const accounts: PortfolioDetails['accounts'] = {};
    const platforms: PortfolioDetails['platforms'] = {};

    let currentAccounts: (Account & {
      Order?: Order[];
      Platform?: Platform;
    })[] = [];

    if (filters.length === 0) {
      currentAccounts = await this.accountService.getAccounts(userId);
    } else if (filters.length === 1 && filters[0].type === 'ACCOUNT') {
      currentAccounts = await this.accountService.accounts({
        include: { Platform: true },
        where: { id: filters[0].id }
      });
    } else {
      const accountIds = uniq(
        orders
          .filter(({ accountId }) => {
            return accountId;
          })
          .map(({ accountId }) => {
            return accountId;
          })
      );

      currentAccounts = await this.accountService.accounts({
        include: { Platform: true },
        where: { id: { in: accountIds } }
      });
    }

    currentAccounts = currentAccounts.filter((account) => {
      return withExcludedAccounts || account.isExcluded === false;
    });

    for (const account of currentAccounts) {
      let ordersByAccount = orders.filter(({ accountId }) => {
        return accountId === account.id;
      });

      const ordersOfTypeItemOrLiabilityByAccount =
        ordersOfTypeItemOrLiability.filter(({ accountId }) => {
          return accountId === account.id;
        });

      ordersByAccount = ordersByAccount.concat(
        ordersOfTypeItemOrLiabilityByAccount
      );

      accounts[account.id] = {
        balance: account.balance,
        currency: account.currency,
        name: account.name,
        valueInBaseCurrency: this.exchangeRateDataService.toCurrency(
          account.balance,
          account.currency,
          userCurrency
        )
      };

      if (platforms[account.Platform?.id || UNKNOWN_KEY]?.valueInBaseCurrency) {
        platforms[account.Platform?.id || UNKNOWN_KEY].valueInBaseCurrency +=
          this.exchangeRateDataService.toCurrency(
            account.balance,
            account.currency,
            userCurrency
          );
      } else {
        platforms[account.Platform?.id || UNKNOWN_KEY] = {
          balance: account.balance,
          currency: account.currency,
          name: account.Platform?.name,
          valueInBaseCurrency: this.exchangeRateDataService.toCurrency(
            account.balance,
            account.currency,
            userCurrency
          )
        };
      }

      for (const {
        Account,
        quantity,
        SymbolProfile,
        type
      } of ordersByAccount) {
        let currentValueOfSymbolInBaseCurrency =
          quantity *
            portfolioItemsNow[SymbolProfile.symbol]
              ?.marketPriceInBaseCurrency ?? 0;

        if (['LIABILITY', 'SELL'].includes(type)) {
          currentValueOfSymbolInBaseCurrency *= -1;
        }

        if (accounts[Account?.id || UNKNOWN_KEY]?.valueInBaseCurrency) {
          accounts[Account?.id || UNKNOWN_KEY].valueInBaseCurrency +=
            currentValueOfSymbolInBaseCurrency;
        } else {
          accounts[Account?.id || UNKNOWN_KEY] = {
            balance: 0,
            currency: Account?.currency,
            name: account.name,
            valueInBaseCurrency: currentValueOfSymbolInBaseCurrency
          };
        }

        if (
          platforms[Account?.Platform?.id || UNKNOWN_KEY]?.valueInBaseCurrency
        ) {
          platforms[Account?.Platform?.id || UNKNOWN_KEY].valueInBaseCurrency +=
            currentValueOfSymbolInBaseCurrency;
        } else {
          platforms[Account?.Platform?.id || UNKNOWN_KEY] = {
            balance: 0,
            currency: Account?.currency,
            name: account.Platform?.name,
            valueInBaseCurrency: currentValueOfSymbolInBaseCurrency
          };
        }
      }
    }

    return { accounts, platforms };
  }

  @LogPerformance
  private mergeHistoricalDataItems(
    accountBalanceItems: HistoricalDataItem[],
    performanceChartItems: HistoricalDataItem[]
  ): HistoricalDataItem[] {
    const historicalDataItemsMap: { [date: string]: HistoricalDataItem } = {};
    let latestAccountBalance = 0;

    for (const item of accountBalanceItems.concat(performanceChartItems)) {
      const isAccountBalanceItem = accountBalanceItems.includes(item);

      const totalAccountBalance = isAccountBalanceItem
        ? item.value
        : latestAccountBalance;

      if (isAccountBalanceItem && performanceChartItems.length > 0) {
        latestAccountBalance = item.value;
      } else {
        historicalDataItemsMap[item.date] = {
          ...item,
          totalAccountBalance,
          netWorth:
            (isAccountBalanceItem ? 0 : item.value) + totalAccountBalance
        };
      }
    }

    // Convert to an array and sort by date in ascending order
    const historicalDataItems = Object.keys(historicalDataItemsMap).map(
      (date) => {
        return historicalDataItemsMap[date];
      }
    );

    historicalDataItems.sort((a, b) => {
      return new Date(a.date).getTime() - new Date(b.date).getTime();
    });

    return historicalDataItems;
  }
}
