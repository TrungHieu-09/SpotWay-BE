import { Module } from '@nestjs/common';
import { BuildingsModule } from '../buildings/buildings.module';
import { IncidentsController, PublicIncidentController } from './incidents.controller';
import { IncidentsService } from './incidents.service';

@Module({ imports: [BuildingsModule], controllers: [IncidentsController, PublicIncidentController], providers: [IncidentsService] })
export class IncidentsModule {}
