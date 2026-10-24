import { Module } from '@nestjs/common';
import { TenantAccessService } from '../common/tenant-access.service';
import { BuildingsController } from './buildings.controller';
import { BuildingsService } from './buildings.service';
@Module({ controllers: [BuildingsController], providers: [BuildingsService, TenantAccessService], exports: [TenantAccessService] }) export class BuildingsModule {}
