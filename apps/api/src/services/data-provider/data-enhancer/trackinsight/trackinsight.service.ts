import { DataEnhancerInterface } from '@ghostfolio/api/services/data-provider/interfaces/data-enhancer.interface';
import { Country } from '@ghostfolio/common/interfaces/country.interface';
import { Sector } from '@ghostfolio/common/interfaces/sector.interface';
import { Injectable } from '@nestjs/common';
import { SymbolProfile } from '@prisma/client';
import { Min } from 'class-validator';
import got from 'got';

@Injectable()
export class TrackinsightDataEnhancerService implements DataEnhancerInterface {
  private static baseUrl = 'https://www.trackinsight.com/data-api';
  private static countries = require('countries-list/dist/countries.json');
  private static countriesMapping = {
    'Russian Federation': 'Russia'
  };
  private static sectorsMapping = {
    'Consumer Discretionary': 'Consumer Cyclical',
    'Consumer Defensive': 'Consumer Staples',
    'Health Care': 'Healthcare',
    'Information Technology': 'Technology'
  };

  public async enhance({
    response,
    symbol
  }: {
    response: Partial<SymbolProfile>;
    symbol: string;
  }): Promise<Partial<SymbolProfile>> {
    if (!(response.assetSubClass === 'ETF')) {
      return response;
    }

    const profile = await got(
      `${TrackinsightDataEnhancerService.baseUrl}/funds/${symbol}.json`
    )
      .json<any>()
      .catch(() => {
        return got(
          `${TrackinsightDataEnhancerService.baseUrl}/funds/${
            symbol.split('.')?.[0]
          }.json`
        )
          .json<any>()
          .catch(() => {
            return {};
          });
      });

    const isin = profile?.isin?.split(';')?.[0];

    if (isin) {
      response.isin = isin;
    }

    const holdings = await got(
      `${TrackinsightDataEnhancerService.baseUrl}/holdings/${symbol}.json`
    )
      .json<any>()
      .catch(() => {
        return got(
          `${TrackinsightDataEnhancerService.baseUrl}/holdings/${
            symbol.split('.')?.[0]
          }.json`
        )
          .json<any>()
          .catch(() => {
            return {};
          });
      });

    if (holdings?.weight < 1 - Math.min(holdings?.count * 0.000015, 0.95)) {
      // Skip if data is inaccurate, dependent on holdings count there might be rounding issues
      return response;
    }

    if (
      !response.countries ||
      (response.countries as unknown as Country[]).length === 0
    ) {
      response.countries = [];
      for (const [name, value] of Object.entries<any>(
        holdings?.countries ?? {}
      )) {
        let countryCode: string;

        for (const [key, country] of Object.entries<any>(
          TrackinsightDataEnhancerService.countries
        )) {
          if (
            country.name === name ||
            country.name ===
              TrackinsightDataEnhancerService.countriesMapping[name]
          ) {
            countryCode = key;
            break;
          }
        }

        response.countries.push({
          code: countryCode,
          weight: value.weight
        });
      }
    }

    if (
      !response.sectors ||
      (response.sectors as unknown as Sector[]).length === 0
    ) {
      response.sectors = [];
      for (const [name, value] of Object.entries<any>(
        holdings?.sectors ?? {}
      )) {
        response.sectors.push({
          name: TrackinsightDataEnhancerService.sectorsMapping[name] ?? name,
          weight: value.weight
        });
      }
    }

    return Promise.resolve(response);
  }

  public getName() {
    return 'TRACKINSIGHT';
  }

  public getTestSymbol() {
    return 'QQQ';
  }
}
