import { RedisCacheModule } from '@ghostfolio/api/services/redis-cache/redis-cache.module';
import { PrismaModule } from '@ghostfolio/api/services/prisma/prisma.module';

import { Module } from '@nestjs/common';

import { MarketDataService } from './market-data.service';

@Module({
  exports: [MarketDataService],
  imports: [PrismaModule, RedisCacheModule],
  providers: [MarketDataService]
})
export class MarketDataModule {}
