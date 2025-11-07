import { Body, Controller, Post, HttpException, HttpStatus, Res, UseGuards } from '@nestjs/common';
import { LlmService } from './llm.service';
import { Model, PromptDto } from './prompt.dto';
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
              model: promptDto.model || Model.LLAMA_3,
              messageCount: promptDto.messages?.length || 0,
            },
          });

          // Check if the model is available
          const model = promptDto.model || Model.LLAMA_3;
          if (model && !this.llmService.isModelAvailable(model)) {
            throw new HttpException(`Model ${model} is currently not configured for use.`, HttpStatus.BAD_REQUEST);
          }

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
}
