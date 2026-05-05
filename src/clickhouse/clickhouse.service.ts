import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ClickHouseClient, createClient } from '@clickhouse/client';
import { promises as fs } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config/dist/config.service';
import {
  TopGene,
  TargetDiseaseAssociationTable,
  TargetPrioritizationTable,
  OrderByEnum,
  Pagination,
  ScoredKeyValue,
  TargetDiseaseAssociationRow,
  TargetPrioritizationRow,
  DataRequired,
  GeneProperty,
  GenePropertyCategoryEnum,
  GenePropertyData,
} from '@/graphql/models';
import { GraphQLError } from 'graphql/error/GraphQLError';

@Injectable()
export class ClickhouseService implements OnApplicationBootstrap {
  private client: ClickHouseClient;
  private readonly logger = new Logger(ClickhouseService.name);
  private readonly scoredValueDelimiter = ';';

  constructor(private readonly configService: ConfigService) {
    this.client = createClient({
      url: this.configService.get<string>('CLICKHOUSE_URL', 'http://localhost:8123'),
      username: this.configService.get<string>('CLICKHOUSE_USER', 'default'),
      password: this.configService.get<string>('CLICKHOUSE_PASSWORD', ''),
    });
  }

  async onApplicationBootstrap() {
    await this.#runMigrations();
  }

