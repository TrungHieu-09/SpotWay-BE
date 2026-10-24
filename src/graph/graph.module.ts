import { Module } from '@nestjs/common';
import { BuildingsModule } from '../buildings/buildings.module';
import { GraphController } from './graph.controller';
import { GraphService } from './graph.service';

@Module({ imports: [BuildingsModule], controllers: [GraphController], providers: [GraphService], exports: [GraphService] })
export class GraphModule {}
