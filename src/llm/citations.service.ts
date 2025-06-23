import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { 
  Citation, 
  CitationOptions, 
  ExtractedEntities,
  CitationQueryResult,
  PubMedResponse,
  CitationsConfig
} from './citations.dto';
import {
  GENE_PATTERN,
  PROTEIN_PATTERN,
  DISEASE_PATTERN, 
  PATHWAY_PATTERN,
  COMMON_NON_GENES,
  QUERY_TYPE_INDICATORS,
  DEFAULT_PUBMED_CONFIG,
  DEFAULT_CITATION_EXTRACTION_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  ENTITY_EXTRACTION_PROMPT,
  QUERY_GENERATION_PROMPT
} from './citation-constants';

@Injectable()
export class CitationsService {
  private readonly logger = new Logger(CitationsService.name);
  private readonly config: CitationsConfig;
  private readonly openaiClient: OpenAI | null = null;
  private readonly ncbiApiKey: string | null = null;

  constructor(private readonly configService: ConfigService) {
    // Load configuration
    this.config = {
      pubmed: {
        ...DEFAULT_PUBMED_CONFIG,
        maxRetries: this.configService.get<number>('PUBMED_MAX_RETRIES') || DEFAULT_PUBMED_CONFIG.maxRetries,
        timeoutShort: this.configService.get<number>('PUBMED_TIMEOUT_SHORT') || DEFAULT_PUBMED_CONFIG.timeoutShort,
        timeoutLong: this.configService.get<number>('PUBMED_TIMEOUT_LONG') || DEFAULT_PUBMED_CONFIG.timeoutLong,
        maxCitations: this.configService.get<number>('PUBMED_MAX_CITATIONS') || DEFAULT_PUBMED_CONFIG.maxCitations,
        prioritizeReviews: this.configService.get<boolean>('PUBMED_PRIORITIZE_REVIEWS') ?? DEFAULT_PUBMED_CONFIG.prioritizeReviews,
        maxAgeYears: this.configService.get<number>('PUBMED_MAX_AGE_YEARS') || DEFAULT_PUBMED_CONFIG.maxAgeYears,
      },
      network: {
        ...DEFAULT_NETWORK_CONFIG,
        useProxy: false, // No proxy in production server
        httpProxy: '',
        httpsProxy: '',
        logNetworkRequests: this.configService.get<boolean>('LOG_NETWORK_REQUESTS') ?? DEFAULT_NETWORK_CONFIG.logNetworkRequests,
      },
      citationExtraction: {
        ...DEFAULT_CITATION_EXTRACTION_CONFIG,
        useLlmExtraction: this.configService.get<boolean>('USE_LLM_EXTRACTION') ?? DEFAULT_CITATION_EXTRACTION_CONFIG.useLlmExtraction,
        useLlmQueryGeneration: this.configService.get<boolean>('USE_LLM_QUERY_GENERATION') ?? DEFAULT_CITATION_EXTRACTION_CONFIG.useLlmQueryGeneration,
        entityExtractionModel: this.configService.get<string>('ENTITY_EXTRACTION_MODEL') || DEFAULT_CITATION_EXTRACTION_CONFIG.entityExtractionModel,
        queryGenerationModel: this.configService.get<string>('QUERY_GENERATION_MODEL') || DEFAULT_CITATION_EXTRACTION_CONFIG.queryGenerationModel,
        extractionTemperature: this.configService.get<number>('EXTRACTION_TEMPERATURE') || DEFAULT_CITATION_EXTRACTION_CONFIG.extractionTemperature,
        generationTemperature: this.configService.get<number>('GENERATION_TEMPERATURE') || DEFAULT_CITATION_EXTRACTION_CONFIG.generationTemperature,
        extractionMaxTokens: this.configService.get<number>('EXTRACTION_MAX_TOKENS') || DEFAULT_CITATION_EXTRACTION_CONFIG.extractionMaxTokens,
        generationMaxTokens: this.configService.get<number>('GENERATION_MAX_TOKENS') || DEFAULT_CITATION_EXTRACTION_CONFIG.generationMaxTokens,
      }
    };

    // Initialize OpenAI client if key is available
    const openaiApiKey = configService.get<string>('OPENAI_API_KEY');
    if (openaiApiKey) {
      try {
        this.logger.log('Initializing OpenAI client for citation service');
        this.openaiClient = new OpenAI({
          apiKey: openaiApiKey,
        });
        this.logger.log('OpenAI client initialized successfully');
      } catch (error) {
        this.logger.error(`Failed to initialize OpenAI client: ${error.message}`);
      }
    } else {
      this.logger.warn('OPENAI_API_KEY not set. Enhanced entity extraction disabled.');
    }

    // Get NCBI API Key if available
    this.ncbiApiKey = configService.get<string>('NCBI_API_KEY') || null;
    if (this.ncbiApiKey) {
      this.logger.log('NCBI API Key found in environment.');
    } else {
      this.logger.warn('NCBI_API_KEY not found. Using unauthenticated requests (rate limits apply).');
    }
  }

