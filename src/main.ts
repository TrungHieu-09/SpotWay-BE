import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { ResponseInterceptor } from './common/response.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  const corsOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  app.enableCors({ origin: corsOrigins.length ? corsOrigins : true, credentials: true });
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new ApiExceptionFilter());
  const config = new DocumentBuilder()
    .setTitle('SpotWay API')
    .setDescription('API documentation for SpotWay Backend')
    .setVersion('1.0.0')
    .addServer('http://localhost:3000', 'Development')
    .addServer(process.env.API_PRODUCTION_URL ?? 'https://api.example.com', 'Production')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearerAuth')
    .addTag('System', 'System health and service status')
    .addTag('Authentication', 'Registration, JWT sessions, and Google OAuth')
    .addTag('Buildings', 'Building and manager assignment APIs')
    .addTag('Floors', 'Floor management and publishing APIs')
    .addTag('Stores', 'Tenant-scoped store management APIs')
    .addTag('Map Editor', 'Tenant-scoped Node, Edge, POI, and elevator-link APIs')
    .addTag('Public Navigation', 'Published maps, destination search, and Guest route calculation')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  document.openapi = '3.0.3';
  SwaggerModule.setup('api/docs', app, document);
  await app.listen(Number(process.env.PORT ?? 3000));
}
bootstrap();
