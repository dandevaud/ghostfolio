import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';

import { ISharesDataEnhancerService } from './ishares.service';

describe('ISharesDataEnhancerService', () => {
  let service: ISharesDataEnhancerService;

  beforeEach(() => {
    service = new ISharesDataEnhancerService({
      get: jest.fn().mockReturnValue(30000)
    } as unknown as ConfigurationService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not run without iSharesHoldingEndpoint', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    const response = await service.enhance({
      response: {
        assetClass: 'EQUITY',
        assetSubClass: 'ETF'
      },
      symbol: 'SWDA'
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(response).toEqual({
      assetClass: 'EQUITY',
      assetSubClass: 'ETF'
    });
  });

  it('parses holdings from the iShares CSV endpoint in symbol mappings', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      text: async () => `Fund Holdings as of,"25/May/2026"

Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Notional Value,Shares,Price,Location,Exchange,Market Currency
"NVDA","NVIDIA CORP","Information Technology","Equity","8'368'288'179.93","5.77","8'368'288'179.93","38'862'621.00","215.33","United States","NASDAQ","USD"
"ASML","ASML HOLDING NV","Information Technology","Equity","1'039'311'461.58","0.72","1'039'311'461.58","624'022.00","1'665.50","Netherlands","Euronext Amsterdam","EUR"
"LLY","ELI LILLY","Health Care","Equity","1'363'319'280.00","0.94","1'363'319'280.00","1'280'112.00","1'065.00","United States","New York Stock Exchange Inc.","USD"
"USD","USD CASH","Cash and/or Derivatives","Cash","337'299'161.44","0.23","337'299'161.44","337'299'161.00","100.00","United States","-","USD"`
    } as Response);

    const response = await service.enhance({
      response: {
        assetClass: 'EQUITY',
        assetSubClass: 'ETF'
      },
      symbol: 'SWDA',
      symbolMapping: {
        iSharesHoldingEndpoint:
          'https://www.ishares.com/ch/individual/en/products/251882/ishares-msci-world-ucits-etf-acc-fund/1495092304805.ajax?fileType=csv&fileName=SWDA_holdings&dataType=fund'
      }
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://www.ishares.com/ch/individual/en/products/251882/ishares-msci-world-ucits-etf-acc-fund/1495092304805.ajax?fileType=csv&fileName=SWDA_holdings&dataType=fund',
      expect.any(Object)
    );
    expect(response.holdings).toMatchObject([
      { name: 'NVIDIA CORP' },
      { name: 'ELI LILLY' },
      { name: 'ASML HOLDING NV' },
      { name: 'USD CASH' }
    ]);
    expect(response.holdings[0].weight).toBeCloseTo(0.0577);
    expect(response.countries).toMatchObject([{ code: 'US' }, { code: 'NL' }]);
    expect(response.countries[0].weight).toBeCloseTo(0.0694);
    expect(response.countries[1].weight).toBeCloseTo(0.0072);
    expect(response.sectors).toMatchObject([
      { name: 'Technology' },
      { name: 'Healthcare' },
      { name: 'Cash and/or Derivatives' }
    ]);
    expect(response.sectors[0].weight).toBeCloseTo(0.0649);
  });

  it('parses fixed-income iShares CSV files with additional columns', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      text: async () => `Fund Holdings as of,"25/May/2026"

Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Notional Value,Shares,Par Value,Price,Location,Exchange,Duration,Maturity,Coupon (%),Market Currency,Effective Date
"TIPS","TREASURY (CPI) NOTE","Treasury","Fixed Income","27’171’782.61","1.84","27’171’782.61","27’431’749.00","27’431’749.00","98.38","United States","-","8.19","15/Jul/2035","1.88","USD","31/Jul/2025"
"UKTI","UK I/L GILT RegS","Treasury","Fixed Income","17’067’183.04","1.15","17’067’183.04","12’296’888.00","12’296’888.00","138.78","United Kingdom","-","1.46","22/Nov/2027","1.25","GBP","26/Apr/2006"
"FRTR","FRANCE (REPUBLIC OF) RegS","Treasury","Fixed Income","16’982’507.59","1.15","16’982’507.59","14’695’704.00","14’695’704.00","115.53","France","-","2.73","01/Mar/2029","0.10","EUR","25/Mar/2019"
"EUR","EUR CASH","Cash and/or Derivatives","Cash","5’054’220.85","0.34","5’054’220.85","4’341’368.00","4’341’368.00","116.42","European Union","-","0.00","-","0.00","EUR","01/Jan/1989"`
    } as Response);

    const response = await service.enhance({
      response: {
        assetClass: 'FIXED_INCOME',
        assetSubClass: 'ETF'
      },
      symbol: 'IGIL',
      symbolMapping: {
        iSharesHoldingEndpoint:
          'https://www.ishares.com/ch/individual/en/products/example/igil_holdings.csv'
      }
    });

    expect(response.holdings).toMatchObject([
      { name: 'TREASURY (CPI) NOTE' },
      { name: 'UK I/L GILT RegS' },
      { name: 'FRANCE (REPUBLIC OF) RegS' },
      { name: 'EUR CASH' }
    ]);
    expect(response.holdings[0].weight).toBeCloseTo(0.0184);
    expect(response.countries).toMatchObject([
      { code: 'US' },
      { code: 'GB' },
      { code: 'FR' }
    ]);
    expect(response.countries[0].weight).toBeCloseTo(0.0184);
    expect(response.sectors).toMatchObject([
      { name: 'Treasury' },
      { name: 'Cash and/or Derivatives' }
    ]);
    expect(response.sectors[0].weight).toBeCloseTo(0.0414);
  });
});
