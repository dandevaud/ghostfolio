import { DataProviderService } from '@ghostfolio/api/services/data-provider/data-provider.service';
import { AssetProfileDelistedError } from '@ghostfolio/api/services/data-provider/errors/asset-profile-delisted.error';
import { DataGatheringItem } from '@ghostfolio/api/services/interfaces/interfaces';
import { MarketDataService } from '@ghostfolio/api/services/market-data/market-data.service';
import { SymbolProfileService } from '@ghostfolio/api/services/symbol-profile/symbol-profile.service';
import {
  DATA_GATHERING_QUEUE,
  DEFAULT_PROCESSOR_GATHER_ASSET_PROFILE_CONCURRENCY,
  DEFAULT_PROCESSOR_GATHER_HISTORICAL_MARKET_DATA_CONCURRENCY,
  GATHER_ASSET_PROFILE_PROCESS_JOB_NAME,
  GATHER_HISTORICAL_MARKET_DATA_PROCESS_JOB_NAME,
  GATHER_MISSING_HISTORICAL_MARKET_DATA_PROCESS_JOB_NAME
} from '@ghostfolio/common/config';
import {
  DATE_FORMAT,
  getAssetProfileIdentifier,
  getStartOfUtcDate
} from '@ghostfolio/common/helper';
import {
  AssetProfileIdentifier,
  DataProviderHistoricalResponse
} from '@ghostfolio/common/interfaces';

import { Process, Processor } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, Prisma } from '@prisma/client';
import { Job } from 'bull';
import { isNumber } from 'class-validator';
import {
  addDays,
  format,
  getDate,
  getMonth,
  getYear,
  isBefore,
  parseISO,
  eachDayOfInterval
} from 'date-fns';

import { DataGatheringService } from './data-gathering.service';

@Injectable()
@Processor(DATA_GATHERING_QUEUE)
export class DataGatheringProcessor {
  private readonly logger = new Logger(DataGatheringProcessor.name);

  public constructor(
    private readonly dataGatheringService: DataGatheringService,
    private readonly dataProviderService: DataProviderService,
    private readonly marketDataService: MarketDataService,
    private readonly symbolProfileService: SymbolProfileService
  ) {}

  @Process({
    concurrency: parseInt(
      process.env.PROCESSOR_GATHER_ASSET_PROFILE_CONCURRENCY ??
        DEFAULT_PROCESSOR_GATHER_ASSET_PROFILE_CONCURRENCY.toString(),
      10
    ),
    name: GATHER_ASSET_PROFILE_PROCESS_JOB_NAME
  })
  public async gatherAssetProfile(job: Job<AssetProfileIdentifier>) {
    if (!job.data?.dataSource || !job.data?.symbol) {
      this.logger.error(
        `Job ${job.id} has invalid/missing data: ${JSON.stringify(job.data)}`
      );
      return job.discard();
    }
    const { dataSource, symbol } = job.data;

    try {
      this.logger.log(
        `Asset profile data gathering has been started for ${symbol} (${dataSource})`
      );

      await this.dataGatheringService.gatherAssetProfiles([job.data]);

      this.logger.log(
        `Asset profile data gathering has been completed for ${symbol} (${dataSource})`
      );
    } catch (error) {
      if (error instanceof AssetProfileDelistedError) {
        await this.symbolProfileService.updateSymbolProfile(
          {
            dataSource,
            symbol
          },
          {
            isActive: false
          }
        );

        this.logger.log(
          `Asset profile data gathering has been discarded for ${symbol} (${dataSource})`
        );

        return job.discard();
      }

      this.logger.error(error.message);

      throw error;
    }
  }

