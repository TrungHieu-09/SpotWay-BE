import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from './common/public.decorator';
import { ApiEnvelopeResponse } from './common/swagger';
@ApiTags('System')
@Controller('health')
export class HealthController { @Public() @Get() @ApiOperation({ summary: 'Check API service health' }) @ApiEnvelopeResponse(200, 'Service is healthy', { type: 'object', properties: { status: { type: 'string', example: 'ok' } } }) check() { return { status: 'ok' }; } }
