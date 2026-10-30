import { Module } from '@nestjs/common';
import { BuildingsModule } from '../buildings/buildings.module';
import { ConnectorService } from './application/connector.service';
import { GraphValidatorService } from './application/graph-validator.service';
import { GraphCacheService } from './application/graph-cache.service';
import { GraphSnapshotBuilder } from './application/graph-snapshot.builder';
import { DraftApplyService } from './application/draft-apply.service';
import { FloorCalibrationService } from './application/floor-calibration.service';
import { MaintenanceService } from './application/maintenance.service';
import { PoiService } from './application/poi.service';
import { ConnectorsController } from './connectors.controller';
import { GraphController } from './graph.controller';
import { GraphService } from './graph.service';
import { MaintenanceController } from './maintenance.controller';

@Module({
  imports: [BuildingsModule],
  controllers: [GraphController, ConnectorsController, MaintenanceController],
  providers: [GraphService, PoiService, DraftApplyService, FloorCalibrationService, ConnectorService, MaintenanceService, GraphSnapshotBuilder, GraphCacheService, GraphValidatorService],
  exports: [GraphService, GraphCacheService, GraphValidatorService],
})
export class GraphModule {}
