import {
  Body,
  Controller,
  Post,
  Sse,
  Query,
  MessageEvent,
  HttpException,
  HttpStatus,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { LlmService } from './llm.service';
import { Model, PromptDto } from './prompt.dto';
import { Observable } from 'rxjs';

@Controller('llm')
export class LlmController {
  #promptStore = new Map<string, PromptDto>();

  constructor(private readonly llmService: LlmService) {}

  @Post('chat')
  @UsePipes(new ValidationPipe({ transform: true }))
  async initChatStream(@Body() promptDto: PromptDto) {
    // Check if the model is available before storing the prompt
    const model = promptDto.model || Model.LLAMA_3;
    if (model && !this.llmService.isModelAvailable(model)) {
      throw new HttpException(`Model ${model} is currently not configured for use.`, HttpStatus.BAD_REQUEST);
    }
    const streamID = Date.now().toString();
    this.#promptStore.set(streamID, promptDto);
    return { streamID };
  }

  @Sse('stream')
  async streamResponse(@Query('sid') streamID: string): Promise<Observable<MessageEvent>> {
    return new Observable<MessageEvent>((subscriber) => {
      (async () => {
        try {
          const promptDto = this.#promptStore.get(streamID);
          if (!promptDto) {
            subscriber.error('Invalid stream ID');
            return;
          }
          this.#promptStore.delete(streamID);
          const stream = await this.llmService.generateResponseStream(promptDto);
          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content;
            if (content) {
              subscriber.next({ type: 'message', data: content });
            }
          }
          subscriber.complete();
        } catch (error) {
          subscriber.next({ type: 'error', data: `Error: ${error.message}` });
          subscriber.complete();
        }
      })();
    });
  }
}
