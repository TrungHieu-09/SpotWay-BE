import { Global, Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { ClientEventsController } from './client-events';
import { AnalyticsService } from './analytics.service';
import { MongoService } from './mongo.service';
import { OutboxWorker } from './outbox.worker';
@Global() @Module({ controllers: [AnalyticsController, ClientEventsController], providers: [MongoService, AnalyticsService, OutboxWorker], exports: [AnalyticsService] }) export class AnalyticsModule {}
