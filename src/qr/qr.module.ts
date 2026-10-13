import { Module } from '@nestjs/common'; import { BuildingsModule } from '../buildings/buildings.module'; import { QrController } from './qr.controller'; import { QrService } from './qr.service';
@Module({ imports: [BuildingsModule], controllers: [QrController], providers: [QrService] }) export class QrModule {}
