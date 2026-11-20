import { Module } from '@nestjs/common';
import { BuildingsModule } from '../buildings/buildings.module';
import { OperationsController, PublicOperationsController } from './operations.controller';
import { OperationsService } from './operations.service';

@Module({ imports: [BuildingsModule], controllers: [OperationsController, PublicOperationsController], providers: [OperationsService] })
export class OperationsModule {}
