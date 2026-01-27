import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  convertToModelMessages,
  createProviderRegistry,
  ModelMessage,
  ProviderRegistryProvider,
  streamText,
  UIMessage,
  tool,
  stepCountIs,
} from 'ai';
import { z } from 'zod';
import { PromptDto, DEFAULT_MODEL } from '@/llm/model.constants';
import { createOpenAICompatible, OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';
import { tavily } from '@tavily/core';

@Injectable()
export class LlmService {
  private modelRegistry: ProviderRegistryProvider<{ nvidia: OpenAICompatibleProvider }, ':'>;

  private tavilyClient: ReturnType<typeof tavily> | null = null;

  constructor(private configService: ConfigService) {
    if (!this.configService.get<string>('NVIDIA_API_KEY')) {
      throw new Error('NVIDIA_API_KEY is not configured in environment variables');
    }

    // Initialize Tavily for web search (optional)
    const tavilyApiKey = this.configService.get<string>('TAVILY_API_KEY');
    if (tavilyApiKey) {
      this.tavilyClient = tavily({ apiKey: tavilyApiKey });
    }

    this.modelRegistry = createProviderRegistry({
      nvidia: createOpenAICompatible({
        name: 'nvidia',
        apiKey: this.configService.get<string>('NVIDIA_API_KEY'),
        baseURL: 'https://integrate.api.nvidia.com/v1',
      }),
    });
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

  private readonly KG_SYSTEM_PROMPT = `You are an expert Knowledge Graph Analyst for TBEP (Target & Biomarker Exploration Portal).
Your goal is to help users explore, visualize, and understand complex biological networks containing Genes, Diseases, Pathways, and Phenotypes.
Hence, based on the user's questions, and your analysis of the graph, you will have to provide hypotheses, insights, and visual highlights.

CORE CAPABILITIES:
1. **Graph Exploration**: You can search nodes, find paths, and explore neighborhoods.
2. **Visualization Control**: You can manipulate the user's graph view (highlight, color, size, filter).
3. **Analysis**: You can compute centrality, community detection, and enrichment (GSEA).
4. **Literature Search**: You can access PubMed/Web via \`searchBiomedicalContext\` for evidence.
5. **Omics Data**: You have access to various omics properties (DEG, expression, etc.) for Genes. You can explore these via property-based tools.

CRITICAL OPERATIONAL RULES:
- **Tool-First Approach**: You cannot "see" the canvas directly. You MUST use tools to perceive the graph state.
  - If asked "What is in the graph?", call \`computeNetworkStatistics\` or \`searchNodes\`.
  - If asked "Can you see gene X?", call \`searchNodes\` to verify its existence.
- **Chain Your Tools**: Complex questions require multiple steps.
  - *Example*: "How is BRCA1 linked to Breast Cancer?" -> 1. \`searchNodes\` (verify IDs) -> 2. \`findSimplePaths\` (get connections) -> 3. \`highlightNodes\` (show user).
- **Visualization is Communication**: When you find interesting nodes/paths, ALWAYS highlight them or apply styles so the user sees what you are talking about.
- **External Evidence**: When explaining biological mechanisms, ALWAYS verify with \`searchBiomedicalContext\` and provide citations.

INTERACTION GUIDELINES:
1. **Be Proactive**: If a user selects a node, offer to show its neighbors or compute its centrality.
2. **Handle Empty Results**: If a search fails, try a broader query or fuzzy match. Don't just say "not found".
3. **Data Interpretation**: Do not just dump JSON tool outputs. Synthesize the data into biological insights.
4. **Property Awareness**: Before coloring/sizing by property, ALWAYS check \`listAvailableProperties\` to know what's available (e.g., 'logFC', 'p_value').

REMEMBER: You are driving a powerful visualization dashboard. Your tool calls directly update the user's screen. Make it dynamic and interactive.`;

  generateResponseStream(promptDto: PromptDto) {
    const model = promptDto.model || DEFAULT_MODEL;

    // Convert messages to AI SDK format
    const messages: ModelMessage[] = [
      { role: 'system', content: this.SYSTEM_PROMPT },
      ...convertToModelMessages((promptDto.messages as UIMessage[]) ?? []),
    ];

    // Note: Langfuse tracing handled by experimental_telemetry + controller's observe() wrapper
    return streamText({
      model: this.modelRegistry.languageModel(model),
      messages,
      temperature: 0,
      topP: 0.7,
      maxOutputTokens: 4096,
      // Enable Vercel AI SDK telemetry for automatic tracing
      experimental_telemetry: {
        isEnabled: true,
        functionId: 'llm-generate-response',
      },
      // Note: Telemetry handled automatically by experimental_telemetry
    });
  }

  /**
   * Generate streaming response with tool calling support for Knowledge Graph analysis
   * Backend generates metadata via Tavily search, frontend provides graph data
   */
  generateKGChatStream(promptDto: PromptDto) {
    const modelId = (promptDto.model || DEFAULT_MODEL) as `nvidia:${string}`;

    // Generate tools (backend-side)
    const tools = this.generateKGTools();

    // Build system prompt with graph context
    const systemPrompt = this.KG_SYSTEM_PROMPT;

    // Convert messages to AI SDK format
    const messages: ModelMessage[] = [
      { role: 'system', content: systemPrompt },
      ...convertToModelMessages((promptDto.messages as UIMessage[]) ?? []),
    ];

    // Note: Langfuse tracing handled by experimental_telemetry + controller's observe() wrapper
    return streamText({
      model: this.modelRegistry.languageModel(modelId),
      messages,
      tools,
      // Use stopWhen instead of maxSteps (AI SDK 5.0)
      stopWhen: stepCountIs(5), // Stop at step 10 if tools were called
      temperature: 0.1, // Low temperature for factual, deterministic tool usage
      topP: 0.9,
      maxOutputTokens: 4096,
      // Enable Vercel AI SDK telemetry for automatic tracing
      experimental_telemetry: {
        isEnabled: true,
        functionId: 'kg-chat-tool-calling',
      },
    });
  }

  /**
   * Generate backend tools for KG analysis
   * Backend tool: searchBiomedicalContext (Tavily search)
   * Frontend tools: 27+ tools from kg-tools.ts (metadata only, execution client-side)
   */
  private generateKGTools() {
    const kgTools: Record<string, any> = {};

    // ========================================================================
    // BACKEND TOOL: Tavily Web Search
    // ========================================================================
    if (this.tavilyClient) {
      kgTools.searchBiomedicalContext = tool({
        description:
          'Search for biomedical context, gene functions, disease associations, pathway information, and scientific literature. Use this to gather and cite relevant sources.',
        inputSchema: z.object({
          query: z.string().describe('Search query for biomedical information'),
          includeAnswer: z
            .string()
            .optional()
            .default('true')
            .describe('Include AI-generated answer summary (boolean string)'),
          maxResults: z.string().optional().default('5').describe('Maximum number of results (numeric string 1-10)'),
        }),
        execute: async ({ query, includeAnswer, maxResults }) => {
          const includeAnswerBool =
            typeof includeAnswer === 'string'
              ? ['true', '1', 'yes', 'y'].includes(includeAnswer.toLowerCase())
              : !!includeAnswer;
          const maxResultsNum = typeof maxResults === 'string' ? Number(maxResults) : maxResults;
          try {
            const response = await this.tavilyClient!.search(query, {
              searchDepth: 'advanced',
              topic: 'general',
              includeAnswer: includeAnswerBool,
              maxResults: Number.isFinite(maxResultsNum) ? maxResultsNum : 5,
              includeDomains: [
                'pubmed.ncbi.nlm.nih.gov',
                'www.ncbi.nlm.nih.gov',
                'www.uniprot.org',
                'www.genecards.org',
                'www.ensembl.org',
              ],
            });

            return {
              answer: response.answer || null,
              results: response.results.map((r: any) => ({
                title: r.title,
                url: r.url,
                content: r.content,
                score: r.score,
              })),
              query: response.query,
            };
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : 'Search failed',
              query,
            };
          }
        },
      });
    }

    // ========================================================================
    // FRONTEND TOOLS: Metadata only (execution happens client-side)
    // ========================================================================

    // Graph Query Tools (8 tools)
    kgTools.searchNodes = tool({
      description: 'Search for nodes by label using fuzzy matching. Only returns visible nodes.',
      inputSchema: z.object({
        query: z.string().describe('Search query for node labels'),
        nodeType: z.string().optional().describe('Filter by specific node type'),
        limit: z.string().optional().default('50').describe('Maximum results to return (numeric string)'),
      }),
    });

    kgTools.getNodeProperties = tool({
      description: 'Get all properties for specific nodes. Excludes hidden nodes.',
      inputSchema: z.object({
        nodeIds: z.array(z.string()).describe('Array of node IDs to get properties for'),
      }),
    });

    kgTools.findSimplePaths = tool({
      description:
        'Find simple paths between two nodes using graphology-simple-path. Returns shortest paths first. Excludes paths through hidden nodes.',
      inputSchema: z.object({
        sourceLabelOrId: z.string().describe('Source node label or ID'),
        targetLabelOrId: z.string().describe('Target node label or ID'),
        maxLength: z.string().optional().default('5').describe('Maximum path length (numeric string)'),
        maxPaths: z.string().optional().default('100').describe('Maximum paths to find (numeric string)'),
      }),
    });

    kgTools.getNeighborhood = tool({
      description: 'Get immediate neighbors of node(s). Excludes hidden neighbors.',
      inputSchema: z.object({
        nodeLabelsOrIds: z.array(z.string()).describe('Center node labels or IDs'),
        hops: z.string().optional().default('1').describe('Number of hops (numeric string)'),
      }),
    });

    kgTools.filterSubgraph = tool({
      description: 'Filter graph by node types, edge types, or property conditions. Only returns visible entities.',
      inputSchema: z.object({
        nodeTypes: z.array(z.string()).optional().describe('Filter by node types'),
        edgeTypes: z.array(z.string()).optional().describe('Filter by edge types'),
        propertyConditions: z
          .array(
            z.object({
              property: z.string(),
              operator: z.enum(['=', '>', '<', '>=', '<=']),
              value: z.string().describe('Value (string rep; parse numeric/boolean internally)'),
            }),
          )
          .optional()
          .describe('Property filter conditions'),
      }),
    });

    kgTools.computeCentrality = tool({
      description:
        'Calculate centrality metrics (degree, betweenness, closeness, eigenvector). Only computes for visible nodes.',
      inputSchema: z.object({
        metric: z.enum(['degree', 'betweenness', 'closeness', 'eigenvector']).describe('Centrality metric to compute'),
        nodeIds: z
          .array(z.string())
          .optional()
          .describe('Specific nodes to compute (optional, computes all if omitted)'),
      }),
    });

    kgTools.retrieveRelevantContext = tool({
      description: 'BM25 search + graph expansion for context retrieval. Only returns visible nodes.',
      inputSchema: z.object({
        query: z.string().describe('Query for BM25 search'),
        topK: z.string().optional().default('30').describe('Number of results to retrieve (numeric string)'),
      }),
    });

    kgTools.extractSubgraph = tool({
      description: 'Extract subgraph and format as structured JSON. Excludes hidden entities.',
      inputSchema: z.object({
        nodeIds: z.array(z.string()).describe('Node IDs to extract'),
        includeNeighbors: z.string().optional().default('false').describe('Include 1-hop neighbors (boolean string)'),
      }),
    });

    // Analysis Tools (5 tools)
    kgTools.analyzeCommunities = tool({
      description: 'Detect communities with Louvain algorithm. Only includes visible nodes.',
      inputSchema: z.object({
        resolution: z.string().optional().default('1').describe('Louvain resolution parameter (numeric string)'),
        weighted: z.string().optional().default('false').describe('Use edge weights for clustering (boolean string)'),
        minCommunitySize: z
          .string()
          .optional()
          .default('3')
          .describe('Minimum community size to display (numeric string)'),
      }),
    });

    kgTools.applyDWPC = tool({
      description: 'Degree-Weighted Path Count (DWPC) between two nodes. Excludes paths through hidden nodes.',
      inputSchema: z.object({
        sourceLabelOrId: z.string().describe('Source node'),
        targetLabelOrId: z.string().describe('Target node'),
        damping: z.string().optional().default('0.5').describe('Damping factor (numeric string 0-1)'),
        maxHops: z.string().optional().default('5').describe('Maximum hops to search (numeric string)'),
        maxPaths: z.string().optional().default('10000').describe('Maximum paths to find (numeric string)'),
      }),
    });

    kgTools.applyGSEA = tool({
      description: 'Gene Set Enrichment Analysis (GSEA) via Python backend. Only works with Gene nodes.',
      inputSchema: z.object({
        geneNames: z.array(z.string()).describe('Gene names for GSEA'),
      }),
    });

    kgTools.computeNetworkStatistics = tool({
      description: 'Compute overall graph metrics. Only computes for visible nodes/edges.',
      inputSchema: z.object({}),
    });

    kgTools.expandContext = tool({
      description: 'Expand existing subgraph with neighbors or paths. Only adds visible nodes.',
      inputSchema: z.object({
        currentNodeIds: z.array(z.string()).describe('Current node set (ENSEMBL IDs not Gene Symbols)'),
        expansionStrategy: z.enum(['neighbors', 'pathBased']).describe('How to expand'),
        depth: z.string().optional().default('1').describe('Expansion depth (numeric string)'),
      }),
    });

    // Visualization Tools (10 tools)
    kgTools.highlightNodes = tool({
      description: 'Highlight nodes and zoom camera to them.',
      inputSchema: z.object({
        nodeLabelsOrIds: z.array(z.string()).describe('Nodes to highlight'),
        color: z
          .string()
          .optional()
          .describe("Don't use this unless highlight color is specified by the user (hex or css name)"),
      }),
    });

    kgTools.filterByNodeType = tool({
      description: 'Show or hide nodes by type.',
      inputSchema: z.object({
        nodeType: z.string().describe('Node type to filter'),
        visible: z.string().describe('Show or hide this node type (boolean string)'),
      }),
    });

    kgTools.listAvailableProperties = tool({
      description:
        'Search for available properties by query. CRITICAL: Query is REQUIRED - too many properties to list without filtering.',
      inputSchema: z.object({
        query: z.string().describe('Search query for properties (REQUIRED)'),
        nodeType: z.string().optional().describe('Filter by node type'),
        limit: z.string().optional().default('20').describe('Maximum results (numeric string)'),
      }),
    });

    kgTools.applyNodeColorByProperty = tool({
      description:
        'Map node color to property value. CRITICAL: For Gene nodes, use category names (DEG, Pathway, etc.). For other nodes, use individual property names. Call listAvailableProperties first.',
      inputSchema: z.object({
        nodeType: z.string().describe('Node type to apply property to'),
        propertyName: z.string().describe('Property name or category (for Gene nodes)'),
      }),
    });

    kgTools.applyNodeSizeByProperty = tool({
      description:
        'Map node size to property value. CRITICAL: For Gene nodes, use category names (DEG, Pathway, etc.). For other nodes, use individual property names. Call listAvailableProperties first.',
      inputSchema: z.object({
        nodeType: z.string().describe('Node type to apply property to'),
        propertyName: z.string().describe('Property name or category (for Gene nodes)'),
      }),
    });

    kgTools.updateEdgeStyle = tool({
      description: 'Update edge visual styling (color, width, opacity).',
      inputSchema: z.object({
        edgeIds: z.array(z.string()).optional().describe('Specific edge IDs (optional, updates all if omitted)'),
        color: z.string().optional().describe('Edge color'),
        width: z.string().optional().describe('Edge width (numeric string)'),
        opacity: z.string().optional().describe('Edge opacity (numeric string 0-1)'),
      }),
    });

    kgTools.filterByEdgeWeight = tool({
      description: 'Filter edges by minimum weight threshold.',
      inputSchema: z.object({
        edgeWeightCutoff: z.string().describe('Minimum edge weight (numeric string 0-1)'),
      }),
    });

    kgTools.filterByNodeDegree = tool({
      description: 'Filter nodes by minimum degree threshold.',
      inputSchema: z.object({
        minDegree: z.string().describe('Minimum node degree (numeric string)'),
      }),
    });

    // Interaction Tools (4 tools)
    kgTools.clickNode = tool({
      description: 'Select/click a specific node.',
      inputSchema: z.object({
        nodeLabelOrId: z.string().describe('Node to click/select'),
      }),
    });

    kgTools.clickEdge = tool({
      description: 'Select/click a specific edge by source and target.',
      inputSchema: z.object({
        sourceId: z.string().describe('Source node ID'),
        targetId: z.string().describe('Target node ID'),
      }),
    });

    kgTools.selectMultipleNodes = tool({
      description: 'Select multiple nodes at once for showing details.',
      inputSchema: z.object({
        nodeLabelsOrIds: z.array(z.string()).describe('Nodes to select'),
        append: z
          .string()
          .optional()
          .default('false')
          .describe('Append to existing selection or replace (boolean string)'),
      }),
    });

    kgTools.clearSelection = tool({
      description: 'Clear all node/edge selections.',
      inputSchema: z.object({}),
    });

    // Utility Tools (1 tool)
    kgTools.takeScreenshot = tool({
      description:
        'Capture screenshot of current graph visualization for visual analysis. Returns base64-encoded PNG image.',
      inputSchema: z.object({}),
    });

    return kgTools;
  }
}
