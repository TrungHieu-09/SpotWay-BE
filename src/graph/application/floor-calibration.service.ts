import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthUser } from '../../common/auth.types';
import { TenantAccessService } from '../../common/tenant-access.service';
import { PrismaService } from '../../database/prisma.service';
import { CalibrateFloorDto, CalibrationResponse } from '../dto/calibration.dto';
import { scaleFromReference } from '../domain/coordinate-transform';
import { bumpGraphVersion, loadFloor, recomputeEdgeWeights } from './graph-support';

const invalid = (message: string) => new BadRequestException({ code: 'INVALID_CALIBRATION', message });

@Injectable()
export class FloorCalibrationService {
  constructor(private readonly prisma: PrismaService, private readonly access: TenantAccessService) {}

  /** Sets Floor.metersPerPixel and recomputes every live edge's weightMeters in the same transaction. */
  async calibrate(user: AuthUser, floorId: string, dto: CalibrateFloorDto): Promise<CalibrationResponse> {
    const floor = await loadFloor(this.prisma, this.access, user, floorId);
    const metersPerPixel = this.resolveScale(dto);
    return this.prisma.$transaction(async (tx) => {
      const graphVersion = await bumpGraphVersion(tx, floor.id, dto.expectedGraphVersion);
      await tx.floor.update({ where: { id: floor.id }, data: { metersPerPixel } });
      const edgesRecomputed = await recomputeEdgeWeights(tx, floor.id, metersPerPixel);
      return { floorId: floor.id, metersPerPixel, edgesRecomputed, graphVersion };
    });
  }

  private resolveScale(dto: CalibrateFloorDto): number {
    const hasDirect = dto.metersPerPixel !== undefined;
    const hasReference = dto.pointA !== undefined || dto.pointB !== undefined || dto.realDistanceMeters !== undefined;
    if (hasDirect === hasReference) throw invalid('Provide either metersPerPixel, or pointA + pointB + realDistanceMeters');
    if (hasDirect) return dto.metersPerPixel!;
    if (!dto.pointA || !dto.pointB || dto.realDistanceMeters === undefined) throw invalid('pointA, pointB and realDistanceMeters are all required');
    const scale = scaleFromReference(dto.pointA, dto.pointB, dto.realDistanceMeters);
    if (scale === null) throw invalid('The two calibration points must be different');
    return scale;
  }
}