  /**
   * Main method to fetch citations for a biomedical query
   * 
   * @param query The biomedical question or query
   * @param options Options for citation retrieval
   * @returns Promise resolving to citation query result
   */
  public async fetchCitations(
    query: string, 
    options?: CitationOptions
  ): Promise<CitationQueryResult> {
    const startTime = Date.now();
    
    // Set default options
    const maxCitations = options?.maxCitations || this.config.pubmed.maxCitations;
    const prioritizeReviews = options?.prioritizeReviews ?? this.config.pubmed.prioritizeReviews;
    const maxAgeYears = options?.maxAgeYears ?? this.config.pubmed.maxAgeYears;
    const useLlm = options?.useLlm || false;
    
    this.logger.log(`Searching PubMed for query: '${query}'`);
    
    // Extract entities using appropriate method
    let entities: ExtractedEntities;
    let extractionMethod: 'openai' | 'regex' = 'regex';
    
    if (useLlm && this.openaiClient && this.config.citationExtraction.useLlmExtraction) {
      const llmEntities = await this.extractEntitiesWithLlm(query);
      if (llmEntities) {
        entities = llmEntities;
        extractionMethod = 'openai';
      } else {
        entities = this.extractEntitiesUsingRegex(query);
      }
    } else {
      entities = this.extractEntitiesUsingRegex(query);
    }
    
    // Log extracted entities
    const entitySummary = Object.entries(entities)
      .filter(([, values]) => values.length > 0)
      .map(([key, values]) => `${key}: ${values.length}`)
      .join(', ');
    
    if (entitySummary) {
      this.logger.log(`Extracted entities - ${entitySummary}`);
    } else {
      this.logger.log('No specific entities extracted');
    }
    
    // Optimize query
    let optimizedQuery: string;
    let queryMethod: 'openai' | 'rule' = 'rule';
    
    if (useLlm && this.openaiClient && this.config.citationExtraction.useLlmQueryGeneration) {
      const { query: llmQuery, success } = await this.generateImprovedQueryWithLlm(query, entities);
      if (success && llmQuery) {
        optimizedQuery = llmQuery;
        queryMethod = 'openai';
      } else {
        optimizedQuery = this.generateRuleBasedQuery(query, entities);
      }
    } else {
      optimizedQuery = this.generateRuleBasedQuery(query, entities);
    }
    
    this.logger.log(`Optimized query: ${optimizedQuery}`);
    
    // Add filters for scientific quality if requested
    const queryFilters: string[] = [];
    if (prioritizeReviews) {
      queryFilters.push("Review[Publication Type]");
    }
    
    if (maxAgeYears > 0) {
      const currentYear = new Date().getFullYear();
      const minYear = currentYear - maxAgeYears;
      queryFilters.push(`(${minYear}/01/01[PDAT] : ${currentYear}/12/31[PDAT])`);
    }
    
    // Combine base query and filters
    let finalQuery: string;
    if (queryFilters.length > 0) {
      if (optimizedQuery.includes(' AND ') || optimizedQuery.includes(' OR ') || optimizedQuery.startsWith('(')) {
        finalQuery = `(${optimizedQuery}) AND (${queryFilters.join(' AND ')})`;
      } else {
        finalQuery = `${optimizedQuery} AND (${queryFilters.join(' AND ')})`;
      }
    } else {
      finalQuery = optimizedQuery;
    }
    
    this.logger.log(`Final PubMed query: ${finalQuery}`);
    
    // Fetch citations
    let citations: Citation[] = [];
    try {
      citations = await this.jsonFallbackSearch(finalQuery, maxCitations * 2);
      
      if (!citations.length) {
        this.logger.warn('Primary search method yielded no results, trying XML search...');
        citations = await this.xmlSearch(finalQuery, maxCitations * 2);
      }
    } catch (error) {
      this.logger.error(`Error during PubMed fetching: ${error.message}`);
    }
    
    // Sort and limit citations
    if (citations.length > 0) {
      this.rankCitations(citations);
      citations = citations.slice(0, maxCitations);
    }
    
    // Extract genes from titles
    const genesInTitles = this.extractGenesFromTitles(citations);
    if (genesInTitles.length > 0) {
      this.logger.log(`Potential genes identified in top citations: ${genesInTitles.join(', ')}`);
    }
    
    const elapsedTime = Date.now() - startTime;
    this.logger.log(`PubMed search completed in ${(elapsedTime / 1000).toFixed(2)} seconds.`);
    
    // Return full result object
    return {
      query,
      extractedEntities: entities,
      optimizedQuery: finalQuery,
      citations,
      genesInTitles,
      extractionMethod,
      queryMethod
    };
  }

