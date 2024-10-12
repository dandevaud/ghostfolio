import { UpdateUserSettingDto } from '@ghostfolio/api/app/user/update-user-setting.dto';
import { LoginWithAccessTokenDialog } from '@ghostfolio/client/components/login-with-access-token-dialog/login-with-access-token-dialog.component';
import { LayoutService } from '@ghostfolio/client/core/layout.service';
import { NotificationService } from '@ghostfolio/client/core/notification/notification.service';
import { DataService } from '@ghostfolio/client/services/data.service';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import {
  KEY_STAY_SIGNED_IN,
  SettingsStorageService
} from '@ghostfolio/client/services/settings-storage.service';
import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { Filter, InfoItem, User } from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import { DateRange } from '@ghostfolio/common/types';
import { GfAssistantComponent } from '@ghostfolio/ui/assistant/assistant.component';

import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  Output,
  ViewChild
} from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuTrigger } from '@angular/material/menu';
import { Router } from '@angular/router';
import { EMPTY, Subject } from 'rxjs';
import { catchError, takeUntil } from 'rxjs/operators';

@Component({
  selector: 'gf-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './header.component.html',
  styleUrls: ['./header.component.scss']
})
export class HeaderComponent implements OnChanges {
  @HostListener('window:keydown', ['$event'])
  openAssistantWithHotKey(event: KeyboardEvent) {
    if (
      event.key === '/' &&
      event.target instanceof Element &&
      event.target?.nodeName?.toLowerCase() !== 'input' &&
      event.target?.nodeName?.toLowerCase() !== 'textarea' &&
      this.hasPermissionToAccessAssistant
    ) {
      this.assistantElement.setIsOpen(true);
      this.assistentMenuTriggerElement.openMenu();

      event.preventDefault();
    }
  }

  @Input() currentRoute: string;
  @Input() deviceType: string;
  @Input() hasPermissionToChangeDateRange: boolean;
  @Input() hasPermissionToChangeFilters: boolean;
  @Input() hasTabs: boolean;
  @Input() info: InfoItem;
  @Input() pageTitle: string;
  @Input() user: User;

  @Output() signOut = new EventEmitter<void>();

  @ViewChild('assistant') assistantElement: GfAssistantComponent;
  @ViewChild('assistantTrigger') assistentMenuTriggerElement: MatMenuTrigger;

  public hasFilters: boolean;
  public hasPermissionForSocialLogin: boolean;
  public hasPermissionForSubscription: boolean;
  public hasPermissionToAccessAdminControl: boolean;
  public hasPermissionToAccessAssistant: boolean;
  public hasPermissionToAccessFearAndGreedIndex: boolean;
  public hasPermissionToCreateUser: boolean;
  public impersonationId: string;
  public isMenuOpen: boolean;
  public routeAbout = $localize`:snake-case:about`;
  public routeFeatures = $localize`:snake-case:features`;
  public routeMarkets = $localize`:snake-case:markets`;
  public routePricing = $localize`:snake-case:pricing`;
  public routeResources = $localize`:snake-case:resources`;
  public routerLinkAbout = ['/' + $localize`:snake-case:about`];
  public routerLinkFeatures = ['/' + $localize`:snake-case:features`];
  public routerLinkMarkets = ['/' + $localize`:snake-case:markets`];
  public routerLinkPricing = ['/' + $localize`:snake-case:pricing`];
  public routerLinkRegister = ['/' + $localize`:snake-case:register`];
  public routerLinkResources = ['/' + $localize`:snake-case:resources`];

  private unsubscribeSubject = new Subject<void>();

  public constructor(
    private dataService: DataService,
    private dialog: MatDialog,
    private impersonationStorageService: ImpersonationStorageService,
    private layoutService: LayoutService,
    private notificationService: NotificationService,
    private router: Router,
    private settingsStorageService: SettingsStorageService,
    private tokenStorageService: TokenStorageService,
    private userService: UserService
  ) {
    this.impersonationStorageService
      .onChangeHasImpersonation()
      .pipe(takeUntil(this.unsubscribeSubject))
      .subscribe((impersonationId) => {
        this.impersonationId = impersonationId;
      });
  }

