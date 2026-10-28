import { Module } from '@nestjs/common';
import { GraphModule } from '../graph/graph.module';
import { NavigationController } from './navigation.controller';
import { NavigationService } from './navigation.service';
@Module({ imports: [GraphModule], controllers: [NavigationController], providers: [NavigationService] }) export class NavigationModule {}
