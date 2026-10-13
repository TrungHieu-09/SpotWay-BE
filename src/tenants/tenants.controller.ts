import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common'; import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'; import { UserRole } from '@prisma/client'; import { Roles } from '../common/roles.decorator'; import { ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger'; import { CreateTenantDto, UpdateTenantDto } from './tenants.dto'; import { TenantsService } from './tenants.service';
@ApiTags('Tenants') @ApiBearerAuth('bearerAuth') @Controller('tenants') @Roles(UserRole.ADMIN)
export class TenantsController { constructor(private readonly tenants: TenantsService) {}
  @Get() @ApiOperation({ summary: 'List active tenants' }) @ApiEnvelopeResponse(200, 'Tenants returned successfully') @ApiStandardErrors() list() { return this.tenants.list(); }
  @Post() @ApiOperation({ summary: 'Create a tenant and its Building Owner account' }) @ApiEnvelopeResponse(201, 'Tenant created successfully') @ApiStandardErrors() create(@Body() dto: CreateTenantDto) { return this.tenants.create(dto); }
  @Patch(':id') @ApiOperation({ summary: 'Update tenant package or status' }) @ApiEnvelopeResponse(200, 'Tenant updated successfully') @ApiStandardErrors() update(@Param('id') id: string, @Body() dto: UpdateTenantDto) { return this.tenants.update(id, dto); }
}