  public ngOnChanges() {
    this.hasFilters = this.userService.hasFilters();

    this.hasPermissionForSocialLogin = hasPermission(
      this.info?.globalPermissions,
      permissions.enableSocialLogin
    );

    this.hasPermissionForSubscription = hasPermission(
      this.info?.globalPermissions,
      permissions.enableSubscription
    );

    this.hasPermissionToAccessAdminControl = hasPermission(
      this.user?.permissions,
      permissions.accessAdminControl
    );

    this.hasPermissionToAccessAssistant = hasPermission(
      this.user?.permissions,
      permissions.accessAssistant
    );

    this.hasPermissionToAccessFearAndGreedIndex = hasPermission(
      this.info?.globalPermissions,
      permissions.enableFearAndGreedIndex
    );

    this.hasPermissionToCreateUser = hasPermission(
      this.info?.globalPermissions,
      permissions.createUserAccount
    );
  }

  public closeAssistant() {
    this.assistentMenuTriggerElement?.closeMenu();
  }

  public impersonateAccount(aId: string) {
    if (aId) {
      this.impersonationStorageService.setId(aId);
    } else {
      this.impersonationStorageService.removeId();
    }

    window.location.reload();
  }

  public onDateRangeChange(dateRange: DateRange) {
    this.dataService
      .putUserSetting({ dateRange })
      .pipe(takeUntil(this.unsubscribeSubject))
      .subscribe(() => {
        this.userService
          .get(true)
          .pipe(takeUntil(this.unsubscribeSubject))
          .subscribe();
      });
  }

  public onFiltersChanged(filters: Filter[]) {
    const userSetting: UpdateUserSettingDto = {};

    for (const filter of filters) {
      const filtersType = this.getFilterType(filter.type);

      const userFilters = filters
        .filter((f) => f.type === filter.type && filter.id)
        .map((f) => f.id);

      userSetting[`filters.${filtersType}`] = userFilters.length
        ? userFilters
        : null;
    }
    ['ACCOUNT', 'ASSET_CLASS', 'TAG']
      .filter(
        (fitlerType) =>
          !filters.some((f: Filter) => f.type.toString() === fitlerType)
      )
      .forEach((filterType) => {
        userSetting[`filters.${this.getFilterType(filterType)}`] = null;
      });

    this.dataService
      .putUserSetting(userSetting)
      .pipe(takeUntil(this.unsubscribeSubject))
      .subscribe(() => {
        this.userService
          .get(true)
          .pipe(takeUntil(this.unsubscribeSubject))
          .subscribe();
      });
  }

  public onLogoClick() {
    if (['home', 'zen'].includes(this.currentRoute)) {
      this.layoutService.getShouldReloadSubject().next();
    }
  }

  public onMenuClosed() {
    this.isMenuOpen = false;
  }

  public onMenuOpened() {
    this.isMenuOpen = true;
  }

  public onOpenAssistant() {
    this.assistantElement.initialize();
  }

  public onSignOut() {
    this.signOut.next();
  }

  public openLoginDialog() {
    const dialogRef = this.dialog.open(LoginWithAccessTokenDialog, {
      autoFocus: false,
      data: {
        accessToken: '',
        hasPermissionToUseSocialLogin: this.hasPermissionForSocialLogin,
        title: $localize`Sign in`
      },
      width: '30rem'
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntil(this.unsubscribeSubject))
      .subscribe((data) => {
        if (data?.accessToken) {
          this.dataService
            .loginAnonymous(data?.accessToken)
            .pipe(
              catchError(() => {
                this.notificationService.alert({
                  title: $localize`Oops! Incorrect Security Token.`
                });

                return EMPTY;
              }),
              takeUntil(this.unsubscribeSubject)
            )
            .subscribe(({ authToken }) => {
              this.setToken(authToken);
            });
        }
      });
  }

  public setToken(aToken: string) {
    this.tokenStorageService.saveToken(
      aToken,
      this.settingsStorageService.getSetting(KEY_STAY_SIGNED_IN) === 'true'
    );

    this.router.navigate(['/']);
  }

  public ngOnDestroy() {
    this.unsubscribeSubject.next();
    this.unsubscribeSubject.complete();
  }
  private getFilterType(filterType: string) {
    if (filterType === 'ACCOUNT') {
      return 'accounts';
    } else if (filterType === 'ASSET_CLASS') {
      return 'assetClasses';
    } else if (filterType === 'TAG') {
      return 'tags';
    }
  }
}
