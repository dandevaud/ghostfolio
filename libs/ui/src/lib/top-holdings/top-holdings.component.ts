import { canOpenHoldingDetail, getLocale } from '@ghostfolio/common/helper';
import {
  AssetProfileIdentifier,
  HoldingWithParents,
  PortfolioPosition
} from '@ghostfolio/common/interfaces';

import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  ViewChild
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatPaginator, MatPaginatorModule } from '@angular/material/paginator';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { capitalize } from 'lodash';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';

import { GfValueComponent } from '../value/value.component';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    GfValueComponent,
    MatButtonModule,
    MatPaginatorModule,
    MatTableModule,
    NgxSkeletonLoaderModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-top-holdings',
  styleUrls: ['./top-holdings.component.scss'],
  templateUrl: './top-holdings.component.html'
})
export class GfTopHoldingsComponent implements OnChanges {
  @Input() baseCurrency: string;
  @Input() locale = getLocale();
  @Input() pageSize = Number.MAX_SAFE_INTEGER;
  @Input() topHoldings: HoldingWithParents[];

  @Output() holdingClicked = new EventEmitter<AssetProfileIdentifier>();

  @ViewChild(MatPaginator) paginator: MatPaginator;

  public dataSource = new MatTableDataSource<HoldingWithParents>();
  public displayedColumns: string[] = [
    'name',
    'valueInBaseCurrency',
    'allocationInPercentage'
  ];
  public isLoading = true;

  private readonly prettifiedAssetNames = new WeakMap<
    HoldingWithParents,
    string
  >();
  private readonly canShowDetailsCache = new WeakMap<
    { position?: PortfolioPosition },
    boolean
  >();

  public ngOnChanges() {
    this.isLoading = true;

    this.dataSource = new MatTableDataSource(this.topHoldings);
    this.dataSource.paginator = this.paginator;

    if (this.topHoldings) {
      for (const holding of this.topHoldings) {
        if (!this.prettifiedAssetNames.has(holding)) {
          this.prettifiedAssetNames.set(
            holding,
            this.toPrettifiedAssetName(holding?.name)
          );
        }
      }

      this.isLoading = false;
    }
  }

  public canShowDetails(holding: { position?: PortfolioPosition }): boolean {
    const cachedValue = this.canShowDetailsCache.get(holding);

    if (cachedValue !== undefined) {
      return cachedValue;
    }

    const canShowDetails =
      !!holding?.position && canOpenHoldingDetail(holding.position);
    this.canShowDetailsCache.set(holding, canShowDetails);

    return canShowDetails;
  }

  public onClickHolding({ position }: { position?: PortfolioPosition }) {
    if (!position || !canOpenHoldingDetail(position)) {
      return;
    }

    this.holdingClicked.emit({
      dataSource: position.assetProfile.dataSource,
      symbol: position.assetProfile.symbol
    });
  }

  public onShowAllHoldings() {
    this.pageSize = Number.MAX_SAFE_INTEGER;

    setTimeout(() => {
      this.dataSource.paginator = this.paginator;
    });
  }

  public prettifyAssetName(holding: HoldingWithParents) {
    const prettifiedAssetName = this.prettifiedAssetNames.get(holding);

    if (prettifiedAssetName !== undefined) {
      return prettifiedAssetName;
    }

    const prettified = this.toPrettifiedAssetName(holding?.name);
    this.prettifiedAssetNames.set(holding, prettified);

    return prettified;
  }

  private toPrettifiedAssetName(name: string) {
    if (!name) {
      return '';
    }

    return name
      .split(' ')
      .filter((token) => {
        return !token.startsWith('(') && !token.endsWith(')');
      })
      .map((token) => {
        if (token.length <= 2) {
          return token.toUpperCase();
        }

        return capitalize(token);
      })
      .join(' ');
  }
}
