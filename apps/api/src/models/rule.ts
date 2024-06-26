import { RuleSettings } from '@ghostfolio/api/models/interfaces/rule-settings.interface';
import { ExchangeRateDataService } from '@ghostfolio/api/services/exchange-rate-data/exchange-rate-data.service';
import { groupBy } from '@ghostfolio/common/helper';
import { UserSettings } from '@ghostfolio/common/interfaces';
import { TimelinePosition } from '@ghostfolio/common/models';

import { EvaluationResult } from './interfaces/evaluation-result.interface';
import { RuleInterface } from './interfaces/rule.interface';

export abstract class Rule<T extends RuleSettings> implements RuleInterface<T> {
  private key: string;
  private name: string;

  public constructor(
    protected exchangeRateDataService: ExchangeRateDataService,
    {
      key,
      name
    }: {
      key: string;
      name: string;
    }
  ) {
    this.key = key;
    this.name = name;
  }

  public getKey() {
    return this.key;
  }

  public getName() {
    return this.name;
  }

  public groupCurrentPositionsByAttribute(
    positions: TimelinePosition[],
    attribute: keyof TimelinePosition,
    baseCurrency: string
  ) {
    return Array.from(groupBy(attribute, positions).entries()).map(
      ([attributeValue, objs]) => ({
        groupKey: attributeValue,
        investment: objs.reduce(
          (previousValue, currentValue) =>
            previousValue + currentValue.investment.toNumber(),
          0
        ),
        value: objs.reduce(
          (previousValue, currentValue) =>
            previousValue +
            this.exchangeRateDataService.toCurrency(
              currentValue.quantity.mul(currentValue.marketPrice).toNumber(),
              currentValue.currency,
              baseCurrency
            ),
          0
        )
      })
    );
  }

  public abstract evaluate(aRuleSettings: T): EvaluationResult;

  public abstract getSettings(aUserSettings: UserSettings): T;
}
