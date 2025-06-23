import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import * as fs from 'fs';
import { LlmController } from './llm.controller';
import { LlmService } from './llm.service';
import { CitationsService } from './citations.service';
import { NextFunction, Request, Response } from 'express';

@Module({
  controllers: [LlmController],
  providers: [LlmService, CitationsService],
})
export class LlmModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    const logStream = fs.createWriteStream('chat.log', { flags: 'a' });
    consumer
      .apply((req: Request, _res: Response, next: NextFunction) => {
        logStream.write(`[${new Date().toISOString()}] ${req.body.question}\n`);
        next();
      })
      .forRoutes('/llm/chat');
  }
}
