import { SymbolProfile } from '@prisma/client';

export interface DataEnhancerInterface {
  enhance({
    requestTimeout,
    response,
    symbol,
    symbolMapping
  }: {
    requestTimeout?: number;
    response: Partial<SymbolProfile>;
    symbol: string;
    symbolMapping?: { [key: string]: string };
  }): Promise<Partial<SymbolProfile>>;

  getName(): string;

  getTestSymbol(): string;
}
