import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from './common/public.decorator';
@ApiTags('System')
@Controller('health')
export class HealthController { @Public() @Get() check() { return { status: 'ok' }; } }
