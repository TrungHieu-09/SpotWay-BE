import { Module } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { AdminController, OwnerStoresController, ProfileController, StoreOwnersController, TenantWorkspaceController } from './accounts.controller';

@Module({
  controllers: [ProfileController, TenantWorkspaceController, StoreOwnersController, OwnerStoresController, AdminController],
  providers: [AccountsService],
  exports: [AccountsService],
})
export class AccountsModule {}
