import { GraphqlService } from '@/graphql/graphql.service';
import { RedisService } from '@/redis/redis.service';
import { ConfigService } from '@nestjs/config';
import { Args, Context, Info, Int, Query, Resolver } from '@nestjs/graphql';
import type { Request } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import { z } from 'zod';
import { GeneInteractionOutput, GeneMetadata, Headers, InteractionInput } from './models';
import { Kind, type GraphQLResolveInfo } from 'graphql';

@Resolver()
export class GraphqlResolver {
  constructor(
    private readonly graphqlService: GraphqlService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  @Query(() => [GeneMetadata])
  async genes(@Args('geneIDs', { type: () => [String] }) geneIDs: string[]): Promise<GeneMetadata[]> {
    return this.graphqlService.getGenes(geneIDs);
  }

  @Query(() => Headers)
  async headers(
    @Args('diseaseId', { type: () => String }) diseaseId: string,
    @Info() info: GraphQLResolveInfo,
  ): Promise<Headers> {
    const key = `headers:common`;
    let result: Headers | null = null;
    const cached = await this.redisService.redisClient.get(key);
    if (cached) {
      result = JSON.parse(cached) as Headers;
      const isDbQueryNeeded =
        info.fieldNodes[0].selectionSet?.selections.some(
          (val) =>
            val.kind === Kind.FIELD && (val.name.value === 'differentialExpression' || val.name.value === 'genetics'),
        ) ?? false;
      if (isDbQueryNeeded === false) return result;
    }
    result = await this.graphqlService.getHeaders(diseaseId, result);
    await this.redisService.redisClient.set(key, JSON.stringify(result), 'EX', 86400);
    return result;
  }

  @Query(() => GeneInteractionOutput)
  async getGeneInteractions(
    @Args('input', { type: () => InteractionInput }) input: InteractionInput,
    @Args('order', { type: () => Int }) order: number,
    @Context('req') req: Request,
  ): Promise<GeneInteractionOutput> {
    const userID: string = req.cookies['user-id'] ?? crypto.randomUUID();
    if (z.uuid().safeParse(userID).success === false) throw new ZodValidationException('Correct user ID not found');
    if (!req.cookies['user-id']) {
      await this.redisService.redisClient.set(
        `user:${userID}`,
        '',
        'EX',
        this.configService.get('REDIS_USER_EXPIRY', 7200),
      );

      req.res?.cookie('user-id', userID, {
        maxAge: this.configService.get('REDIS_USER_EXPIRY', 7200) * 1000,
        httpOnly: true,
        secure: this.configService.get('NODE_ENV') === 'production',
        sameSite: 'strict',
      });
    }

    const graphName =
      input.graphName ??
      this.graphqlService.computeHash(JSON.stringify({ ...input, geneIDs: input.geneIDs.sort(), order }));
    const result = await this.graphqlService.getGeneInteractions(input, order, graphName, userID);
    return {
      genes: result.genes,
      links: result.links,
      graphName,
      averageClusteringCoefficient: result.averageClusteringCoefficient,
    };
  }
}
