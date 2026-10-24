import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class PaginationQuery {
  @Type(() => Number) @IsInt() @Min(1) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}

export const pageMeta = (page: number, limit: number, total: number) => ({ page, limit, total });
