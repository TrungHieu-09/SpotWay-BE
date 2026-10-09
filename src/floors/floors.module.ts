import { Module } from '@nestjs/common';
import { BuildingsModule } from '../buildings/buildings.module';
import { GraphModule } from '../graph/graph.module';
import { FloorsController } from './floors.controller';
@Module({ imports: [BuildingsModule, GraphModule], controllers: [FloorsController] }) export class FloorsModule {}
