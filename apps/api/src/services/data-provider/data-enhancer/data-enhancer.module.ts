import { ConfigurationModule } from '@ghostfolio/api/services/configuration/configuration.module';
import { CryptocurrencyModule } from '@ghostfolio/api/services/cryptocurrency/cryptocurrency.module';
import { ISharesDataEnhancerService } from '@ghostfolio/api/services/data-provider/data-enhancer/ishares/ishares.service';
import { OpenFigiDataEnhancerService } from '@ghostfolio/api/services/data-provider/data-enhancer/openfigi/openfigi.service';
import { TrackinsightDataEnhancerService } from '@ghostfolio/api/services/data-provider/data-enhancer/trackinsight/trackinsight.service';
import { YahooFinanceDataEnhancerService } from '@ghostfolio/api/services/data-provider/data-enhancer/yahoo-finance/yahoo-finance.service';
import { FetchModule } from '@ghostfolio/api/services/fetch/fetch.module';

import { Module } from '@nestjs/common';

import { DataEnhancerService } from './data-enhancer.service';

@Module({
  exports: [
    DataEnhancerService,
    ISharesDataEnhancerService,
    OpenFigiDataEnhancerService,
    TrackinsightDataEnhancerService,
    YahooFinanceDataEnhancerService,
    'DataEnhancers'
  ],
  imports: [ConfigurationModule, CryptocurrencyModule, FetchModule],
  providers: [
    DataEnhancerService,
    ISharesDataEnhancerService,
    OpenFigiDataEnhancerService,
    TrackinsightDataEnhancerService,
    YahooFinanceDataEnhancerService,
    {
      inject: [
        ISharesDataEnhancerService,
        OpenFigiDataEnhancerService,
        TrackinsightDataEnhancerService,
        YahooFinanceDataEnhancerService
      ],
      provide: 'DataEnhancers',
      useFactory: (ishares, openfigi, trackinsight, yahooFinance) => [
        ishares,
        openfigi,
        trackinsight,
        yahooFinance
      ]
    }
  ]
})
export class DataEnhancerModule {}
