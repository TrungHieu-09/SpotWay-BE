import { Module } from '@nestjs/common';
import { BuildingsModule } from '../buildings/buildings.module';
import { ConnectorService } from './application/connector.service';
import { GraphValidatorService } from './application/graph-validator.service';
import { GraphCacheService } from './application/graph-cache.service';
import { GraphSnapshotBuilder } from './application/graph-snapshot.builder';
import { DraftApplyService } from './application/draft-apply.service';
import { FloorCalibrationService } from './application/floor-calibration.service';
import { PoiService } from './application/poi.service';
import { ConnectorsController } from './connectors.controller';
import { GraphController } from './graph.controller';
import { GraphService } from './graph.service';

@Module({
  imports: [BuildingsModule],
  controllers: [GraphController, ConnectorsController],
  providers: [GraphService, PoiService, DraftApplyService, FloorCalibrationService, ConnectorService, GraphSnapshotBuilder, GraphCacheService, GraphValidatorService],
  exports: [GraphService, GraphCacheService, GraphValidatorService],
})
export class GraphModule {}
