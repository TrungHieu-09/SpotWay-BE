import { Module } from '@nestjs/common';
import { BuildingsModule } from '../buildings/buildings.module';
import { GraphModule } from '../graph/graph.module';
import { FloorsController } from './floors.controller';
import { StorageService } from './storage.service';
import { FloorplanIntelligenceService } from './floorplan-intelligence.service';
import { StoreSyncService } from './store-sync.service';
@Module({ imports: [BuildingsModule, GraphModule], controllers: [FloorsController], providers: [StorageService, FloorplanIntelligenceService, StoreSyncService] }) export class FloorsModule {}
