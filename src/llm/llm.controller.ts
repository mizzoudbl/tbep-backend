import { Body, Controller, Post, HttpException, HttpStatus, Res, UseGuards } from '@nestjs/common';
import { LlmService } from './llm.service';
import { PromptDto, DEFAULT_MODEL } from '@/llm/model.constants';
import type { Response } from 'express';
import { observe, updateActiveTrace } from '@langfuse/tracing';
import { ThrottlerBehindProxyGuard } from './llm-throttle.guard';

@Controller('llm')
export class LlmController {
  constructor(private readonly llmService: LlmService) {}

  @Post('chat')
  @UseGuards(ThrottlerBehindProxyGuard)
  async streamResponse(@Body() promptDto: PromptDto, @Res() res: Response) {
    // Wrap the handler with observe() to create a trace for this request
    return observe(
      async () => {
        try {
          // Update trace with metadata, userId, and sessionId for Langfuse tracking
          updateActiveTrace({
            name: 'llm-chat-request',
            userId: promptDto.userId,
            sessionId: promptDto.sessionId,
            metadata: {
              model: promptDto.model || DEFAULT_MODEL,
              messageCount: promptDto.messages?.length || 0,
            },
          });

          // Generate the AI response stream using AI SDK
          const result = this.llmService.generateResponseStream(promptDto);

          // Return the AI SDK stream response directly
          return result.pipeUIMessageStreamToResponse(res);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to generate response stream';
          throw new HttpException(errorMessage, HttpStatus.INTERNAL_SERVER_ERROR);
        }
      },
      {
        name: 'handle-llm-chat',
        captureInput: true,
        captureOutput: false, // Stream responses don't capture full output
        endOnExit: false, // Don't end the observation until the stream completes
      },
    )();
  }

  @Post('kg-chat')
  @UseGuards(ThrottlerBehindProxyGuard)
  async streamKGChat(@Body() promptDto: PromptDto, @Res() res: Response) {
    // Wrap the handler with observe() to create a trace for this request
    return observe(
      async () => {
        try {
          // Update trace with metadata for Langfuse tracking
          updateActiveTrace({
            name: 'kg-chat-request',
            userId: promptDto.userId,
            sessionId: promptDto.sessionId,
            metadata: {
              model: promptDto.model || DEFAULT_MODEL,
              messageCount: promptDto.messages?.length || 0,
            },
          });

          // Generate the AI response stream with tool calling support
          const result = this.llmService.generateKGChatStream(promptDto);

          // Return the AI SDK stream response directly
          // Client-side will intercept tool calls via onToolCall callback
          return result.pipeUIMessageStreamToResponse(res);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to generate KG chat stream';
          throw new HttpException(errorMessage, HttpStatus.INTERNAL_SERVER_ERROR);
        }
      },
      {
        name: 'handle-kg-chat',
        captureInput: true,
        captureOutput: false, // Stream responses don't capture full output
        endOnExit: false, // Don't end the observation until the stream completes
      },
    )();
  }
}
