import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { openai } from '@ai-sdk/openai';
import { convertToModelMessages, createProviderRegistry, ModelMessage, streamText, UIMessage } from 'ai';
import { Model, PromptDto } from './prompt.dto';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { updateActiveObservation, updateActiveTrace } from '@langfuse/tracing';
import { trace } from '@opentelemetry/api';

@Injectable()
export class LlmService {
  private modelRegistry: ReturnType<typeof createProviderRegistry>;

  constructor(private configService: ConfigService) {
    this.modelRegistry = createProviderRegistry({
      openai,
      nvidia: createOpenAICompatible({
        name: 'nvidia',
        apiKey: this.configService.get<string>('NVIDIA_API_KEY'),
        baseURL: 'https://integrate.api.nvidia.com/v1',
      }),
    });
  }

  isModelAvailable(model: Model): boolean {
    switch (model) {
      case Model.GPT_4O:
        return this.configService.get<string>('OPENAI_API_KEY') !== undefined;
      case Model.LLAMA_3:
        return this.configService.get<string>('NVIDIA_API_KEY') !== undefined;
      default:
        return false;
    }
  }

  //   private readonly SYSTEM_PROMPT = `Answer the following biomedical question in a very specific manner:
  // 	1. Content Requirements:
  // 	- Provide only the names of the genes, pathways, or gene-protein interactions when the question specifically asks for them.
  // 	- Do not include any extra explanations or additional information unless explicitly requested in the query.
  // 	- Highlight only the main keywords, genes, pathways, or their interactions when asked.
  // 	2. Citation and Web Scraping Requirements:
  // 	- Scrape the internet for accurate and precise answers along with their corresponding citations. Ensure live web scraping is used for improved accuracy and precision.
  // 	- If no citations are found, respond with exactly:
  //   Not able to scrape citations for this question.
  //   Do not fabricate or hallucinate any citations or dummy links.
  // 	3. Citation Format (for each citation):
  // The output for each citation must be in the following exact format:

  // Title of the paper
  // Authors
  // Journal
  // [Link](https://www.google.com/search?q={URL_ENCODED_TITLE_OF_THE_PAPER}&btnI=I%27m%20Feeling%20Lucky)

  // 	- Title of the paper: Provide the title exactly as it appears.
  // 	- Authors: List the authors of the paper.
  // 	- Journal: List the journal where the paper was published.
  // 	- Modified Link: The link should be in Markdown format. Instead of using direct URLs, construct the link using the paper title. Ensure that {URL_ENCODED_TITLE_OF_THE_PAPER} is the URL-encoded version of the paper's title.

  // 	4. Additional Notes:
  // 	- Do not include any PMIDs, DOIs, or extra identifiers in the citation.
  // 	- Strictly adhere to this format for all citations to support your answer.
  // 	- Ensure that the answer is as precise and accurate as possible by using the latest available data from live web scraping.

  // Please strictly follow these guidelines in your responses.`;

  private readonly SYSTEM_PROMPT = `Answer the following biomedical question in a very specific manner:
	1. Content Requirements:
	- Provide only the names of the genes, pathways, or gene-protein interactions when the question specifically asks for them.
	- Include small explanations only unless explicitly requested in the query.
	- Highlight only the main keywords, genes, pathways, or their interactions when asked.
	
Please strictly follow these guidelines in your responses.`;

  generateResponseStream(promptDto: PromptDto) {
    const model = promptDto.model || Model.LLAMA_3;

    if (!this.isModelAvailable(model)) {
      throw new Error(`Model ${model} is not available. Please configure the appropriate API key.`);
    }

    // Convert messages to AI SDK format
    const messages: ModelMessage[] = [
      { role: 'system', content: this.SYSTEM_PROMPT },
      ...convertToModelMessages((promptDto.messages as UIMessage[]) ?? []),
    ];

    // Extract the last user message for tracing input
    const inputText = messages.at(-1);

    // Update the active observation with input for tracing
    updateActiveObservation({ input: inputText?.content });

    return streamText({
      model: this.modelRegistry.languageModel(model),
      messages,
      temperature: 0,
      topP: 0.7,
      maxOutputTokens: 1024,
      // Enable Vercel AI SDK telemetry for automatic tracing
      experimental_telemetry: {
        isEnabled: true,
        functionId: 'llm-generate-response',
      },
      onFinish: async (result) => {
        // Update observation and trace with the output after stream completes
        updateActiveObservation({ output: result.text });
        updateActiveTrace({ output: result.text });

        // Manually end the span after the stream has finished
        trace.getActiveSpan()?.end();
      },
    });
  }
}
