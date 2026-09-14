import { DATE_FORMAT, parseDate } from '@ghostfolio/common/helper';

import { Logger } from '@nestjs/common';
import { eachDayOfInterval, format } from 'date-fns';

import { ExchangeRateDataService } from './exchange-rate-data.service';

describe('ExchangeRateDataService', () => {
  let loggerError: jest.SpyInstance;
  let marketDataBySymbol: {
    [symbol: string]: { date: string; marketPrice: number }[];
  };
  let service: ExchangeRateDataService;

  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(parseDate('2026-08-12').getTime());
  });

  beforeEach(() => {
    loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    marketDataBySymbol = {};
    service = createExchangeRateDataService(() => marketDataBySymbol);
  });

  afterEach(() => {
    loggerError.mockRestore();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe('getExchangeRatesByCurrency', () => {
    it('returns an empty map when startDate is missing', async () => {
      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['USD'],
        startDate: undefined as unknown as Date,
        targetCurrency: 'CAD'
      });

      expect(exchangeRates).toEqual({});
    });

    it('returns identity factors for the same currency', async () => {
      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['CAD'],
        endDate: parseDate('2026-08-12'),
        startDate: parseDate('2026-08-07'),
        targetCurrency: 'CAD'
      });

      expectEveryDateToEqual({
        endDate: '2026-08-12',
        rates: exchangeRates.CADCAD,
        startDate: '2026-08-07',
        value: 1
      });
    });

    it('returns derived-currency factors after mocked initialization', async () => {
      await service.initialize();

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['GBp', 'GBP'],
        endDate: parseDate('2026-08-12'),
        startDate: parseDate('2026-08-07'),
        targetCurrency: 'GBP'
      });

      expectEveryDateToEqual({
        endDate: '2026-08-12',
        rates: exchangeRates.GBpGBP,
        startDate: '2026-08-07',
        value: 0.01
      });
      expectEveryDateToEqual({
        endDate: '2026-08-12',
        rates: exchangeRates.GBPGBP,
        startDate: '2026-08-07',
        value: 1
      });
    });

    it('preserves observed rates and backward-fills missing dates', async () => {
      marketDataBySymbol = {
        USDCAD: [
          { date: '2026-08-08', marketPrice: 1.2 },
          { date: '2026-08-12', marketPrice: 1.4 }
        ]
      };

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['USD'],
        endDate: parseDate('2026-08-12'),
        startDate: parseDate('2026-08-07'),
        targetCurrency: 'CAD'
      });

      expect(exchangeRates.USDCAD).toEqual({
        '2026-08-07': 1.2,
        '2026-08-08': 1.2,
        '2026-08-09': 1.4,
        '2026-08-10': 1.4,
        '2026-08-11': 1.4,
        '2026-08-12': 1.4
      });
    });

    it('falls back to 1 and logs when historical rates are missing', async () => {
      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['USD'],
        endDate: parseDate('2026-08-12'),
        startDate: parseDate('2026-08-07'),
        targetCurrency: 'CAD'
      });

      expectEveryDateToEqual({
        endDate: '2026-08-12',
        rates: exchangeRates.USDCAD,
        startDate: '2026-08-07',
        value: 1
      });
      expect(loggerError).toHaveBeenCalled();
    });
  });
});

function createExchangeRateDataService(
  getMarketDataBySymbol: () => {
    [symbol: string]: { date: string; marketPrice: number }[];
  }
) {
  const dataProviderService = {
    getDataSourceForExchangeRates: jest.fn().mockReturnValue('YAHOO'),
    getHistorical: jest.fn().mockResolvedValue({}),
    getQuotes: jest.fn().mockResolvedValue({})
  };
  const marketDataService = {
    getRange: jest
      .fn()
      .mockImplementation(
        async ({
          assetProfileIdentifiers
        }: {
          assetProfileIdentifiers: { symbol: string }[];
        }) => {
          return (getMarketDataBySymbol()[assetProfileIdentifiers[0].symbol] ??
            []
          ).map(({ date, marketPrice }) => {
            return {
              date: parseDate(date),
              marketPrice
            };
          });
        }
      )
  };
  const prismaService = {
    account: { findMany: jest.fn().mockResolvedValue([]) },
    symbolProfile: { findMany: jest.fn().mockResolvedValue([]) }
  };
  const propertyService = {
    getByKey: jest.fn().mockResolvedValue([])
  };

  return new ExchangeRateDataService(
    dataProviderService as any,
    marketDataService as any,
    prismaService as any,
    propertyService as any
  );
}

function expectEveryDateToEqual({
  endDate,
  rates,
  startDate,
  value
}: {
  endDate: string;
  rates: { [dateString: string]: number };
  startDate: string;
  value: number;
}) {
  const dates = eachDayOfInterval({
    end: parseDate(endDate),
    start: parseDate(startDate)
  }).map((date) => {
    return format(date, DATE_FORMAT);
  });

  expect(Object.keys(rates).sort()).toEqual(dates);

  for (const date of dates) {
    expect(rates[date]).toBe(value);
  }
}
