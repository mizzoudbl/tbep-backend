import { Field, ObjectType, Float, ID, Int } from '@nestjs/graphql';
import { ScoredKeyValue } from './ScoredKeyValue.model';

@ObjectType()
export class Target {
  @Field(() => ID)
  id: string;

  @Field(() => String)
  name: string;

  @Field(() => [ScoredKeyValue])
  prioritization?: ScoredKeyValue[];
}

@ObjectType()
export class TargetDiseaseAssociationRow {
  @Field(() => Target)
  target: Target;

  @Field(() => [ScoredKeyValue])
  datasourceScores: ScoredKeyValue[];

  @Field(() => Float)
  overall_score: number;
}

@ObjectType()
export class TargetDiseaseAssociationTable {
  @Field(() => [TargetDiseaseAssociationRow])
  rows: TargetDiseaseAssociationRow[];

  @Field(() => Int, { nullable: true })
  totalCount: number;
}

@ObjectType()
export class TargetPrioritizationRow {
  @Field(() => Target)
  target: Target;

  @Field(() => Float, { nullable: true })
  overall_score?: number | null;
}

@ObjectType()
export class TargetPrioritizationTable {
  @Field(() => [TargetPrioritizationRow])
  rows: TargetPrioritizationRow[];

  @Field(() => Int, { nullable: true })
  totalCount: number;
}
