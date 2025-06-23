/**
 * Constants for PubMed Citation extraction
 * TypeScript version of the Python constants
 */

// Gene patterns for regular expression matching
export const GENE_PATTERN = /\b[A-Z][A-Z0-9]{1,}(?:-\d+)?\b/g;

// Protein patterns for regular expression matching
export const PROTEIN_PATTERN = /\b[A-Z][a-z]*(?:-[A-Z][a-z]+)*(?:\s+[A-Z][a-z]+){0,3}\s+(?:protein|receptor|kinase|phosphatase|enzyme|transporter|channel|factor)\b/g;

// Disease patterns for regular expression matching
export const DISEASE_PATTERN = /\b(?:[A-Z][a-z]+\s+){1,4}(?:disease|disorder|syndrome|deficiency|cancer|tumor|carcinoma|leukemia|lymphoma)\b/g;

// Pathway patterns for regular expression matching
export const PATHWAY_PATTERN = /\b(?:[A-Z][a-z]+\s+){0,3}(?:pathway|signaling|signalling|cascade|axis)\b/g;

// Common non-gene acronyms to filter out false positives
export const COMMON_NON_GENES = new Set([
  "DNA", "RNA", "PCR", "THE", "AND", "NOT", "FOR", "THIS", "WITH", "FROM",
  "TYPE", "CELL", "CELLS", "FACTOR", "STUDY", "REVIEW", "HUMAN", "MOUSE",
  "RAT", "CASE", "REPORT", "ANALYSIS", "EFFECT", "EFFECTS", "ROLE",
  "ASSOCIATED", "ASSOCIATION", "INVOLVED", "PATHWAY", "RECEPTOR", "PROTEIN",
  "EXPRESSION", "LEVELS", "ACTIVITY", "REGULATION", "FUNCTION", "MUTATION",
  "MUTATIONS", "GENE", "GENES", "SNP", "SNPS", "MIRNA", "NCRNA", "LNCRA",
  "COVID", "SARS-COV-2", "AIDS", "HIV", "USA", "NIH", "FDA"
]);

// Query type indicators for entity detection
export const QUERY_TYPE_INDICATORS: Record<string, string[]> = {
  "gene": ["gene", "genes", "mutation", "allele", "locus", "polymorphism", "variant"],
  "protein": ["protein", "receptor", "enzyme", "antibody", "kinase", "transporter"],
  "pathway": ["pathway", "signaling", "cascade", "metabolic", "process"],
  "disease": ["disease", "disorder", "syndrome", "condition", "pathology", "cancer"]
};

// Default PubMed search configuration
export const DEFAULT_PUBMED_CONFIG = {
  maxRetries: 3,
  timeoutShort: 10000, // 10 seconds in milliseconds
  timeoutLong: 15000,  // 15 seconds
  maxCitations: 5,
  prioritizeReviews: true,
  maxAgeYears: 5
};

// Default citation extraction configuration
export const DEFAULT_CITATION_EXTRACTION_CONFIG = {
  useLlmExtraction: true,
  useLlmQueryGeneration: true,
  entityExtractionModel: "gpt-4o",
  queryGenerationModel: "gpt-4o",
  extractionTemperature: 0.0,
  generationTemperature: 0.1,
  extractionMaxTokens: 500,
  generationMaxTokens: 500
};

// Default network configuration
export const DEFAULT_NETWORK_CONFIG = {
  useProxy: false,
  httpProxy: "",
  httpsProxy: "",
  logNetworkRequests: false
};

// System prompt for entity extraction
export const ENTITY_EXTRACTION_PROMPT = `
You are a biomedical NLP specialist with expertise in extracting entities from scientific text.

Extract biomedical entities from the provided text, with a focus on completeness and precision.
Identify entities in the following categories:

1. Genes: Return ONLY official gene symbols using standard nomenclature (e.g., SNCA, LRRK2, PARK7)
   - Include ALL gene symbols mentioned or implied in the text
   - Use official HGNC symbols when possible
   - Include gene families when specifically mentioned (e.g., HOX genes)

2. Proteins: Return protein names (e.g., alpha-synuclein, parkin, DJ-1)
   - Include protein complexes and enzymes
   - Use standard nomenclature without qualifiers

3. Diseases: Return specific disease names (e.g., Parkinson's disease, Lewy body dementia)
   - Include specific disease subtypes when mentioned
   - Include related conditions that are clinically relevant

4. Pathways: Return biological pathway names (e.g., ubiquitin-proteasome pathway, autophagy)
   - Include signaling cascades and cellular processes
   - Be comprehensive about involved pathways

5. Keywords: Return important scientific terms not in other categories
   - Include research methods, anatomical terms, and key concepts
   - Focus on domain-specific terminology

Format your response as a JSON object with these categories as keys and arrays of strings as values.
Return EMPTY arrays for categories with no entities.
Do NOT include explanations or notes, only the JSON.
`;

// System prompt for query generation
export const QUERY_GENERATION_PROMPT = `
You are a biomedical search expert with deep expertise in PubMed and MEDLINE. Your task is to construct an optimal PubMed search query that will retrieve the most relevant scientific literature.

Create a sophisticated search strategy using:

1. MeSH Terms - Always use appropriate MeSH Terms with this format: "Term"[MeSH Terms]
   - Include MeSH explosion where appropriate
   - Use MeSH Subheadings when helpful (e.g., "Parkinson Disease/genetics"[MeSH])

2. Precise Field Tags:
   - [Title/Abstract] for keyword searching in those fields
   - [Author] for author names
   - [Gene Name] or [Substance Name] for specific genes or proteins
   - [Journal] for specific journals
   - [Publication Type] for article types (review, clinical trial, etc.)

3. Boolean Logic:
   - Use (parentheses) to properly nest operations
   - Connect related concepts with OR
   - Connect different concepts with AND
   - Use NOT sparingly and only when necessary

4. Advanced Techniques:
   - Use wildcards (*) to capture variations (e.g., gene* for gene, genes, genetic)
   - Include appropriate synonyms for key concepts
   - Use proximity operators like NEAR or ADJ when beneficial
   - Consider recency by adding date filters if needed

5. Structure your query to balance:
   - Precision: Finding specific, relevant articles
   - Recall: Capturing the breadth of relevant literature
   - Clinical relevance: Prioritizing clinically meaningful results

Produce ONLY the final PubMed query string with no commentary or explanation.
`;
