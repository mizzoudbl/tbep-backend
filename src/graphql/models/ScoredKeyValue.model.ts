import { Field, Float, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class ScoredKeyValue {
  @Field(() => String)
  key: string;

  @Field(() => Float)
  score: number;
}
