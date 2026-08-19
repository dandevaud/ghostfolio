import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { Injectable } from '@nestjs/common';
import { DataSource, Prisma, AssetProfileOverrides } from '@prisma/client';

@Injectable()
export class SymbolProfileOverwriteService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async add(
    assetProfileOverwrite: Prisma.AssetProfileOverridesCreateInput
  ): Promise<AssetProfileOverrides | never> {
    return this.prismaService.assetProfileOverrides.create({
      data: assetProfileOverwrite
    });
  }

  public async delete(symbolProfileId: string) {
    return this.prismaService.assetProfileOverrides.delete({
      where: { symbolProfileId: symbolProfileId }
    });
  }

  public updateSymbolProfileOverrides({
    assetClass,
    assetSubClass,
    name,
    countries,
    sectors,
    url,
    symbolProfileId
  }: Prisma.AssetProfileOverridesUpdateInput & { symbolProfileId: string }) {
    return this.prismaService.assetProfileOverrides.update({
      data: {
        assetClass,
        assetSubClass,
        name,
        countries,
        sectors,
        url
      },
      where: { symbolProfileId: symbolProfileId }
    });
  }

  public async GetSymbolProfileId(
    Symbol: string,
    datasource: DataSource
  ): Promise<string> {
    const SymbolProfileId = await this.prismaService.symbolProfile
      .findFirst({
        where: {
          symbol: Symbol,
          dataSource: datasource
        }
      })
      .then((s) => s.id);

    const symbolProfileIdSaved = await this.prismaService.assetProfileOverrides
      .findFirst({
        where: {
          symbolProfileId: SymbolProfileId
        }
      })
      .then((s) => s?.symbolProfileId);

    return symbolProfileIdSaved;
  }
}
