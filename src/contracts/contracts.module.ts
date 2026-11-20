import { Module } from '@nestjs/common';
import { AdminContractsController, TenantContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';

@Module({
  controllers: [AdminContractsController, TenantContractsController],
  providers: [ContractsService],
})
export class ContractsModule {}
