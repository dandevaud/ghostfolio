import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { Injectable } from '@nestjs/common';

@Injectable()
export class TagService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async getTagsForUser(userId: string) {
    const tags = await this.prismaService.tag.findMany({
      include: {
        _count: {
          select: {
            orders: {
              where: {
                userId
              }
            },
            symbolProfile: {}
          }
        }
      },
      orderBy: {
        name: 'asc'
      },
      where: {
        OR: [
          {
            userId
          },
          {
            userId: null
          }
        ]
      }
    });

    return tags.map(({ id, name, userId }) => ({
      id,
      name,
      userId,
      isUsed: true
    }));
  }
}