  #resolvePagination(pagination?: Pagination): Pagination {
    return {
      page: pagination?.page && pagination.page > 0 ? pagination.page : 1,
      limit: pagination?.limit && pagination.limit > 0 ? pagination.limit : 25,
    };
  }

  private parseScoredKeyValues(values?: string[]): ScoredKeyValue[] {
    if (!Array.isArray(values)) return [];

    return values.reduce<ScoredKeyValue[]>((acc, value) => {
      const delimiterIndex = value.indexOf(this.scoredValueDelimiter);
      if (delimiterIndex === -1) return acc;

      const key = value.slice(0, delimiterIndex);
      const score = Number.parseFloat(value.slice(delimiterIndex + 1));

      if (!Number.isFinite(score)) return acc;

      acc.push({ key, score });
      return acc;
    }, []);
  }

  async getTopGenesByDisease(diseaseId: string, pagination?: Pagination): Promise<TopGene[]> {
    const { page, limit } = this.#resolvePagination(pagination);
    const query = `
      SELECT gene_name
      FROM overall_association_score
      WHERE disease_id = {diseaseId:String}
      ORDER BY score DESC
      LIMIT {limit:UInt32}
      OFFSET {offset:UInt32}
    `;
    try {
      const resultSet = await this.client.query({
        query,
        query_params: { diseaseId, limit, offset: (page - 1) * limit },
        format: 'JSONEachRow',
      });

      const genes: TopGene[] = [];

      for await (const rows of resultSet.stream<TopGene>()) {
        for (const row of rows) {
          genes.push(row.json());
        }
      }

      return genes;
    } catch (error) {
      this.logger.error('query failed', error);
      throw error;
    }
  }

  async getTargetDiseaseAssociationTable(
    geneIds: string[],
    diseaseId: string,
    orderBy: OrderByEnum,
    pagination?: Pagination,
  ): Promise<TargetDiseaseAssociationTable> {
    const { page, limit } = this.#resolvePagination(pagination);
    const offset = (page - 1) * limit;

    // Determine if we should order by overall score or by a specific datasource
    const orderByScore = orderBy === OrderByEnum.SCORE;

    let query: string;

    if (orderByScore) {
      // Order by overall_score
      query = `
        SELECT
          gene_id,
          gene_name,
          disease_id,
          groupArray(concat(datasource_id, '${this.scoredValueDelimiter}', toString(datasource_score))) AS datasourceScores,
          overall_score,
          count() OVER () AS total_count
        FROM mv_datasource_association_score_overall_association_score
        WHERE disease_id = {diseaseId:String}
          AND gene_id IN ({geneIds:Array(String)})
        GROUP BY
          disease_id, gene_id, overall_score, gene_name
        ORDER BY
          overall_score DESC
        LIMIT {limit:UInt32}
        OFFSET {offset:UInt32}
      `;
    } else {
      // Order by specific datasource score
      query = `
        SELECT
          gene_id,
          gene_name,
          disease_id,
          maxIf(datasource_score, datasource_id = {orderBy:String}) AS datasource_order_score,
          groupArray(concat(datasource_id, '${this.scoredValueDelimiter}', toString(datasource_score))) AS datasourceScores,
          overall_score,
          count() OVER () AS total_count
        FROM mv_datasource_association_score_overall_association_score
        WHERE disease_id = {diseaseId:String}
          AND gene_id IN ({geneIds:Array(String)})
        GROUP BY
          disease_id, gene_id, overall_score, gene_name
        ORDER BY
          datasource_order_score DESC
        LIMIT {limit:UInt32}
        OFFSET {offset:UInt32}
      `;
    }

    try {
      const resultSet = await this.client.query({
        query,
        query_params: {
          diseaseId,
          geneIds,
          orderBy: orderByScore ? '' : orderBy,
          limit,
          offset,
        },
        format: 'JSONEachRow',
      });

      const results: TargetDiseaseAssociationRow[] = [];
      let totalCount = 0;

      for await (const rows of resultSet.stream<{
        gene_id: string;
        gene_name: string;
        disease_id: string;
        datasourceScores: string[];
        overall_score: number;
        total_count: number;
      }>()) {
        for (const row of rows) {
          const data = row.json();

          // Get total count from the first row
          if (totalCount === 0) {
            totalCount = data.total_count;
          }

          // Transform datasourceScores from string array to object array
          const datasourceScores = this.parseScoredKeyValues(data.datasourceScores);

          results.push({
            target: {
              id: data.gene_id,
              name: data.gene_name,
            },
            datasourceScores,
            overall_score: data.overall_score,
          });
        }
      }

      return {
        rows: results,
        totalCount,
      };
    } catch (error) {
      this.logger.error('targetDiseaseAssociationTable query failed', error);
      throw error;
    }
  }

  async getTargetPrioritizationTable(
    geneIds: string[],
    diseaseId: string,
    orderBy: OrderByEnum,
    pagination?: Pagination,
  ): Promise<TargetPrioritizationTable> {
    const { page, limit } = this.#resolvePagination(pagination);
    const offset = (page - 1) * limit;

    const query = `
      SELECT
        selected_genes.gene_id,
        coalesce(oas.gene_name, selected_genes.gene_id) AS gene_name,
        ifNull(oas.score, 0) AS overall_score,
        count() OVER () AS total_count
      FROM (
        SELECT arrayJoin({geneIds:Array(String)}) AS gene_id
      ) AS selected_genes
      LEFT JOIN overall_association_score oas
        ON oas.gene_id = selected_genes.gene_id
        AND oas.disease_id = {diseaseId:String}
      ORDER BY ${orderBy === OrderByEnum.SCORE ? 'overall_score DESC, gene_name ASC' : 'gene_name ASC'}
      LIMIT {limit:UInt32}
      OFFSET {offset:UInt32}
    `;

    try {
      const resultSet = await this.client.query({
        query,
        query_params: {
          geneIds,
          diseaseId,
          limit,
          offset,
        },
        format: 'JSONEachRow',
      });

      const results: TargetPrioritizationRow[] = [];
      let totalCount = 0;

      for await (const rows of resultSet.stream<{
        gene_id: string;
        gene_name: string;
        overall_score: number;
        total_count: number;
      }>()) {
        for (const row of rows) {
          const data = row.json();

          if (totalCount === 0) {
            totalCount = data.total_count;
          }

          results.push({
            target: {
              id: data.gene_id,
              name: data.gene_name,
            },
            overall_score: data.overall_score,
          });
        }
      }

      return {
        rows: results,
        totalCount,
      };
    } catch (error) {
      this.logger.error('targetPrioritizationTable query failed', error);
      throw error;
    }
  }

  async getBatchPrioritizationTable(geneIds: string[]): Promise<Map<string, ScoredKeyValue[]>> {
    const query = `
      SELECT
        gene_id,
        groupArray(concat(property_name, '${this.scoredValueDelimiter}', toString(score))) AS properties
      FROM target_prioritization_factors
      WHERE gene_id IN ({geneIds:Array(String)})
      GROUP BY gene_id
    `;

    try {
      const resultSet = await this.client.query({
        query,
        query_params: { geneIds },
        format: 'JSONEachRow',
      });

      const resultMap = new Map<string, ScoredKeyValue[]>();

      for await (const rows of resultSet.stream<{ gene_id: string; properties: string[] }>()) {
        for (const row of rows) {
          const data = row.json();
          // Transform properties from string array to ScoredKeyValue array
          const scoredKeyValues = this.parseScoredKeyValues(data.properties);

          resultMap.set(data.gene_id, scoredKeyValues);
        }
      }
      return resultMap;
    } catch (error) {
      this.logger.error('batch prioritizationTable query failed', error);
      throw error;
    }
  }

  async getGeneProperties(geneIds: string[], config: DataRequired[]): Promise<GeneProperty[]> {
    const genePropertyMap = new Map<string, GenePropertyData[]>();

    for (const configItem of config) {
      const { category, properties } = configItem;
      let diseaseId = configItem.diseaseId;
      if (properties.length === 0) continue;
      let query: string;
      let queryParams: Record<string, any>;

      switch (category) {
        case GenePropertyCategoryEnum.DIFFERENTIAL_EXPRESSION: {
          if (diseaseId) {
            query = `
              SELECT gene_id, groupArray(concat(property_name, '${this.scoredValueDelimiter}', toString(score))) AS properties
              FROM differential_expression
              WHERE disease_id = {diseaseId:String}
                AND gene_id IN ({geneIds:Array(String)})
                AND property_name IN ({properties:Array(String)})
              GROUP BY gene_id
            `;
            queryParams = { geneIds, diseaseId, properties };
          } else {
            throw new GraphQLError('Disease ID is required for DEG category', {
              extensions: { code: 'BAD_USER_INPUT' },
            });
          }
          break;
        }

        case GenePropertyCategoryEnum.OPEN_TARGETS: {
          if (diseaseId) {
            const dataSourceProperties = properties.filter((prop) => prop !== 'Overall_Association Score');
            if (dataSourceProperties.length === properties.length) {
              query = `
                SELECT gene_id, groupArray(concat(datasource_id, '${this.scoredValueDelimiter}', toString(score))) AS properties
                FROM datasource_association_score
                WHERE disease_id = {diseaseId:String}
                AND gene_id IN ({geneIds:Array(String)})
                AND datasource_id IN ({properties:Array(String)})
                GROUP BY gene_id
              `;
              queryParams = { geneIds, diseaseId, properties };
            } else if (dataSourceProperties.length === 0) {
              query = `
                SELECT gene_id, groupArray(concat('Overall_Association Score${this.scoredValueDelimiter}', toString(score))) AS properties
                FROM overall_association_score
                WHERE disease_id = {diseaseId:String}
                AND gene_id IN ({geneIds:Array(String)})
                GROUP BY gene_id
              `;
              queryParams = { geneIds, diseaseId };
            } else {
              query = `
                SELECT gene_id, groupArray(concat(datasource_id, '${this.scoredValueDelimiter}', toString(score))) AS properties
                FROM datasource_association_score
                WHERE disease_id = {diseaseId:String}
                AND gene_id IN ({geneIds:Array(String)})
                AND datasource_id IN ({properties:Array(String)})
                GROUP BY gene_id
                UNION ALL
                SELECT gene_id, groupArray(concat('Overall_Association Score${this.scoredValueDelimiter}', toString(score))) AS properties
                FROM overall_association_score
                WHERE disease_id = {diseaseId:String}
                AND gene_id IN ({geneIds:Array(String)})
                GROUP BY gene_id
              `;
              queryParams = { geneIds, diseaseId, properties: dataSourceProperties };
            }
          } else {
            throw new GraphQLError('Disease ID is required for OpenTargets category', {
              extensions: { code: 'BAD_USER_INPUT' },
            });
          }
          break;
        }

        case GenePropertyCategoryEnum.OT_PRIORITIZATION: {
          query = `
            SELECT gene_id, groupArray(concat(property_name, '${this.scoredValueDelimiter}', toString(score))) AS properties
            FROM target_prioritization_factors
            WHERE gene_id IN ({geneIds:Array(String)})
            AND property_name IN ({properties:Array(String)})
            GROUP BY gene_id
          `;
          queryParams = { geneIds, properties };
          diseaseId = undefined;
          break;
        }

        case GenePropertyCategoryEnum.PATHWAY: {
          query = `
            SELECT gene_id, groupArray(concat(property_name, '${this.scoredValueDelimiter}', toString(score))) AS properties
            FROM pathway
            WHERE gene_id IN ({geneIds:Array(String)})
            AND property_name IN ({properties:Array(String)})
            GROUP BY gene_id
          `;
          queryParams = { geneIds, properties };
          diseaseId = undefined;
          break;
        }

        case GenePropertyCategoryEnum.DRUGGABILITY: {
          query = `
            SELECT gene_id, groupArray(concat(property_name, '${this.scoredValueDelimiter}', toString(score))) AS properties
            FROM druggability
            WHERE gene_id IN ({geneIds:Array(String)})
            AND property_name IN ({properties:Array(String)})
            GROUP BY gene_id
          `;
          queryParams = { geneIds, properties };
          diseaseId = undefined;
          break;
        }

        case GenePropertyCategoryEnum.TISSUE_EXPRESSION: {
          // TISSUE_EXPRESSION
          query = `
            SELECT gene_id, groupArray(concat(property_name, '${this.scoredValueDelimiter}', toString(score))) AS properties
            FROM tissue_specificity
            WHERE gene_id IN ({geneIds:Array(String)})
            AND property_name IN ({properties:Array(String)})
            GROUP BY gene_id
          `;
          queryParams = { geneIds, properties };
          diseaseId = undefined;
          break;
        }

        default:
          this.logger.warn(`Unknown category: ${category}`);
          continue;
      }

      try {
        const resultSet = await this.client.query({
          query,
          query_params: queryParams,
          format: 'JSONEachRow',
        });

        for await (const rows of resultSet.stream<{ gene_id: string; properties: string[] }>()) {
          for (const row of rows) {
            const data = row.json();
            const properties = this.parseScoredKeyValues(data.properties).map(({ key, score }) => ({
              key,
              score,
              category,
              diseaseId,
            }));

            if (!genePropertyMap.has(data.gene_id)) {
              genePropertyMap.set(data.gene_id, []);
            }
            genePropertyMap.get(data.gene_id)?.push(...properties);
          }
        }
      } catch (error) {
        this.logger.error(`Failed to fetch ${category} properties:`, error);
      }
    }

    // Convert map to final result format
    return geneIds.map((geneId) => ({
      ID: geneId,
      data: genePropertyMap.get(geneId) || [],
    }));
  }

  async #runMigrations() {
    const migrationDir = join(process.cwd(), 'src/clickhouse/migrations');
    this.logger.log(`Looking for migrations in: ${migrationDir}`);
    let files: string[];
    try {
      files = (await fs.readdir(migrationDir)).filter((f) => f.endsWith('.sql')).sort();
    } catch (e) {
      this.logger.warn(`Migration directory not found: ${migrationDir}`);
      this.logger.debug(`Error details: ${e}`);
      return;
    }

    await this.client.command({
      query: `
        CREATE TABLE IF NOT EXISTS migrations (
          version String,
          applied_at DateTime DEFAULT now()
        ) ENGINE = MergeTree()
        ORDER BY version
      `,
    });

    const lastAppliedVersion = await this.#getLastAppliedVersion();

    for (const file of files) {
      const version = file.split('_')[0];
      if (lastAppliedVersion && Number(version) <= Number(lastAppliedVersion)) {
        continue; // Skip already applied migrations
      }
      const sql = await fs.readFile(join(migrationDir, file), 'utf8');
      this.logger.log(`Running migration ${file}...`);
      try {
        sql.split(';').forEach(async (stmt) => {
          await this.client.command({
            query: stmt.trim(),
          });
        });
        await this.#markMigrationAsApplied(version);
        this.logger.log(`Migration ${file} applied.`);
      } catch (err) {
        this.logger.error(`Migration ${file} failed: ${err?.message || err}`);
      }
    }
  }

  async #getLastAppliedVersion(): Promise<string | null> {
    const result = await this.client.query({
      query: `SELECT version FROM migrations ORDER BY version DESC LIMIT 1`,
      format: 'JSON',
    });
    const rows = await result.json<{ data: Array<Record<string, any>> }>();
    return rows.data.length > 0 ? rows.data[0]['version'] : null;
  }

  async #markMigrationAsApplied(version: string) {
    await this.client.insert({
      table: 'migrations',
      values: [{ version }],
      format: 'JSONEachRow',
    });
  }
}
