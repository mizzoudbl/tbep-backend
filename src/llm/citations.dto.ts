export interface Citation {
  title: string;
  authors: string;
  journal: string;
  pmid?: string;
  year?: string;
  doi?: string;
  isReview: boolean;
  relevanceScore?: number;
  url?: string;
}

export interface CitationOptions {
  maxCitations?: number;
  prioritizeReviews?: boolean;
  maxAgeYears?: number;
  format?: 'markdown' | 'json' | 'text';
  useLlm?: boolean;
}

export interface ExtractedEntities {
  genes: string[];
  proteins: string[];
  diseases: string[];
  pathways: string[];
  keywords: string[];
}

export interface CitationQueryResult {
  query: string;
  extractedEntities: ExtractedEntities;
  optimizedQuery: string;
  citations: Citation[];
  genesInTitles?: string[];
  extractionMethod?: 'openai' | 'regex';
  queryMethod?: 'openai' | 'rule';
}

export interface PubMedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: string;
}

export interface ProxyConfig {
  useProxy: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  logNetworkRequests?: boolean;
}

export interface PubMedConfig {
  maxRetries: number;
  timeoutShort: number;
  timeoutLong: number;
  maxCitations: number;
  prioritizeReviews: boolean;
  maxAgeYears: number;
}

export interface CitationExtractionConfig {
  useLlmExtraction: boolean;
  useLlmQueryGeneration: boolean;
  entityExtractionModel: string;
  queryGenerationModel: string;
  extractionTemperature: number;
  generationTemperature: number;
  extractionMaxTokens: number;
  generationMaxTokens: number;
}

export interface CitationsConfig {
  pubmed: PubMedConfig;
  network: ProxyConfig;
  citationExtraction: CitationExtractionConfig;
}
