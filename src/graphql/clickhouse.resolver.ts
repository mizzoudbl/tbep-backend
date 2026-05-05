import { ClickhouseService } from '@/clickhouse/clickhouse.service';
import { DataLoaderService } from '@/dataloader';
import { Args, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import {
  DataRequired,
  GeneProperty,
  OrderByEnum,
  ScoredKeyValue,
  Target,
  TargetDiseaseAssociationTable,
  TargetPrioritizationTable,
  TopGene,
} from './models';
import { Pagination } from './models/Pagination.input';

@Resolver()
export class ClickhouseResolver {
  constructor(private readonly clickhouseService: ClickhouseService) {}

  private normalizePagination(pagination?: Pagination): Pagination {
    return {
      page: pagination?.page && pagination.page > 0 ? pagination.page : 1,
      limit: pagination?.limit && pagination.limit > 0 ? pagination.limit : 25,
    };
  }

  @Query(() => [TopGene])
  async topGenesByDisease(
    @Args('diseaseId', { type: () => String }) diseaseId: string,
    @Args('page', { type: () => Pagination, nullable: true }) pagination?: Pagination,
  ): Promise<TopGene[]> {
    return this.clickhouseService.getTopGenesByDisease(diseaseId, this.normalizePagination(pagination));
  }

  @Query(() => TargetDiseaseAssociationTable)
  async targetDiseaseAssociationTable(
    @Args('geneIds', { type: () => [String] }) geneIds: string[],
    @Args('diseaseId', { type: () => String }) diseaseId: string,
    @Args('orderBy', {
      type: () => OrderByEnum,
      defaultValue: OrderByEnum.SCORE,
      nullable: true,
    })
    orderBy: OrderByEnum,
    @Args('page', { type: () => Pagination, nullable: true })
    pagination?: Pagination,
  ) {
    return this.clickhouseService.getTargetDiseaseAssociationTable(
      geneIds,
      diseaseId,
      orderBy,
      this.normalizePagination(pagination),
    );
  }

  @Query(() => TargetPrioritizationTable)
  async targetPrioritizationTable(
    @Args('geneIds', { type: () => [String] }) geneIds: string[],
    @Args('diseaseId', { type: () => String }) diseaseId: string,
    @Args('orderBy', {
      type: () => OrderByEnum,
      defaultValue: OrderByEnum.SCORE,
      nullable: true,
    })
    orderBy: OrderByEnum,
    @Args('page', { type: () => Pagination, nullable: true })
    pagination?: Pagination,
  ) {
    return this.clickhouseService.getTargetPrioritizationTable(
      geneIds,
      diseaseId,
      orderBy,
      this.normalizePagination(pagination),
    );
  }

  @Query(() => [GeneProperty])
  async geneProperties(
    @Args('geneIds', { type: () => [String] }) geneIds: string[],
    @Args('config', { type: () => [DataRequired] }) config: DataRequired[],
  ) {
    return this.clickhouseService.getGeneProperties(geneIds, config);
  }
}

@Resolver(() => Target)
export class TargetResolver {
  constructor(private readonly dataLoaderService: DataLoaderService) {}

  @ResolveField('prioritization', () => [ScoredKeyValue])
  async prioritizationTable(@Parent() target: Target) {
    const prioritizationLoader = this.dataLoaderService.getPrioritizationLoader();
    return prioritizationLoader.load(target.id);
  }
}
