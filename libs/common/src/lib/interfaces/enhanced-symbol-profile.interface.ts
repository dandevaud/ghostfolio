import { AssetClass, AssetSubClass, DataSource, Tag } from '@prisma/client';

import { Country } from './country.interface';
import { ScraperConfiguration } from './scraper-configuration.interface';
import { Sector } from './sector.interface';

export interface EnhancedSymbolProfile {
  activitiesCount: number;
  assetClass: AssetClass;
  assetSubClass: AssetSubClass;
  comment: string | null;
  countries: Country[];
  createdAt: Date;
  currency: string | null;
  dataSource: DataSource;
  dateOfFirstActivity?: Date;
  id: string;
  isin: string | null;
  name: string | null;
  scraperConfiguration?: ScraperConfiguration | null;
  sectors: Sector[];
  symbol: string;
  symbolMapping?: { [key: string]: string };
  updatedAt: Date;
  url?: string;
  tags?: Tag[];
}
