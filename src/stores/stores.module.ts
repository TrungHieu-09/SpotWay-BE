import { Module } from '@nestjs/common';
import { BuildingsModule } from '../buildings/buildings.module';
import { StorageService } from '../floors/storage.service';
import { FloorStoresController, StoresController } from './stores.controller';
import { StoresService } from './stores.service';
@Module({ imports: [BuildingsModule], controllers: [StoresController, FloorStoresController], providers: [StoresService, StorageService] }) export class StoresModule {}
