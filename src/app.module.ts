import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AccountsModule } from "./accounts/accounts.module";
import { AuthModule } from "./auth/auth.module";
import { ContractsModule } from "./contracts/contracts.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { BuildingsModule } from "./buildings/buildings.module";
import { DatabaseModule } from "./database/database.module";
import { FloorsModule } from "./floors/floors.module";
import { GraphModule } from "./graph/graph.module";
import { IncidentsModule } from "./incidents/incidents.module";
import { OperationsModule } from "./operations/operations.module";
import { HealthController } from "./health.controller";
import { NavigationModule } from "./navigation/navigation.module";
import { StoresModule } from "./stores/stores.module";
import { PromotionsModule } from "./promotions/promotions.module";
import { QrModule } from "./qr/qr.module";
import { TenantsModule } from "./tenants/tenants.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AnalyticsModule,
    AuthModule,
    AccountsModule,
    ContractsModule,
    TenantsModule,
    BuildingsModule,
    FloorsModule,
    StoresModule,
    PromotionsModule,
    GraphModule,
    IncidentsModule,
    OperationsModule,
    QrModule,
    NavigationModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
