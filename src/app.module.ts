import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { BuildingsModule } from './buildings/buildings.module';
import { DatabaseModule } from './database/database.module';
import { FloorsModule } from './floors/floors.module';
import { HealthController } from './health.controller';
import { StoresModule } from './stores/stores.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule, AuthModule, BuildingsModule, FloorsModule, StoresModule],
  controllers: [HealthController],
})
export class AppModule {}
