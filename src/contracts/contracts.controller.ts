import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { AllowExpiredContract } from '../common/allow-expired-contract.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger';
import { CreateContractDto, RenewalRequestDto, UpdateContractDto } from './contracts.dto';
import { ContractsService } from './contracts.service';

@ApiTags('Contracts') @ApiBearerAuth('bearerAuth') @Controller('admin/contracts') @Roles(UserRole.ADMIN)
export class AdminContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get() @ApiOperation({ summary: 'All service contracts (without the scanned files)' }) @ApiEnvelopeResponse(200, 'Contracts returned') @ApiStandardErrors()
  list() { return this.contracts.adminList(); }

  @Get(':id') @ApiOperation({ summary: 'One contract with its scanned pages' }) @ApiEnvelopeResponse(200, 'Contract returned') @ApiStandardErrors()
  get(@Param('id') id: string) { return this.contracts.adminGet(id); }

  @Post() @ApiOperation({ summary: 'Record a signed contract with a Building Owner and upload its scan' }) @ApiEnvelopeResponse(201, 'Contract created') @ApiStandardErrors()
  create(@Body() dto: CreateContractDto) { return this.contracts.create(dto); }

  @Patch(':id') @ApiOperation({ summary: 'Edit or renew a contract; sending scanPages replaces the stored scan' }) @ApiEnvelopeResponse(200, 'Contract updated') @ApiStandardErrors()
  update(@Param('id') id: string, @Body() dto: UpdateContractDto) { return this.contracts.update(id, dto); }

  @Delete(':id') @ApiOperation({ summary: 'Delete a contract' }) @ApiEnvelopeResponse(200, 'Contract deleted') @ApiStandardErrors()
  remove(@Param('id') id: string) { return this.contracts.remove(id); }
}

@ApiTags('Contracts') @ApiBearerAuth('bearerAuth') @Controller('tenant/contracts') @Roles(UserRole.BUILDING_OWNER) @AllowExpiredContract()
export class TenantContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get() @ApiOperation({ summary: 'Contracts signed with the current Building Owner (without the scanned files)' }) @ApiEnvelopeResponse(200, 'Contracts returned') @ApiStandardErrors()
  list(@CurrentUser() user: AuthUser) { return this.contracts.ownerList(user); }

  @Get(':id') @ApiOperation({ summary: 'One of my contracts with its scanned pages' }) @ApiEnvelopeResponse(200, 'Contract returned') @ApiStandardErrors()
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.contracts.ownerGet(user, id); }

  @Post(':id/renew-request') @HttpCode(200) @ApiOperation({ summary: 'Ask the Admin to renew one of my contracts' }) @ApiEnvelopeResponse(200, 'Renewal requested') @ApiStandardErrors()
  renew(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RenewalRequestDto) { return this.contracts.requestRenewal(user, id, dto.amount, dto.unit, dto.note); }
}
