import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Request } from 'express';

@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    // Use X-Forwarded-For header if behind a proxy, otherwise use req.ip
    return req.ips?.length ? req.ips[0] : req.ip!;
  }
}
