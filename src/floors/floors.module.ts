import { Module } from '@nestjs/common';
import { BuildingsModule } from '../buildings/buildings.module';
import { FloorsController } from './floors.controller';
@Module({ imports: [BuildingsModule], controllers: [FloorsController] }) export class FloorsModule {}
