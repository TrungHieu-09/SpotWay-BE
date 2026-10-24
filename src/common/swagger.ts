import { applyDecorators, Type } from '@nestjs/common';
import { ApiBadRequestResponse, ApiExtraModels, ApiForbiddenResponse, ApiProperty, ApiResponse, ApiUnauthorizedResponse, getSchemaPath } from '@nestjs/swagger';

export class ApiErrorDetail {
  @ApiProperty({ example: 'INVALID_CREDENTIALS' }) code!: string;
  @ApiProperty({ example: 'Invalid email or password' }) message!: string | string[];
}

export class ApiErrorEnvelope {
  @ApiProperty({ example: false }) success!: false;
  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true, example: null }) data!: null;
  @ApiProperty({ type: () => ApiErrorDetail }) error!: ApiErrorDetail;
}

export class ApiSuccessEnvelope {
  @ApiProperty({ example: true }) success!: true;
  @ApiProperty({ type: 'object', additionalProperties: true }) data!: object;
  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true, example: null }) error!: null;
}

export class PaginationMeta {
  @ApiProperty({ example: 1, minimum: 1 }) page!: number;
  @ApiProperty({ example: 20, minimum: 1, maximum: 100 }) limit!: number;
  @ApiProperty({ example: 1, minimum: 0 }) total!: number;
}

export class AuthTokens {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' }) accessToken!: string;
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' }) refreshToken!: string;
  @ApiProperty({ example: 'Bearer' }) tokenType!: string;
}

export function ApiStandardErrors() {
  return applyDecorators(
    ApiExtraModels(ApiErrorEnvelope, ApiErrorDetail),
    ApiBadRequestResponse({ description: 'Validation or request error', type: ApiErrorEnvelope }),
    ApiUnauthorizedResponse({ description: 'Missing, invalid, or expired access token', type: ApiErrorEnvelope }),
    ApiForbiddenResponse({ description: 'Role, ownership, or tenant access denied', type: ApiErrorEnvelope }),
  );
}

export function ApiEnvelopeResponse(status: number, description: string, dataSchema: Record<string, unknown> = { type: 'object' }) {
  return applyDecorators(
    ApiExtraModels(ApiSuccessEnvelope),
    ApiResponse({ status, description, schema: { allOf: [{ $ref: getSchemaPath(ApiSuccessEnvelope) }, { properties: { data: dataSchema } }] } }),
  );
}

export function ApiPagedEnvelopeResponse(model: Type<unknown>, description = 'Paginated result') {
  return applyDecorators(
    ApiExtraModels(ApiSuccessEnvelope, PaginationMeta, model),
    ApiResponse({
      status: 200,
      description,
      schema: {
        allOf: [
          { $ref: getSchemaPath(ApiSuccessEnvelope) },
          {
            properties: {
              data: {
                type: 'object',
                properties: {
                  items: { type: 'array', items: { $ref: getSchemaPath(model) } },
                  pagination: { $ref: getSchemaPath(PaginationMeta) },
                },
              },
            },
          },
        ],
      },
    }),
  );
}

export function ApiAuthTokenResponse(status: number, description: string) {
  return applyDecorators(ApiExtraModels(AuthTokens), ApiEnvelopeResponse(status, description, { $ref: getSchemaPath(AuthTokens) }));
}
