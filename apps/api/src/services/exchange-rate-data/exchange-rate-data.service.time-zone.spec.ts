/**
 * @jest-environment <rootDir>/jest-environment-tz.js
 * @jest-environment-options {"timeZone": "America/New_York"}
 */
import {
  activityDummyData,
  assetProfileDummyData,
  userDummyData
} from '@ghostfolio/api/app/portfolio/calculator/portfolio-calculator-test-utils';
import { PortfolioCalculatorFactory } from '@ghostfolio/api/app/portfolio/calculator/portfolio-calculator.factory';
import { CurrentRateService } from '@ghostfolio/api/app/portfolio/current-rate.service';
import { RedisCacheService } from '@ghostfolio/api/app/redis-cache/redis-cache.service';
import { RedisCacheServiceMock } from '@ghostfolio/api/app/redis-cache/redis-cache.service.mock';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { ExchangeRateDataService } from '@ghostfolio/api/services/exchange-rate-data/exchange-rate-data.service';
import { PortfolioSnapshotService } from '@ghostfolio/api/services/queues/portfolio-snapshot/portfolio-snapshot.service';
import { PortfolioSnapshotServiceMock } from '@ghostfolio/api/services/queues/portfolio-snapshot/portfolio-snapshot.service.mock';
import { DATE_FORMAT, parseDate } from '@ghostfolio/common/helper';
import { Activity } from '@ghostfolio/common/interfaces';
import { PerformanceCalculationType } from '@ghostfolio/common/types/performance-calculation-type.type';

import { Logger } from '@nestjs/common';
import { eachDayOfInterval, format } from 'date-fns';

jest.mock(
  '@ghostfolio/api/services/queues/portfolio-snapshot/portfolio-snapshot.service',
  () => {
    return {
      PortfolioSnapshotService: jest.fn().mockImplementation(() => {
        return PortfolioSnapshotServiceMock;
      })
    };
  }
);

jest.mock('@ghostfolio/api/app/redis-cache/redis-cache.service', () => {
  return {
    RedisCacheService: jest.fn().mockImplementation(() => {
      return RedisCacheServiceMock;
    })
  };
});

const EUR_PLN = 4.25;
const EUR_USD = 1.17;
const MSFT_MARKET_PRICE = 495.4;
const MSFT_UNIT_PRICE = 100;
const SKIPPED_ACTIVITY_DATE = '2026-08-11';
const USD_CAD = 1.393;
const USD_PLN = EUR_PLN / EUR_USD;

