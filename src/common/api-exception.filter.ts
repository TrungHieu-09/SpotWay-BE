import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = exception instanceof HttpException ? exception.getResponse() : { message: 'Internal server error' };
    const message = typeof body === 'string' ? body : (body as { message?: string | string[] }).message ?? 'Request failed';
    const code = typeof body === 'object' && body && 'code' in body ? String((body as { code: string }).code) : HttpStatus[status];
    response.status(status).json({ success: false, data: null, error: { code, message } });
  }
}