  /**
   * Rank citations by relevance
   * 
   * @param citations Citations to rank (modified in place)
   */
  private rankCitations(citations: Citation[]): void {
    for (const citation of citations) {
      let score = 0;
      
      // Reviews get higher scores
      if (citation.isReview) {
        score += 10;
      }
      
      // Recency score (exponential decay)
      try {
        if (citation.year) {
          const year = parseInt(citation.year);
          const currentYear = new Date().getFullYear();
          const yearsOld = Math.max(0, currentYear - year);
          const recencyScore = 5 * Math.pow(0.85, yearsOld);
          score += recencyScore;
        }
      } catch (error) {
        // Ignore parsing errors
      }
      
      // Set the score
      citation.relevanceScore = score;
    }
    
    // Sort by relevance score (descending)
    citations.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
  }

  /**
   * Format citations as markdown for output
   * 
   * @param citations Citations to format
   * @returns Markdown formatted text
   */
  public generateCitationMarkdown(citations: Citation[]): string {
    if (!citations || citations.length === 0) {
      return "No citations found.";
    }
    
    let markdown = "";
    
    for (const citation of citations) {
      markdown += `${citation.title}  \n`;
      markdown += `${citation.authors}  \n`;
      markdown += `${citation.journal}\n`;
      
      if (citation.url) {
        const urlEncodedTitle = encodeURIComponent(citation.title);
        markdown += `[Link](https://www.google.com/search?q=${urlEncodedTitle}&btnI=I%27m%20Feeling%20Lucky)\n\n`;
      }
    }
    
    return markdown;
  }

  /**
   * Extract entities from text using regex patterns
   * 
   * @param text Input text to analyze
   * @returns Dictionary of entity types and their values
   */
  public extractEntitiesUsingRegex(text: string): ExtractedEntities {
    const entities: ExtractedEntities = {
      genes: [],
      proteins: [],
      diseases: [],
      pathways: [],
      keywords: []
    };

    const textLower = text.toLowerCase();

    // Extract genes (e.g., BRCA1, TP53)
    const genesMatches = Array.from(text.matchAll(GENE_PATTERN));
    const genes = new Set(
      genesMatches
        .map(match => match[0])
        .filter(gene => 
          !COMMON_NON_GENES.has(gene.toUpperCase()) && 
          gene.length >= 3 && 
          !/^\d+$/.test(gene)
        )
    );
    entities.genes = Array.from(genes);

    // Extract proteins
    const proteinMatches = Array.from(text.matchAll(PROTEIN_PATTERN));
    const proteins = new Set(proteinMatches.map(match => match[0]));
    entities.proteins = Array.from(proteins);

    // Extract diseases
    const diseaseMatches = Array.from(text.matchAll(DISEASE_PATTERN));
    const diseases = new Set(diseaseMatches.map(match => match[0]));
    entities.diseases = Array.from(diseases);

    // Extract pathways
    const pathwayMatches = Array.from(text.matchAll(PATHWAY_PATTERN));
    const pathways = new Set(pathwayMatches.map(match => match[0]));
    entities.pathways = Array.from(pathways);

    // Extract general keywords if specific entities are scarce
    if (!entities.genes.length && !entities.diseases.length && 
        !entities.proteins.length && !entities.pathways.length) {
      const keywords = new Set<string>();
      for (const [typeKey, indicators] of Object.entries(QUERY_TYPE_INDICATORS)) {
        if (indicators.some(indicator => textLower.includes(indicator))) {
          indicators.forEach(indicator => keywords.add(indicator));
        }
      }
      entities.keywords = Array.from(keywords);
    }

    return entities;
  }

