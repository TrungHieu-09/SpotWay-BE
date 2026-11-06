import { Module } from '@nestjs/common';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';
import { TenantController } from './tenant.controller';

@Module({
  controllers: [TenantsController, TenantController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
