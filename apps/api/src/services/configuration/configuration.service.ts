import { environment } from '@ghostfolio/api/environments/environment';
import { Environment } from '@ghostfolio/api/services/interfaces/environment.interface';
import {
  CACHE_TTL_NO_CACHE,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PROCESSOR_GATHER_ASSET_PROFILE_CONCURRENCY,
  DEFAULT_PROCESSOR_GATHER_HISTORICAL_MARKET_DATA_CONCURRENCY,
  DEFAULT_PROCESSOR_PORTFOLIO_SNAPSHOT_COMPUTATION_CONCURRENCY,
  DEFAULT_PROCESSOR_PORTFOLIO_SNAPSHOT_COMPUTATION_TIMEOUT
} from '@ghostfolio/common/config';

import { Injectable } from '@nestjs/common';
import { DataSource } from '@prisma/client';
import { bool, cleanEnv, host, json, num, port, str, url } from 'envalid';
import ms from 'ms';

@Injectable()
export class ConfigurationService {
  private readonly environmentConfiguration: Environment;

  public constructor() {
    this.environmentConfiguration = cleanEnv(process.env, {
      ACCESS_TOKEN_SALT: str(),
      API_KEY_ALPHA_VANTAGE: str({ default: '' }),
      API_KEY_BETTER_UPTIME: str({ default: '' }),
      API_KEY_COINGECKO_DEMO: str({ default: '' }),
      API_KEY_COINGECKO_PRO: str({ default: '' }),
      API_KEY_EOD_HISTORICAL_DATA: str({ default: '' }),
      API_KEY_FINANCIAL_MODELING_PREP: str({ default: '' }),
      API_KEY_OPEN_FIGI: str({ default: '' }),
      API_KEY_RAPID_API: str({ default: '' }),
      CACHE_QUOTES_TTL: num({ default: ms('1 minute') }),
      CACHE_TTL: num({ default: CACHE_TTL_NO_CACHE }),
      DATA_SOURCE_EXCHANGE_RATES: str({ default: DataSource.YAHOO }),
      DATA_SOURCE_IMPORT: str({ default: DataSource.YAHOO }),
      DATA_SOURCES: json({
        default: [DataSource.COINGECKO, DataSource.MANUAL, DataSource.YAHOO]
      }),
      DATA_SOURCES_GHOSTFOLIO_DATA_PROVIDER: json({
        default: []
      }),
      DATA_SOURCES_LEGACY: json({
        default: []
      }),
      ENABLE_FEATURE_FEAR_AND_GREED_INDEX: bool({ default: false }),
      ENABLE_FEATURE_READ_ONLY_MODE: bool({ default: false }),
      ENABLE_FEATURE_SOCIAL_LOGIN: bool({ default: false }),
      ENABLE_FEATURE_STATISTICS: bool({ default: false }),
      ENABLE_FEATURE_SUBSCRIPTION: bool({ default: false }),
      ENABLE_FEATURE_SYSTEM_MESSAGE: bool({ default: false }),
      GOOGLE_CLIENT_ID: str({ default: 'dummyClientId' }),
      GOOGLE_SECRET: str({ default: 'dummySecret' }),
      GOOGLE_SHEETS_ACCOUNT: str({ default: '' }),
      GOOGLE_SHEETS_ID: str({ default: '' }),
      GOOGLE_SHEETS_PRIVATE_KEY: str({ default: '' }),
      HOST: host({ default: DEFAULT_HOST }),
      JWT_SECRET_KEY: str({}),
      MAX_ACTIVITIES_TO_IMPORT: num({ default: Number.MAX_SAFE_INTEGER }),
      MAX_CHART_ITEMS: num({ default: 365 }),
      PORT: port({ default: DEFAULT_PORT }),
      PROCESSOR_GATHER_ASSET_PROFILE_CONCURRENCY: num({
        default: DEFAULT_PROCESSOR_GATHER_ASSET_PROFILE_CONCURRENCY
      }),
      PROCESSOR_GATHER_HISTORICAL_MARKET_DATA_CONCURRENCY: num({
        default: DEFAULT_PROCESSOR_GATHER_HISTORICAL_MARKET_DATA_CONCURRENCY
      }),
      PROCESSOR_PORTFOLIO_SNAPSHOT_COMPUTATION_CONCURRENCY: num({
        default: DEFAULT_PROCESSOR_PORTFOLIO_SNAPSHOT_COMPUTATION_CONCURRENCY
      }),
      PROCESSOR_PORTFOLIO_SNAPSHOT_COMPUTATION_TIMEOUT: num({
        default: DEFAULT_PROCESSOR_PORTFOLIO_SNAPSHOT_COMPUTATION_TIMEOUT
      }),
      REDIS_DB: num({ default: 0 }),
      REDIS_HOST: str({ default: 'localhost' }),
      REDIS_PASSWORD: str({ default: '' }),
      REDIS_PORT: port({ default: 6379 }),
      REQUEST_TIMEOUT: num({ default: ms('3 seconds') }),
      ROOT_URL: url({
        default: environment.rootUrl
      }),
      STRIPE_PUBLIC_KEY: str({ default: '' }),
      STRIPE_SECRET_KEY: str({ default: '' }),
      TWITTER_ACCESS_TOKEN: str({ default: 'dummyAccessToken' }),
      TWITTER_ACCESS_TOKEN_SECRET: str({ default: 'dummyAccessTokenSecret' }),
      TWITTER_API_KEY: str({ default: 'dummyApiKey' }),
      TWITTER_API_SECRET: str({ default: 'dummyApiSecret' })
    });
  }

  public get<K extends keyof Environment>(key: K): Environment[K] {
    return this.environmentConfiguration[key];
  }
}