  /**
   * Extract entities using OpenAI LLM
   * 
   * @param text Input text to analyze
   * @returns Extracted entities or null if LLM not available
   */
  public async extractEntitiesWithLlm(text: string): Promise<ExtractedEntities | null> {
    if (!this.openaiClient) {
      this.logger.warn('OpenAI client not available. Cannot extract entities with LLM.');
      return null;
    }

    try {
      this.logger.log('Extracting entities using OpenAI API');

      const response = await this.openaiClient.chat.completions.create({
        model: this.config.citationExtraction.entityExtractionModel,
        messages: [
          { role: 'system', content: ENTITY_EXTRACTION_PROMPT },
          { role: 'user', content: `Extract biomedical entities from this text: ${text}` }
        ],
        response_format: { type: 'json_object' },
        temperature: this.config.citationExtraction.extractionTemperature,
        max_tokens: this.config.citationExtraction.extractionMaxTokens
      });

      // Parse the JSON response
      const content = response.choices[0].message.content;
      const result = JSON.parse(content) as ExtractedEntities;

      // Ensure all expected keys exist
      const expectedKeys: (keyof ExtractedEntities)[] = ['genes', 'proteins', 'diseases', 'pathways', 'keywords'];
      for (const key of expectedKeys) {
        if (!result[key]) {
          result[key] = [];
        }
      }

      // Log extraction results
      const totalEntities = Object.values(result).reduce((sum, arr) => sum + arr.length, 0);
      const summary = Object.entries(result)
        .filter(([, values]) => values.length > 0)
        .map(([key, values]) => `${key}:${values.length}`)
        .join(', ');

      this.logger.log(`Extracted ${totalEntities} entities using LLM: ${summary}`);
      return result;

    } catch (error) {
      this.logger.error(`Error using OpenAI for entity extraction: ${error.message}`);
      this.logger.log('Falling back to regex-based entity extraction');
      return null;
    }
  }

