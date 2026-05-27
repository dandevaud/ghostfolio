import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { DataEnhancerInterface } from '@ghostfolio/api/services/data-provider/interfaces/data-enhancer.interface';

import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SymbolProfile } from '@prisma/client';
import { countries } from 'countries-list';
import Papa from 'papaparse';

interface ISharesCsvRow {
  'Asset Class'?: string;
  Location?: string;
  Name?: string;
  Sector?: string;
  Ticker?: string;
  'Weight (%)'?: string;
}

@Injectable()
export class ISharesDataEnhancerService implements DataEnhancerInterface {
  private static sectorsMapping = {
    'Consumer Discretionary': 'Consumer Cyclical',
    'Health Care': 'Healthcare',
    'Information Technology': 'Technology',
    Financials: 'Financial Services',
    Industrials: 'Industrials',
    Materials: 'Basic Materials',
    'Consumer Staples': 'Consumer Staples',
    'Real Estate': 'Real Estate',
    Communication: 'Communication Services',
    Energy: 'Energy',
    Utilities: 'Utilities'
  };

  public constructor(
    private readonly configurationService: ConfigurationService
  ) {}

  public async enhance({
    requestTimeout = this.configurationService.get('REQUEST_TIMEOUT'),
    response,
    symbol,
    symbolMapping
  }: {
    requestTimeout?: number;
    response: Partial<SymbolProfile>;
    symbol: string;
    symbolMapping?: { [key: string]: string };
  }): Promise<Partial<SymbolProfile>> {
    if (!['ETF', 'MUTUALFUND'].includes(response.assetSubClass)) {
      return response;
    }

    const holdingsEndpoint =
      symbolMapping?.iSharesHoldingEndpoint ??
      (this.isUrl(symbol) ? symbol : undefined);

    if (!holdingsEndpoint) {
      return response;
    }

    const holdings = await this.getHoldings({
      requestTimeout,
      url: holdingsEndpoint
    });

    if (holdings.length === 0) {
      Logger.warn(
        `No holdings found for symbol ${symbol} with iShares holding endpoint ${holdingsEndpoint}`,
        'ISharesDataEnhancerService'
      );
      return response;
    }

    if (
      (response.holdings as unknown as Prisma.JsonArray)?.length ??
      0 < holdings.length
    ) {
      response.holdings = holdings
        .filter(({ name, weight }) => {
          return Boolean(name) && weight > 0;
        })
        .sort((a, b) => {
          return b.weight - a.weight;
        })
        .slice(0, 10)
        .map(({ name, weight }) => {
          return { name, weight };
        });
    }

    const countryAggregation = this.aggregateCountries(
      holdings
    ) as unknown as Prisma.JsonArray;

    if (countryAggregation?.length > 0) {
      response.countries = countryAggregation;
    }

    if (!((response.sectors as unknown as Prisma.JsonArray)?.length > 0)) {
      response.sectors = this.aggregateSectors(
        holdings
      ) as unknown as Prisma.JsonArray;
    }

    return response;
  }

  public getName() {
    return 'ISHARES';
  }

  public getTestSymbol() {
    return 'https://www.ishares.com/us/products/239726/ishares-core-msci-world-ucits-etf/1467271812596.ajax?fileType=csv&tab=all';
  }

  private aggregateCountries(holdings: { country?: string; weight: number }[]) {
    const countryMap = new Map<string, number>();

    for (const { country, weight } of holdings) {
      if (!country || country === '-' || weight <= 0) {
        continue;
      }

      countryMap.set(country, (countryMap.get(country) ?? 0) + weight);
    }

    return Array.from(countryMap.entries())
      .map(([countryName, weight]) => {
        let countryCode: string;

        for (const [code, country] of Object.entries(countries)) {
          if (country.name === countryName) {
            countryCode = code;
            break;
          }
        }

        return { code: countryCode, weight };
      })
      .filter(({ code }) => {
        return Boolean(code);
      })
      .sort((a, b) => {
        return b.weight - a.weight;
      });
  }

  private aggregateSectors(holdings: { sector?: string; weight: number }[]) {
    const sectorMap = new Map<string, number>();

    for (const { sector, weight } of holdings) {
      if (!sector || sector === '-' || weight <= 0) {
        continue;
      }

      const sectorName = ISharesDataEnhancerService.sectorsMapping[sector];
      if (!sectorName) {
        continue;
      }

      sectorMap.set(sectorName, (sectorMap.get(sectorName) ?? 0) + weight);
    }

    return Array.from(sectorMap.entries())
      .map(([name, weight]) => {
        return { name, weight };
      })
      .sort((a, b) => {
        return b.weight - a.weight;
      });
  }

  private async getHoldings({
    requestTimeout,
    url
  }: {
    requestTimeout: number;
    url: string;
  }) {
    try {
      const csv = await fetch(url, {
        signal: AbortSignal.timeout(requestTimeout)
      }).then((res) => res.text());

      return this.parseHoldings(csv);
    } catch ({ message }) {
      Logger.error(
        `Failed to fetch iShares holdings for ${url} (${message})`,
        'ISharesDataEnhancerService'
      );

      return [];
    }
  }

  private isUrl(value: string) {
    return value?.startsWith('http://') || value?.startsWith('https://');
  }

  private parseHoldings(csv: string) {
    const lines = csv.split(/\r?\n/);
    const headerLineIndex = lines.findIndex((line) => {
      const headers = line
        .split(',')
        .map((header) => {
          return header.trim().replace(/^"|"$/g, '');
        })
        .filter(Boolean);

      const hasTicker = headers.includes('Ticker');
      const hasName = headers.includes('Name');
      const hasWeight = headers.some((header) => {
        return header === 'Weight' || header.startsWith('Weight');
      });

      return hasTicker && hasName && hasWeight;
    });

    const headerIndex =
      headerLineIndex >= 0
        ? lines.slice(0, headerLineIndex).join('\n').length
        : -1;

    if (headerIndex < 0) {
      return [];
    }

    const { data } = Papa.parse<ISharesCsvRow>(
      lines.slice(headerLineIndex).join('\n'),
      {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => {
          return header.trim();
        }
      }
    );

    return data
      .map((row) => {
        return {
          country: row.Location?.trim(),
          name: row.Name?.trim(),
          sector: row.Sector?.trim(),
          weight: this.parsePercentage(row['Weight (%)'])
        };
      })
      .filter(({ name, weight }) => {
        return Boolean(name) && weight > 0;
      });
  }

  private parsePercentage(value?: string) {
    if (!value) {
      return 0;
    }

    const normalized = value
      .trim()
      .replace(/[\u00A0'’]/g, '')
      .replace(/,$/, '');

    const decimalValue =
      normalized.includes(',') && !normalized.includes('.')
        ? normalized.replace(',', '.')
        : normalized.replace(/,/g, '');

    const parsedValue = parseFloat(decimalValue);

    return Number.isFinite(parsedValue) ? parsedValue / 100 : 0;
  }
}
