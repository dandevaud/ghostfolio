import { NotificationService } from '@ghostfolio/client/core/notification/notification.service';
import { getDateFnsLocale, getLocale } from '@ghostfolio/common/helper';
import { PortfolioSummary, User } from '@ghostfolio/common/interfaces';
import { PerformanceCalculationType } from '@ghostfolio/common/types/performance-calculation-type.type';
import { translate } from '@ghostfolio/ui/i18n';
import { GfValueComponent } from '@ghostfolio/ui/value';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output
} from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import { IonIcon } from '@ionic/angular/standalone';
import { formatDistanceToNow } from 'date-fns';
import { addIcons } from 'ionicons';
import {
  ellipsisHorizontalCircleOutline,
  informationCircleOutline
} from 'ionicons/icons';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, GfValueComponent, IonIcon, MatTooltipModule],
  selector: 'gf-portfolio-summary',
  styleUrls: ['./portfolio-summary.component.scss'],
  templateUrl: './portfolio-summary.component.html'
})
export class GfPortfolioSummaryComponent implements OnChanges {
  @Input() baseCurrency: string;
  @Input() hasPermissionToUpdateUserSettings: boolean;
  @Input() isLoading: boolean;
  @Input() language: string;
  @Input() locale = getLocale();
  @Input() summary: PortfolioSummary;
  @Input() user: User;

  @Output() emergencyFundChanged = new EventEmitter<number>();

  public buyAndSellActivitiesTooltip = translate(
    'BUY_AND_SELL_ACTIVITIES_TOOLTIP'
  );
  public timeInMarket: string;

  protected calculationType: { title: string; value: string };

  public constructor(private notificationService: NotificationService) {
    addIcons({ ellipsisHorizontalCircleOutline, informationCircleOutline });
  }

  public ngOnChanges() {
    if (this.summary) {
      if (this.user.dateOfFirstActivity) {
        this.timeInMarket = formatDistanceToNow(this.user.dateOfFirstActivity, {
          locale: getDateFnsLocale(this.language)
        });
      } else {
        this.timeInMarket = '-';
      }
    } else {
      this.timeInMarket = undefined;
    }
    this.calculationType = this.getCalulationType();
  }

  public onEditEmergencyFund() {
    this.notificationService.prompt({
      confirmFn: (value) => {
        const emergencyFund = parseFloat(value.trim()) || 0;

        this.emergencyFundChanged.emit(emergencyFund);
      },
      confirmLabel: $localize`Save`,
      defaultValue: this.summary.emergencyFund?.total?.toString() ?? '0',
      title: $localize`Please set the amount of your emergency fund.`
    });
  }

  private getCalulationType(): { title: string; value: string } {
    switch (this.user?.settings?.performanceCalculationType) {
      case PerformanceCalculationType.ROAI:
        return {
          title: 'Return on Average Investment',
          value: PerformanceCalculationType.ROAI
        };
      case PerformanceCalculationType.ROI:
        return {
          title: 'Return on Investment',
          value: PerformanceCalculationType.ROI
        };

      default:
        return undefined;
    }
  }
}
