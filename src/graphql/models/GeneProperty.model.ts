import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { ScoredKeyValue } from './ScoredKeyValue.model';

@ObjectType()
export class GeneProperty {
  @Field(() => ID)
  ID: string;

  @Field(() => [GenePropertyData])
  data: GenePropertyData[];
}

@ObjectType()
export class GenePropertyData extends ScoredKeyValue {
  @Field(() => String, { nullable: true })
  diseaseId?: string;

  @Field(() => GenePropertyCategoryEnum)
  category: GenePropertyCategoryEnum;
}

export enum GenePropertyCategoryEnum {
  DIFFERENTIAL_EXPRESSION = 'DEG',
  OPEN_TARGETS = 'OpenTargets',
  OT_PRIORITIZATION = 'OT_Prioritization',
  PATHWAY = 'Pathway',
  DRUGGABILITY = 'Druggability',
  TISSUE_EXPRESSION = 'TE',
}

registerEnumType(GenePropertyCategoryEnum, {
  name: 'GenePropertyCategoryEnum',
  description: 'Available categories for gene properties',
});
