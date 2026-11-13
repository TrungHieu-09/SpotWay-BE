import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { BuildingStatus, TenantStatus } from '@prisma/client';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Public } from '../common/public.decorator';
import { RateLimit } from '../common/rate-limit.guard';
import { ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger';
import { PrismaService } from '../database/prisma.service';
import { AnalyticsService } from './analytics.service';

/** Events only the guest app can know about (it routes on the phone, so the backend never sees these). */
export const CLIENT_EVENT_TYPES = ['SEARCH_PERFORMED', 'ROUTE_STARTED', 'ROUTE_COMPLETED', 'EVACUATION_STARTED', 'STORE_VIEWED', 'HELP_REQUESTED', 'SAFE_REACHED'] as const;
export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

export class ClientEventDto {
  @ApiProperty({ enum: CLIENT_EVENT_TYPES }) @IsIn(CLIENT_EVENT_TYPES as unknown as string[]) eventType!: ClientEventType;
  @ApiProperty({ format: 'uuid' }) @IsUUID() buildingId!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() floorId?: string;
  @ApiPropertyOptional({ description: 'Store or POI id the user is heading to / looking at' }) @IsOptional() @IsUUID() targetId?: string;
  @ApiPropertyOptional({ maxLength: 80 }) @IsOptional() @IsString() @MaxLength(80) query?: string;
  @ApiPropertyOptional({ description: 'HELP_REQUESTED only: what the guest needs', enum: ['LOST', 'WHEELCHAIR', 'SMOKE', 'OTHER'] }) @IsOptional() @IsIn(['LOST', 'WHEELCHAIR', 'SMOKE', 'OTHER']) helpKind?: 'LOST' | 'WHEELCHAIR' | 'SMOKE' | 'OTHER';
  @ApiPropertyOptional({ description: 'Node the guest is standing at (help requests)', format: 'uuid' }) @IsOptional() @IsUUID() nodeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(10000) resultCount?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(100000) distanceMeters?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(86400) durationSeconds?: number;
}

@ApiTags('Public Navigation') @Public() @Controller('public/events')
export class ClientEventsController {
  constructor(private readonly prisma: PrismaService, private readonly analytics: AnalyticsService) {}

  @Post() @HttpCode(202) @RateLimit(120, 60_000) @ApiOperation({ summary: 'Record an anonymous usage event reported by the guest app' }) @ApiEnvelopeResponse(202, 'Event accepted') @ApiStandardErrors()
  async record(@Body() dto: ClientEventDto) {
    const building = await this.prisma.building.findFirst({
      where: { id: dto.buildingId, status: BuildingStatus.ACTIVE, deletedAt: null, tenant: { is: { status: TenantStatus.ACTIVE, archived: false, deletedAt: null } } },
      select: { id: true, tenantId: true },
    });
    // Unknown building: accept silently so a stale app cannot be used to probe which buildings exist.
    if (!building) return { accepted: false };
    const context: Record<string, unknown> = { source: 'mobile' };
    if (dto.targetId) context.toStoreId = dto.targetId;
    if (dto.query !== undefined) context.query = dto.query.trim().toLowerCase();
    for (const key of ['resultCount', 'distanceMeters', 'durationSeconds', 'helpKind', 'nodeId'] as const) if (dto[key] !== undefined) context[key] = dto[key];
    await this.analytics.enqueue({ eventType: dto.eventType, tenantId: building.tenantId, buildingId: building.id, floorId: dto.floorId ?? null, context }).catch(() => undefined);
    return { accepted: true };
  }
}
