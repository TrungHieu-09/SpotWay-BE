import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { BuildingsModule } from './buildings/buildings.module';
import { DatabaseModule } from './database/database.module';
import { FloorsModule } from './floors/floors.module';
import { GraphModule } from './graph/graph.module';
import { HealthController } from './health.controller';
import { NavigationModule } from './navigation/navigation.module';
import { StoresModule } from './stores/stores.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule, AuthModule, BuildingsModule, FloorsModule, StoresModule, GraphModule, NavigationModule],
  controllers: [HealthController],
})
export class AppModule {}
