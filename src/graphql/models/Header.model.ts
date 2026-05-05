import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class Description {
  @Field(() => String)
  name: string;

  @Field(() => String, { nullable: true })
  description: string;
}

@ObjectType()
export class Headers {
  @Field(() => [Description], { nullable: true })
  differentialExpression?: Description[];

  @Field(() => [Description], { nullable: true })
  genetics?: Description[];

  @Field(() => [Description], { nullable: true })
  openTargets?: Description[];

  @Field(() => [Description], { nullable: true })
  targetPrioritization?: Description[];

  @Field(() => [Description], { nullable: true })
  druggability?: Description[];

  @Field(() => [Description], { nullable: true })
  pathway?: Description[];

  @Field(() => [Description], { nullable: true })
  tissueSpecificity?: Description[];
}
