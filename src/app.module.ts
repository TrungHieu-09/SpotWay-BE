import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { BuildingsModule } from './buildings/buildings.module';
import { DatabaseModule } from './database/database.module';
import { FloorsModule } from './floors/floors.module';
import { GraphModule } from './graph/graph.module';
import { HealthController } from './health.controller';
import { NavigationModule } from './navigation/navigation.module';
import { StoresModule } from './stores/stores.module';
import { PromotionsModule } from './promotions/promotions.module';
import { QrModule } from './qr/qr.module';
import { TenantsModule } from './tenants/tenants.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule, AnalyticsModule, AuthModule, TenantsModule, BuildingsModule, FloorsModule, StoresModule, PromotionsModule, GraphModule, QrModule, NavigationModule],
  controllers: [HealthController],
})
export class AppModule {}