describe('ExchangeRateDataService in a time zone behind UTC', () => {
  let loggerError: jest.SpyInstance;
  let marketDataBySymbol: {
    [symbol: string]: { date: string; marketPrice: number }[];
  };
  let service: ExchangeRateDataService;

  beforeAll(() => {
    // 2026-08-12 21:30 in New York, but already 2026-08-13 in UTC
    jest.useFakeTimers().setSystemTime(new Date('2026-08-13T01:30:00.000Z'));
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
    it('fills every local calendar day for a sparse USDCAD range', async () => {
      const startDate = parseDate('2026-08-07');
      const endDate = parseDate('2026-08-12');
      const startTimestamp = startDate.getTime();
      const endTimestamp = endDate.getTime();

      marketDataBySymbol = {
        USDCAD: [{ date: '2026-08-12', marketPrice: USD_CAD }]
      };

      const exchangeRates = await service.getExchangeRatesByCurrency({
        endDate,
        startDate,
        currencies: ['USD'],
        targetCurrency: 'CAD'
      });

      expectEveryDateToEqual({
        endDate: '2026-08-12',
        rates: exchangeRates.USDCAD,
        startDate: '2026-08-07',
        value: USD_CAD
      });
      expect(exchangeRates.USDCAD['2026-08-07']).toBe(USD_CAD);
      expect(exchangeRates.USDCAD['2026-08-09']).toBe(USD_CAD);
      expect(exchangeRates.USDCAD['2026-08-11']).toBe(USD_CAD);
      expect(startDate.getTime()).toBe(startTimestamp);
      expect(endDate.getTime()).toBe(endTimestamp);
    });

    it('fills USD to PLN through the EUR cross-rate path on skipped weekend and activity dates', async () => {
      marketDataBySymbol = {
        EURUSD: [{ date: '2026-08-12', marketPrice: EUR_USD }],
        USDEUR: [{ date: '2026-08-12', marketPrice: 1 / EUR_USD }],
        USDPLN: [{ date: '2026-08-12', marketPrice: USD_PLN }]
      };

      const exchangeRates = await service.getExchangeRatesByCurrency({
        currencies: ['USD', 'EUR'],
        endDate: parseDate('2026-08-12'),
        startDate: parseDate('2026-08-07'),
        targetCurrency: 'PLN'
      });

      expectEveryDateToEqual({
        endDate: '2026-08-12',
        rates: exchangeRates.USDPLN,
        startDate: '2026-08-07',
        value: USD_PLN
      });
      expectEveryDateToEqual({
        endDate: '2026-08-12',
        precision: 10,
        rates: exchangeRates.EURPLN,
        startDate: '2026-08-07',
        value: EUR_PLN
      });
      expect(exchangeRates.USDPLN['2026-08-07']).toBe(USD_PLN);
      expect(exchangeRates.USDPLN['2026-08-09']).toBe(USD_PLN);
      expect(exchangeRates.USDPLN['2026-08-11']).toBe(USD_PLN);
      expect(exchangeRates.EURPLN['2026-08-07']).toBeCloseTo(EUR_PLN, 10);
      expect(exchangeRates.EURPLN['2026-08-09']).toBeCloseTo(EUR_PLN, 10);
      expect(exchangeRates.EURPLN['2026-08-11']).toBeCloseTo(EUR_PLN, 10);
      expect(exchangeRates.USDPLN['2026-08-11']).not.toBe(1);
      expect(exchangeRates.EURPLN['2026-08-11']).not.toBe(1);
    });

    it.each([
      {
        endDate: '2026-08-12',
        label: 'a one-day interval',
        startDate: '2026-08-12'
      },
      {
        endDate: '2026-02-02',
        label: 'a month boundary',
        startDate: '2026-01-30'
      },
      {
        endDate: '2026-01-02',
        label: 'a year boundary',
        startDate: '2025-12-30'
      },
      {
        endDate: '2026-03-09',
        label: 'the spring DST transition',
        startDate: '2026-03-07'
      },
      {
        endDate: '2025-11-03',
        label: 'the fall DST transition',
        startDate: '2025-11-01'
      }
    ])(
      'covers every calendar day for $label',
      async ({ endDate, startDate }) => {
        marketDataBySymbol = {
          USDCAD: [{ date: endDate, marketPrice: USD_CAD }]
        };

        const exchangeRates = await service.getExchangeRatesByCurrency({
          currencies: ['USD'],
          endDate: parseDate(endDate),
          startDate: parseDate(startDate),
          targetCurrency: 'CAD'
        });

        expectEveryDateToEqual({
          endDate,
          startDate,
          rates: exchangeRates.USDCAD,
          value: USD_CAD
        });
      }
    );
  });

  describe('computeSnapshot', () => {
    it('converts an MSFT purchase on a skipped date into CAD', async () => {
      const portfolioSnapshot = await computeMsftBuySnapshot({
        baseCurrency: 'CAD',
        exchangeRate: USD_CAD,
        symbol: 'USDCAD'
      });

      expect(
        portfolioSnapshot.currentValueInBaseCurrency.toNumber()
      ).toBeCloseTo(MSFT_MARKET_PRICE * USD_CAD, 6);
      expect(
        portfolioSnapshot.totalInvestmentWithCurrencyEffect.toNumber()
      ).toBeCloseTo(MSFT_UNIT_PRICE * USD_CAD, 6);
      expect(portfolioSnapshot.historicalData.length).toBeGreaterThan(0);

      const historicalItem = portfolioSnapshot.historicalData.find(
        ({ date }) => {
          return date === SKIPPED_ACTIVITY_DATE;
        }
      );

      expect(historicalItem).toBeDefined();
      expect(historicalItem?.valueWithCurrencyEffect).toBeCloseTo(
        MSFT_MARKET_PRICE * USD_CAD,
        6
      );
      expect(
        historicalItem?.totalInvestmentValueWithCurrencyEffect
      ).toBeCloseTo(MSFT_UNIT_PRICE * USD_CAD, 6);
    });

    it('converts an MSFT purchase on a skipped date into PLN', async () => {
      const portfolioSnapshot = await computeMsftBuySnapshot({
        baseCurrency: 'PLN',
        exchangeRate: USD_PLN,
        symbol: 'USDPLN'
      });

      expect(
        portfolioSnapshot.currentValueInBaseCurrency.toNumber()
      ).toBeCloseTo(MSFT_MARKET_PRICE * USD_PLN, 6);
      expect(
        portfolioSnapshot.totalInvestmentWithCurrencyEffect.toNumber()
      ).toBeCloseTo(MSFT_UNIT_PRICE * USD_PLN, 6);
      expect(portfolioSnapshot.historicalData.length).toBeGreaterThan(0);

      const historicalItem = portfolioSnapshot.historicalData.find(
        ({ date }) => {
          return date === SKIPPED_ACTIVITY_DATE;
        }
      );

      expect(historicalItem).toBeDefined();
      expect(historicalItem?.valueWithCurrencyEffect).toBeCloseTo(
        MSFT_MARKET_PRICE * USD_PLN,
        6
      );
      expect(
        historicalItem?.totalInvestmentValueWithCurrencyEffect
      ).toBeCloseTo(MSFT_UNIT_PRICE * USD_PLN, 6);
    });

    it('keeps same-currency USD values unconverted', async () => {
      const portfolioSnapshot = await computeMsftBuySnapshot({
        baseCurrency: 'USD',
        exchangeRate: 1,
        symbol: 'USDUSD'
      });

      expect(
        portfolioSnapshot.currentValueInBaseCurrency.toNumber()
      ).toBeCloseTo(MSFT_MARKET_PRICE, 6);
      expect(
        portfolioSnapshot.totalInvestmentWithCurrencyEffect.toNumber()
      ).toBeCloseTo(MSFT_UNIT_PRICE, 6);
      expect(portfolioSnapshot.historicalData.length).toBeGreaterThan(0);

      const historicalItem = portfolioSnapshot.historicalData.find(
        ({ date }) => {
          return date === SKIPPED_ACTIVITY_DATE;
        }
      );

      expect(historicalItem).toBeDefined();
      expect(historicalItem?.valueWithCurrencyEffect).toBeCloseTo(
        MSFT_MARKET_PRICE,
        6
      );
      expect(
        historicalItem?.totalInvestmentValueWithCurrencyEffect
      ).toBeCloseTo(MSFT_UNIT_PRICE, 6);
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

async function computeMsftBuySnapshot({
  baseCurrency,
  exchangeRate,
  symbol
}: {
  baseCurrency: string;
  exchangeRate: number;
  symbol: string;
}) {
  PortfolioSnapshotServiceMock.reset();
  RedisCacheServiceMock.reset();

  const exchangeRateDataService = createExchangeRateDataService(() => {
    if (baseCurrency === 'USD') {
      return {};
    }

    return {
      [symbol]: [{ date: '2026-08-12', marketPrice: exchangeRate }]
    };
  });
  const currentRateService = {
    getValues: async ({
      dataGatheringItems,
      dateQuery
    }: {
      dataGatheringItems: { dataSource: string; symbol: string }[];
      dateQuery: { gte?: Date; lt?: Date };
    }) => {
      const values = [];

      for (const date of eachDayOfInterval({
        end: dateQuery.lt ?? new Date(),
        start: dateQuery.gte ?? parseDate(SKIPPED_ACTIVITY_DATE)
      })) {
        for (const { dataSource, symbol: itemSymbol } of dataGatheringItems) {
          values.push({
            dataSource,
            date,
            marketPrice: MSFT_MARKET_PRICE,
            symbol: itemSymbol
          });
        }
      }

      return {
        dataProviderInfos: [],
        errors: [],
        values
      };
    }
  } as unknown as CurrentRateService;

  const portfolioCalculatorFactory = new PortfolioCalculatorFactory(
    new ConfigurationService(),
    currentRateService,
    exchangeRateDataService,
    new PortfolioSnapshotService(null, null),
    new RedisCacheService(null, null)
  );

  const activities: Activity[] = [
    {
      ...activityDummyData,
      assetProfile: {
        ...assetProfileDummyData,
        currency: 'USD',
        dataSource: 'YAHOO',
        name: 'Microsoft Inc.',
        symbol: 'MSFT'
      },
      date: parseDate(SKIPPED_ACTIVITY_DATE),
      feeInAssetProfileCurrency: 0,
      feeInBaseCurrency: 0,
      quantity: 1,
      type: 'BUY',
      unitPriceInAssetProfileCurrency: MSFT_UNIT_PRICE
    }
  ];

  const portfolioCalculator = portfolioCalculatorFactory.createCalculator({
    activities,
    calculationType: PerformanceCalculationType.ROAI,
    currency: baseCurrency,
    usePortfolioSnapshotCache: false,
    userId: userDummyData.id
  });

  return portfolioCalculator.computeSnapshot();
}

function expectEveryDateToEqual({
  endDate,
  precision,
  rates,
  startDate,
  value
}: {
  endDate: string;
  precision?: number;
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
    if (precision === undefined) {
      expect(rates[date]).toBe(value);
    } else {
      expect(rates[date]).toBeCloseTo(value, precision);
    }
  }
}
