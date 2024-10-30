import { CleanedEnvAccessors } from 'envalid';

export interface Environment extends CleanedEnvAccessors {
  ACCESS_TOKEN_SALT: string;
  API_KEY_ALPHA_VANTAGE: string;
  API_KEY_BETTER_UPTIME: string;
  API_KEY_COINGECKO_DEMO: string;
  API_KEY_COINGECKO_PRO: string;
  API_KEY_EOD_HISTORICAL_DATA: string;
  API_KEY_FINANCIAL_MODELING_PREP: string;
  API_KEY_OPEN_FIGI: string;
  API_KEY_RAPID_API: string;
  CACHE_QUOTES_TTL: number;
  CACHE_TTL: number;
  DATA_SOURCE_EXCHANGE_RATES: string;
  DATA_SOURCE_IMPORT: string;
  DATA_SOURCES: string[];
  ENABLE_FEATURE_FEAR_AND_GREED_INDEX: boolean;
  ENABLE_FEATURE_READ_ONLY_MODE: boolean;
  ENABLE_FEATURE_SOCIAL_LOGIN: boolean;
  ENABLE_FEATURE_STATISTICS: boolean;
  ENABLE_FEATURE_SUBSCRIPTION: boolean;
  ENABLE_FEATURE_SYSTEM_MESSAGE: boolean;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_SECRET: string;
  GOOGLE_SHEETS_ACCOUNT: string;
  GOOGLE_SHEETS_ID: string;
  GOOGLE_SHEETS_PRIVATE_KEY: string;
  JWT_SECRET_KEY: string;
  MAX_ACTIVITIES_TO_IMPORT: number;
  MAX_CHART_ITEMS: number;
  PORT: number;
  PROCESSOR_GATHER_ASSET_PROFILE_CONCURRENCY: number;
  PROCESSOR_GATHER_HISTORICAL_MARKET_DATA_CONCURRENCY: number;
  PROCESSOR_PORTFOLIO_SNAPSHOT_COMPUTATION_CONCURRENCY: number;
  PROCESSOR_PORTFOLIO_SNAPSHOT_COMPUTATION_TIMEOUT: number;
  REDIS_DB: number;
  REDIS_HOST: string;
  REDIS_PASSWORD: string;
  REDIS_PORT: number;
  REQUEST_TIMEOUT: number;
  ROOT_URL: string;
  STRIPE_PUBLIC_KEY: string;
  STRIPE_SECRET_KEY: string;
  TWITTER_ACCESS_TOKEN: string;
  TWITTER_ACCESS_TOKEN_SECRET: string;
  TWITTER_API_KEY: string;
  TWITTER_API_SECRET: string;
}
