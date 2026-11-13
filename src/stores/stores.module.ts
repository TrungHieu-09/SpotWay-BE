import { Module } from '@nestjs/common';
import { BuildingsModule } from '../buildings/buildings.module';
import { FloorStoresController, StoresController } from './stores.controller';
import { StoresService } from './stores.service';
@Module({ imports: [BuildingsModule], controllers: [StoresController, FloorStoresController], providers: [StoresService] }) export class StoresModule {}