  /**
   * Generate an optimized PubMed query with OpenAI LLM
   */
  public async generateImprovedQueryWithLlm(
    question: string, 
    entities: ExtractedEntities
  ): Promise<{ query: string | null, success: boolean }> {
    if (!this.openaiClient) {
      return { query: null, success: false };
    }

    try {
      // Convert entities to a readable format for the prompt
      let entitiesStr = '';
      for (const [category, items] of Object.entries(entities)) {
        if (items.length > 0) {
          entitiesStr += `${category.toUpperCase()}: ${items.join(', ')}\n`;
        }
      }

      const userPrompt = `
      Generate an optimized PubMed search query for this question:
      
      QUESTION: ${question}
      
      EXTRACTED ENTITIES:
      ${entitiesStr}
      
      Return just the search query string using proper PubMed syntax.
      `;

      // Generate the query
      const response = await this.openaiClient.chat.completions.create({
        model: this.config.citationExtraction.queryGenerationModel,
        messages: [
          { role: 'system', content: QUERY_GENERATION_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        temperature: this.config.citationExtraction.generationTemperature,
        max_tokens: this.config.citationExtraction.generationMaxTokens
      });

      // Get the optimized query and clean it up
      let optimizedQuery = response.choices[0].message.content.trim();
      
      // Remove any surrounding quotes
      optimizedQuery = optimizedQuery.replace(/^["'](.*)['""]$/, '$1');
      
      // Remove Markdown code block formatting if present
      optimizedQuery = optimizedQuery.replace(/^```.*\n([\s\S]*)\n```$/, '$1').trim();

      this.logger.log(`Generated LLM-optimized PubMed query: ${optimizedQuery}`);
      return { query: optimizedQuery, success: true };

    } catch (error) {
      this.logger.error(`Error generating query with LLM: ${error.message}`);
      return { query: null, success: false };
    }
  }

  /**
   * Generate an optimized query using rule-based methods
   */
  public generateRuleBasedQuery(query: string, entities: ExtractedEntities): string {
    this.logger.log('Using rule-based query optimization');

    // --- Core Topic Extraction ---
    const diseaseTerms = entities.diseases || [];
    const geneTerms = entities.genes || [];
    const proteinTerms = entities.proteins || [];
    const pathwayTerms = entities.pathways || [];
    const keywordTerms = entities.keywords || [];

    // --- Intent Keywords Extraction ---
    const queryLower = query.toLowerCase();
    const isGeneFocused = QUERY_TYPE_INDICATORS.gene.some(kw => queryLower.includes(kw));
    const isPathwayFocused = QUERY_TYPE_INDICATORS.pathway.some(kw => queryLower.includes(kw));
    const isProteinFocused = QUERY_TYPE_INDICATORS.protein.some(kw => queryLower.includes(kw));
    const isDiseaseFocused = QUERY_TYPE_INDICATORS.disease.some(kw => queryLower.includes(kw)) || diseaseTerms.length > 0;

    // --- Build Structured Query ---
    const queryParts: string[] = [];
    let topicAdded = false;

    // 1. Add Disease Context (Primary Focus if present)
    if (diseaseTerms.length > 0) {
      const meshDisease = diseaseTerms.map(d => `"${d}"[MeSH Terms]`);
      const tiabDisease = diseaseTerms.map(d => `"${d}"[Title/Abstract]`);
      queryParts.push(`(${[...meshDisease, ...tiabDisease].join(' OR ')})`);
      topicAdded = true;
    }

    // 2. Add specific focus (Genes, Pathways, etc.)
    if (isGeneFocused) {
      const geneticMesh = [
        "Genes, Medical[MeSH Terms]",
        "Genetic Predisposition to Disease[MeSH Terms]",
        "Mutation[MeSH Terms]"
      ];
      const geneticTiab = [
        "gene", "genetic*", "mutation*", "variant*", "allele*", "polymorphism*"
      ];
      const geneticTiabPhrased = geneticTiab.map(kw => `"${kw}"[Title/Abstract]`);
      queryParts.push(`(${[...geneticMesh, ...geneticTiabPhrased].join(' OR ')})`);

      if (geneTerms.length > 0) {
        const geneNames = geneTerms.map(g => `"${g}"[Gene/Protein Name]`);
        queryParts.push(`(${geneNames.join(' OR ')})`);
      }
      topicAdded = true;
    } else if (isPathwayFocused && !topicAdded) {
      const pathwayMesh = [
        "Signal Transduction[MeSH Terms]",
        "Metabolic Pathways[MeSH Terms]"
      ];
      const pathwayTiab = [
        "pathway", "signaling", "signalling", "cascade", "metabolic process"
      ];
      const pathwayTiabPhrased = pathwayTiab.map(kw => `"${kw}"[Title/Abstract]`);
      queryParts.push(`(${[...pathwayMesh, ...pathwayTiabPhrased].join(' OR ')})`);

      if (pathwayTerms.length > 0) {
        const pathNames = pathwayTerms.map(p => `"${p}"[Title/Abstract]`);
        queryParts.push(`(${pathNames.join(' OR ')})`);
      }
      topicAdded = true;
    } else if (isProteinFocused && !topicAdded) {
      const proteinMesh = ["Proteins[MeSH Terms]"];
      const proteinTiab = [
        "protein", "receptor", "enzyme", "kinase", "antibody"
      ];
      const proteinTiabPhrased = proteinTiab.map(kw => `"${kw}"[Title/Abstract]`);
      queryParts.push(`(${[...proteinMesh, ...proteinTiabPhrased].join(' OR ')})`);

      if (proteinTerms.length > 0) {
        const protNames = proteinTerms.map(p => `"${p}"[Title/Abstract]`);
        queryParts.push(`(${protNames.join(' OR ')})`);
      }
      topicAdded = true;
    }

    // 3. Add remaining specific entities if not covered by focus
    if (pathwayTerms.length > 0 && !isPathwayFocused && topicAdded) {
      const pathNames = pathwayTerms.map(p => `"${p}"[Title/Abstract]`);
      queryParts.push(`(${pathNames.join(' OR ')})`);
    }
    if (proteinTerms.length > 0 && !isProteinFocused && topicAdded) {
      const protNames = proteinTerms.map(p => `"${p}"[Title/Abstract]`);
      queryParts.push(`(${protNames.join(' OR ')})`);
    }
    if (geneTerms.length > 0 && !isGeneFocused && topicAdded) {
      const geneNames = geneTerms.map(g => `"${g}"[Gene/Protein Name]`);
      queryParts.push(`(${geneNames.join(' OR ')})`);
    }

    // --- Combine Query Parts ---
    if (queryParts.length > 0) {
      // Combine parts with AND
      return queryParts.join(' AND ');
    } else {
      // Fallback if no specific parts identified: quote the original query
      this.logger.warn(`Could not build structured query for: '${query}'. Using original quoted query.`);
      
      // Quote only if it contains spaces and isn't already quoted
      if (query.includes(' ') && !query.startsWith('"') && !query.endsWith('"')) {
        return `"${query}"`;
      } else {
        return query; // Use raw query if single word or already quoted
      }
    }
  }

  /**
   * Optimize a query for better PubMed search results
   */
  public async optimizeQuery(
    query: string, 
    entities?: ExtractedEntities
  ): Promise<string> {
    // Step 1: Extract or use provided entities
    if (!entities) {
      if (this.openaiClient && this.config.citationExtraction.useLlmExtraction) {
        const llmEntities = await this.extractEntitiesWithLlm(query);
        entities = llmEntities || this.extractEntitiesUsingRegex(query);
      } else {
        entities = this.extractEntitiesUsingRegex(query);
      }
    }

    // Step 2: Try to generate an optimized query using LLM if available and enabled
    if (this.openaiClient && this.config.citationExtraction.useLlmQueryGeneration) {
      const { query: llmQuery, success } = await this.generateImprovedQueryWithLlm(query, entities);
      if (success && llmQuery) {
        return llmQuery;
      }
    }

    // Step 3: Fall back to rule-based optimization
    return this.generateRuleBasedQuery(query, entities);
  }

  /**
   * Fetch data from PubMed API with retry logic
   */
  private async fetchWithRetry(
    url: string,
    params: Record<string, string>,
    timeout: number = this.config.pubmed.timeoutShort
  ): Promise<PubMedResponse> {
    // Add API key if available
    const requestParams = { ...params };
    if (this.ncbiApiKey) {
      requestParams.api_key = this.ncbiApiKey;
    }

    // Build URL with parameters
    const queryString = Object.entries(requestParams)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
    const fullUrl = `${url}?${queryString}`;

    // Prepare request options
    const requestOptions: RequestInit = {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/xml'
      },
      signal: AbortSignal.timeout(timeout)
    };

    for (let attempt = 0; attempt < this.config.pubmed.maxRetries; attempt++) {
      try {
        // Log request info
        if (this.config.network.logNetworkRequests) {
          const logParams = { ...requestParams };
          delete logParams.api_key;
          this.logger.debug(`Request attempt ${attempt + 1}/${this.config.pubmed.maxRetries} to ${url} with params: ${JSON.stringify(logParams)}`);
        }

        const response = await fetch(fullUrl, requestOptions);
        
        if (!response.ok) {
          throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
        }

        // Get headers
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });

        // Get response data
        const data = await response.text();

        // Add delay based on whether API key is used
        const delay = this.ncbiApiKey ? 110 : 350; // ~10/sec with key, ~3/sec without
        await new Promise(resolve => setTimeout(resolve, delay));

        return {
          status: response.status,
          statusText: response.statusText,
          headers,
          data
        };
      } catch (error) {
        this.logger.warn(`Request error on attempt ${attempt + 1}/${this.config.pubmed.maxRetries}: ${error.message}`);
        
        if (attempt < this.config.pubmed.maxRetries - 1) {
          // Calculate backoff time
          const backoffMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
          const backoffSec = (backoffMs / 1000).toFixed(2);
          
          // Increase backoff for rate limits
          if (error.message && error.message.includes('429')) {
            this.logger.warn('Rate limit likely hit.');
            await new Promise(resolve => setTimeout(resolve, Math.max(backoffMs, 5000)));
          } else {
            this.logger.warn(`Retrying in ${backoffSec} seconds...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
          }
        } else {
          this.logger.error('Max retries reached for request.');
          throw error;
        }
      }
    }

    throw new Error('Max retries reached without successful response');
  }

  /**
   * Parse PubMed XML response to extract citations
   */
  private parsePubmedXml(xmlText: string): Citation[] {
    const citations: Citation[] = [];

    try {
      // Extract basic citation data from the XML
      const matches = xmlText.match(/<PubmedArticle>[\s\S]*?<\/PubmedArticle>/g) || [];
      
      for (const articleXml of matches) {
        try {
          // Extract basic data with regex
          const pmidMatch = articleXml.match(/<PMID[^>]*>(.*?)<\/PMID>/);
          const titleMatch = articleXml.match(/<ArticleTitle[^>]*>(.*?)<\/ArticleTitle>/s);
          const journalMatch = articleXml.match(/<Journal[^>]*>[\s\S]*?<Title[^>]*>(.*?)<\/Title>/);
          const yearMatch = articleXml.match(/<PubDate[^>]*>[\s\S]*?<Year[^>]*>(.*?)<\/Year>/);
          const isReviewMatch = articleXml.match(/<PublicationType[^>]*>Review<\/PublicationType>/);
          
          // Extract authors
          const authorElements = articleXml.match(/<Author[^>]*>[\s\S]*?<\/Author>/g) || [];
          const authors: string[] = [];
          
          for (const authorXml of authorElements) {
            const lastNameMatch = authorXml.match(/<LastName[^>]*>(.*?)<\/LastName>/);
            const initialsMatch = authorXml.match(/<Initials[^>]*>(.*?)<\/Initials>/);
            
            if (lastNameMatch && initialsMatch) {
              authors.push(`${lastNameMatch[1]} ${initialsMatch[1]}`);
            } else if (lastNameMatch) {
              authors.push(lastNameMatch[1]);
            }
          }
          
          // Extract DOI if available
          const doiMatch = articleXml.match(/<ArticleId[^>]*IdType="doi"[^>]*>(.*?)<\/ArticleId>/);
          
          if (titleMatch) {
            // Create citation object
            const citation: Citation = {
              title: this.cleanXmlText(titleMatch[1]),
              authors: authors.length > 0 ? authors.join(', ') : 'Unknown',
              journal: journalMatch ? this.cleanXmlText(journalMatch[1]) : 'Unknown Journal',
              pmid: pmidMatch ? pmidMatch[1] : undefined,
              year: yearMatch ? yearMatch[1] : undefined,
              doi: doiMatch ? doiMatch[1] : undefined,
              isReview: !!isReviewMatch,
              url: pmidMatch ? `https://pubmed.ncbi.nlm.nih.gov/${pmidMatch[1]}/` : undefined
            };
            
            citations.push(citation);
          }
        } catch (error) {
          this.logger.warn(`Error parsing article XML: ${error.message}`);
        }
      }
    } catch (error) {
      this.logger.error(`Error parsing PubMed XML: ${error.message}`);
    }
    
    return citations;
  }
  
  /**
   * Clean XML text by removing HTML entities and extra whitespace
   */
  private cleanXmlText(text: string): string {
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }
  
  /**
   * Extract gene symbols from citation titles
   */
  private extractGenesFromTitles(citations: Citation[]): string[] {
    const allGenes = new Set<string>();
    
    for (const citation of citations) {
      if (!citation.title) continue;
      
      const matches = Array.from(citation.title.matchAll(GENE_PATTERN));
      for (const match of matches) {
        const gene = match[0];
        if (gene.length >= 3 && !COMMON_NON_GENES.has(gene.toUpperCase()) && !/^\d+$/.test(gene)) {
          allGenes.add(gene);
        }
      }
    }
    
    return Array.from(allGenes);
  }
  
  /**
   * Search PubMed using the ESearch API (XML) and fetch details
   */
  private async xmlSearch(query: string, maxResults: number = 10): Promise<Citation[]> {
    try {
      // Step 1: Search for PMIDs
      const searchParams = {
        db: 'pubmed',
        term: query,
        retmax: maxResults.toString(),
        retmode: 'xml',
        sort: 'relevance'
      };
      
      const searchResponse = await this.fetchWithRetry(
        'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi',
        searchParams,
        this.config.pubmed.timeoutLong
      );
      
      // Extract PMIDs from search results
      const idMatches = searchResponse.data.match(/<Id>(\d+)<\/Id>/g) || [];
      const pmids = idMatches.map(match => match.replace(/<Id>|<\/Id>/g, ''));
      
      if (pmids.length === 0) {
        this.logger.warn('No PMIDs found in ESearch results');
        return [];
      }
      
      // Step 2: Fetch details for found PMIDs
      const fetchParams = {
        db: 'pubmed',
        id: pmids.join(','),
        retmode: 'xml',
        rettype: 'abstract'
      };
      
      const fetchResponse = await this.fetchWithRetry(
        'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi',
        fetchParams,
        this.config.pubmed.timeoutLong
      );
      
      // Parse the XML to extract citations
      return this.parsePubmedXml(fetchResponse.data);
      
    } catch (error) {
      this.logger.error(`XML search error: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Search PubMed using the Entrez API's esummary endpoint (JSON fallback)
   */
  private async jsonFallbackSearch(query: string, maxResults: number = 10): Promise<Citation[]> {
    try {
      // Step 1: Search for PMIDs
      const searchParams = {
        db: 'pubmed',
        term: query,
        retmax: maxResults.toString(),
        retmode: 'json',
        sort: 'relevance'
      };
      
      const searchResponse = await this.fetchWithRetry(
        'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi',
        searchParams,
        this.config.pubmed.timeoutLong
      );
      
      // Extract PMIDs from search results
      let pmids: string[] = [];
      try {
        const searchData = JSON.parse(searchResponse.data);
        pmids = searchData.esearchresult?.idlist || [];
      } catch (error) {
        this.logger.warn(`Failed to parse JSON search results: ${error.message}`);
        
        // Try to extract IDs with regex as fallback
        const idMatches = searchResponse.data.match(/"id":\s*"(\d+)"/g) || [];
        pmids = idMatches.map(match => match.replace(/"id":\s*"|"/g, ''));
      }
      
      if (pmids.length === 0) {
        this.logger.warn('No PMIDs found in search results');
        return [];
      }
      
      // Step 2: Fetch summaries for found PMIDs
      const summaryParams = {
        db: 'pubmed',
        id: pmids.join(','),
        retmode: 'json'
      };
      
      const summaryResponse = await this.fetchWithRetry(
        'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi',
        summaryParams,
        this.config.pubmed.timeoutLong
      );
      
      // Parse the JSON to extract citations
      const citations: Citation[] = [];
      try {
        const summaryData = JSON.parse(summaryResponse.data);
        const result = summaryData.result || {};
        
        for (const pmid of pmids) {
          const article = result[pmid];
          if (!article) continue;
          
          const authors = (article.authors || [])
            .map((author: any) => `${author.name || 'Unknown Author'}`)
            .join(', ');
          
          const citation: Citation = {
            title: article.title || 'Untitled',
            authors: authors || 'Unknown',
            journal: article.fulljournalname || article.source || 'Unknown Journal',
            pmid,
            year: article.pubdate ? article.pubdate.substring(0, 4) : undefined,
            isReview: (article.pubtype || []).includes('Review'),
            url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
          };
          
          citations.push(citation);
        }
      } catch (error) {
        this.logger.error(`Failed to parse JSON summary results: ${error.message}`);
        return [];
      }
      
      return citations;
      
    } catch (error) {
      this.logger.error(`JSON search error: ${error.message}`);
      return [];
    }
  }
}
