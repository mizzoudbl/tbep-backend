# TBEP Backend - AI Coding Instructions

## Architecture Overview

This is a **bioinformatics backend** built with NestJS that provides GraphQL APIs for target-disease association analysis. The system integrates **four databases**: Neo4j (graph), ClickHouse (OLAP), Redis (cache/sessions), and includes AI-powered insights with Langfuse tracing.

### Core Data Flow
1. **Neo4j**: Stores gene interaction networks, disease relationships, and property metadata
2. **ClickHouse**: Stores pre-computed association scores, prioritization factors, and analytical tables with automatic SQL migrations on startup
3. **DataLoader**: Batches ClickHouse queries to prevent N+1 problems in GraphQL field resolvers
4. **Redis**: Session management for graph projections (60s TTL) and LLM rate limiting

## Module Architecture

### Database Services
- **Neo4jModule**: Dynamic module with `forRootAsync` pattern. Uses GDS (Graph Data Science) for projections and Leiden clustering. Session management requires explicit `releaseSession()` calls.
- **ClickhouseService**: Implements `OnApplicationBootstrap` to run migrations from `src/clickhouse/migrations/*.sql` sequentially. Migrations are tracked in the `migrations` table.
- **RedisService**: Exposes `redisClient` with `nestjs:` keyPrefix. Subscribes to key expiration events for cleanup via `onKeyExpiration()`.

### GraphQL Layer
- **Custom Apollo Driver**: Located in `src/utils/apollo/`. Custom implementation needed for GraphiQL playground integration.
- **Resolvers**: Use DataLoader for `@ResolveField` to batch-load related data (see `TargetResolver.prioritizationTable`).
- **Schema-first approach**: Auto-generates `src/schema.gql` from TypeScript models using code-first decorators.

### Algorithm Service
- **Graph Projections**: Creates temporary Neo4j GDS graphs with `graphName` as identifier. Graphs expire via Redis TTL.
- **Leiden Clustering**: Runs community detection with configurable `resolution`, `weighted`, and `minCommunitySize` parameters.
- **Color Generation**: Uses golden angle (137.507764°) HSL color generation after exhausting 100 predefined CSS colors.

### LLM Service
- **Model Registry**: Supports various models from Nvidia. API keys are read from environment variables. More providers may be added.
- **Endpoints**:
  - `POST /llm/chat`: Standard chat with citations and web scraping
  - `POST /llm/kg-chat`: AI-powered knowledge graph analysis with tool calling
- **KG Chat Architecture**: Client-side tool execution (27+ tools run in browser), backend coordinates LLM responses
- **Tracing**: Langfuse integration only activates in production. Uses OpenTelemetry with `updateActiveObservation()` for input/output tracking.
- **Rate Limiting**: ThrottlerModule with Redis storage
  - Short: 3 requests/10s
  - Long: 10 requests/60s
  - KG Chat: 20 requests/60s (higher for multi-step tool calling)

## Development Conventions

### Path Aliases
Use `@/` for all imports: `import { Neo4jService } from '@/neo4j/neo4j.service'`. Configured in `tsconfig.json`.

### Build System
- **SWC compiler**: Uses `@swc/core` for fast builds. Type checking via `--type-check` flag.
- **Development**: `pnpm run start:dev` (watch mode, no type checking for speed)
- **Production**: `pnpm run build` then `node dist/main` (Docker copies migrations folder to `dist/`)

### Validation
- **Global ZodValidationPipe**: DTOs use Zod schemas with `nestjs-zod`. See `algorithm.dto.ts` for examples.
- **GraphQL inputs**: Use `@InputType()` decorators. Enums use `registerEnumType()` in model files.

### Module Patterns
- **Global modules**: `ConfigModule`, `Neo4jModule`, `RedisModule` set `global: true`
- **Dynamic modules**: Use `forRootAsync()` with `useFactory` + `inject: [ConfigService]`
- **DataLoader per-request**: `DataLoaderService` creates new loaders per request context

## Critical Cypher Query Patterns

### Graph Projection Queries
See `neo4j.constants.ts` for Cypher templates:
- `RENEW_QUERY(order, interactionType)`: Creates GDS projections with dynamic relationship types
- `GENE_INTERACTIONS_QUERY(order, interactionTypes, graphExists)`: Handles 0th/1st/2nd order gene networks
- Always include `minScore` parameter for edge filtering

### ClickHouse Query Conventions
- **Streaming results**: Use `for await (const rows of resultSet.stream<T>())` pattern
- **Array parameters**: Pass as `{geneIds:Array(String)}` in `query_params`
- **Aggregations**: Use `groupArray(concat(key, ',', value))` for key-value pairs, then split in TypeScript

## Environment Configuration

### Required Variables
- `NEO4J_*`: Connection details (default: bolt://localhost:7687)
- `REDIS_*`: Redis config (default: localhost:6379)
- `CLICKHOUSE_*`: ClickHouse config (default: http://localhost:8123)
- `NODE_ENV`: Set to `production` to enable Langfuse tracing and strict CORS

### Optional Variables
- `NVIDIA_API_KEY` / `OPENAI_API_KEY`: For LLM endpoints
- `TAVILY_API_KEY`: For Tavily web search in KG chat (enables searchBiomedicalContext tool)
- `LANGFUSE_*`: Tracing credentials (only used in production)
- `FRONTEND_URL`: CORS origin restriction in production

## Testing & Debugging

### Docker Setup
Use Docker for dependencies (Neo4j, Redis, ClickHouse). No test suite exists yet - manual GraphQL testing via playground.

### Common Issues
1. **Graph projection errors**: Check Redis for existing `graphName` keys (60s TTL)
2. **Migration failures**: ClickHouse migrations run on startup - check logs for SQL errors
3. **DataLoader cache stale**: DataLoaders are request-scoped, not application-scoped

## Code Organization
- **Models**: GraphQL types in `src/graphql/models/` with re-exported barrel `index.ts`
- **Interfaces**: TypeScript types in `src/interfaces/` with barrel export
- **Constants**: Cypher queries in `neo4j.constants.ts`, injection tokens in `*.constants.ts`
- **Utils**: Shared helpers in `src/utils/` - e.g., `mergeEdges.ts` for deduplicating bidirectional edges

## Git Workflow
- **Commitizen**: Use `pnpm run commit` for conventional commits
- **Lint-staged**: Auto-formats TypeScript on commit with Prettier + ESLint
- **Branch**: Currently on `tbepv2`