  @Process({
    concurrency: parseInt(
      process.env.PROCESSOR_GATHER_HISTORICAL_MARKET_DATA_CONCURRENCY ??
        DEFAULT_PROCESSOR_GATHER_HISTORICAL_MARKET_DATA_CONCURRENCY.toString(),
      10
    ),
    name: GATHER_HISTORICAL_MARKET_DATA_PROCESS_JOB_NAME
  })
  public async gatherHistoricalMarketData(job: Job<DataGatheringItem>) {
    if (!job.data?.dataSource || !job.data?.symbol) {
      this.logger.error(
        `Job ${job.id} has invalid/missing data: ${JSON.stringify(job.data)}`
      );
      return job.discard();
    }
    const { dataSource, date, force, symbol } = job.data;

    try {
      let currentDate = parseISO(date as unknown as string);

      this.logger.log(
        `Historical market data gathering has been started for ${symbol} (${dataSource}) at ${format(
          currentDate,
          DATE_FORMAT
        )}${force ? ' (forced update)' : ''}`
      );

      const historicalData = await this.dataProviderService.getHistoricalRaw({
        assetProfileIdentifiers: [{ dataSource, symbol }],
        from: currentDate,
        to: new Date()
      });

      const assetProfileIdentifier = getAssetProfileIdentifier({
        dataSource,
        symbol
      });

      const data: Prisma.MarketDataUpdateInput[] = [];
      let lastMarketPrice: number;

      while (
        isBefore(
          currentDate,
          new Date(
            Date.UTC(
              getYear(new Date()),
              getMonth(new Date()),
              getDate(new Date()),
              0
            )
          )
        )
      ) {
        if (
          historicalData[assetProfileIdentifier]?.[
            format(currentDate, DATE_FORMAT)
          ]?.marketPrice
        ) {
          lastMarketPrice =
            historicalData[assetProfileIdentifier]?.[
              format(currentDate, DATE_FORMAT)
            ]?.marketPrice;
        }

        if (lastMarketPrice) {
          data.push({
            dataSource,
            symbol,
            date: getStartOfUtcDate(currentDate),
            marketPrice: lastMarketPrice,
            state: 'CLOSE'
          });
        }

        currentDate = addDays(currentDate, 1);
      }

      if (force) {
        await this.marketDataService.replaceForSymbol({
          data,
          dataSource,
          symbol
        });
      } else {
        await this.marketDataService.updateMany({ data });
      }

      this.logger.log(
        `Historical market data gathering has been completed for ${symbol} (${dataSource}) at ${format(
          currentDate,
          DATE_FORMAT
        )}`,
        `DataGatheringProcessor (${GATHER_HISTORICAL_MARKET_DATA_PROCESS_JOB_NAME})`
      );
    } catch (error) {
      if (error instanceof AssetProfileDelistedError) {
        await this.symbolProfileService.updateSymbolProfile(
          {
            dataSource,
            symbol
          },
          {
            isActive: false
          }
        );

        this.logger.log(
          `Historical market data gathering has been discarded for ${symbol} (${dataSource})`
        );

        return job.discard();
      }

      this.logger.error(error.message);

      throw error;
    }
  }
  @Process({
    concurrency: parseInt(
      process.env.PROCESSOR_CONCURRENCY_GATHER_HISTORICAL_MARKET_DATA ??
        DEFAULT_PROCESSOR_GATHER_HISTORICAL_MARKET_DATA_CONCURRENCY.toString(),
      10
    ),
    name: GATHER_MISSING_HISTORICAL_MARKET_DATA_PROCESS_JOB_NAME
  })
  public async gatherMissingHistoricalMarketData(job: Job<DataGatheringItem>) {
    if (!job.data?.dataSource || !job.data?.symbol) {
      this.logger.error(
        `Job ${job.id} has invalid/missing data: ${JSON.stringify(job.data)}`
      );
      return job.discard();
    }
    const { dataSource, date, symbol } = job.data;
    try {
      Logger.log(
        `Historical market data gathering for missing values has been started for ${symbol} (${dataSource}) at ${format(
          date,
          DATE_FORMAT
        )}`,
        `DataGatheringProcessor (${GATHER_HISTORICAL_MARKET_DATA_PROCESS_JOB_NAME})`
      );
      const marketDataDates = await this.marketDataService.marketDataItems({
        select: {
          date: true
        },
        where: {
          AND: {
            symbol: {
              equals: symbol
            },
            dataSource: {
              equals: dataSource
            }
          }
        }
      });
      const firstEntry = marketDataDates[0];

      if (!firstEntry) {
        this.logger.log(
          `Historical market data gathering for missing values has been skipped for ${symbol} (${dataSource}) because no market data exists yet`
        );

        return;
      }

      const existingDates = new Set(
        marketDataDates.map(({ date }) => format(date, DATE_FORMAT))
      );

      const dates = eachDayOfInterval(
        {
          start: firstEntry.date,
          end: new Date()
        },
        {
          step: 1
        }
      ).filter((d) => !existingDates.has(format(d, DATE_FORMAT)));

      const historicalData = await this.dataProviderService.getHistoricalRaw({
        assetProfileIdentifiers: [{ dataSource, symbol }],
        from: firstEntry.date,
        to: new Date()
      });

      const data: Prisma.MarketDataUpdateInput[] =
        this.mapToMarketUpsertDataInputs(
          dates,
          historicalData,
          symbol,
          dataSource
        ).filter((data) => data !== undefined);

      await this.marketDataService.updateMany({ data });

      Logger.log(
        `Historical market data gathering for missing values has been completed for ${symbol} (${dataSource}) at ${format(
          date,
          DATE_FORMAT
        )}`,
        `DataGatheringProcessor (${GATHER_HISTORICAL_MARKET_DATA_PROCESS_JOB_NAME})`
      );
    } catch (error) {
      if (error instanceof AssetProfileDelistedError) {
        await this.symbolProfileService.updateSymbolProfile(
          {
            dataSource,
            symbol
          },
          {
            isActive: false
          }
        );

        this.logger.log(
          `Historical market data gathering has been discarded for ${symbol} (${dataSource})`
        );

        return job.discard();
      }

      this.logger.error(error.message);

      throw error;
    }
  }

  private mapToMarketUpsertDataInputs(
    missingMarketData: Date[],
    historicalData: Record<
      string,
      Record<string, DataProviderHistoricalResponse>
    >,
    symbol: string,
    dataSource: DataSource
  ): Prisma.MarketDataUpdateInput[] {
    return missingMarketData.map((date) => {
      if (
        isNumber(
          historicalData[getAssetProfileIdentifier({ dataSource, symbol })]?.[
            format(date, DATE_FORMAT)
          ]?.marketPrice
        )
      ) {
        return {
          date,
          symbol,
          dataSource,
          marketPrice:
            historicalData[getAssetProfileIdentifier({ dataSource, symbol })]?.[
              format(date, DATE_FORMAT)
            ]?.marketPrice
        };
      } else {
        let earlierDate = date;
        let index = 0;
        while (
          !isNumber(
            historicalData[getAssetProfileIdentifier({ dataSource, symbol })]?.[
              format(earlierDate, DATE_FORMAT)
            ]?.marketPrice
          )
        ) {
          earlierDate = addDays(earlierDate, -1);
          index++;
          if (index > 10) {
            break;
          }
        }
        if (
          isNumber(
            historicalData[getAssetProfileIdentifier({ dataSource, symbol })]?.[
              format(earlierDate, DATE_FORMAT)
            ]?.marketPrice
          )
        ) {
          return {
            date,
            symbol,
            dataSource,
            marketPrice:
              historicalData[
                getAssetProfileIdentifier({ dataSource, symbol })
              ]?.[format(earlierDate, DATE_FORMAT)]?.marketPrice
          };
        }
      }
    });
  }
}
