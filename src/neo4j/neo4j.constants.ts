export const NEO4J_CONFIG: string = 'NEO4J_CONFIG';
export const NEO4J_DRIVER: string = 'NEO4J_DRIVER';

export const GET_HEADERS_QUERY = (cache = false) =>
  `MATCH (p:Property)${cache ? '<-[:HAS_PROPERTY]-(:Disease { ID: $diseaseId })' : ''}
  ${
    !cache
      ? `WHERE NOT EXISTS((p)<-[:HAS_PROPERTY]-(:Disease)) OR 
         EXISTS((p)<-[:HAS_PROPERTY]-(:Disease { ID: $diseaseId }))`
      : 'WHERE p.category = "LogFC" OR p.category = "Genetics"'
  }
  WITH COLLECT(p) AS allProps
  RETURN
  ${
    cache
      ? ''
      : `[prop IN allProps WHERE prop.category = "OpenTargets" | { name: prop.name, description: prop.description }] AS openTargets,
        [prop IN allProps WHERE prop.category = "OT_Prioritization" | { name: prop.name, description: prop.description }] AS targetPrioritization,
        [prop IN allProps WHERE prop.category = "Druggability" | { name: prop.name, description: prop.description }] AS druggability,
        [prop IN allProps WHERE prop.category = "Pathway" | { name: prop.name, description: prop.description }] AS pathway,
        [prop IN allProps WHERE prop.category = "TE" | { name: prop.name, description: prop.description }] AS tissueSpecificity,`
  }
    [prop IN allProps WHERE prop.category = "LogFC" | { name: prop.name, description: prop.description }] AS differentialExpression,
    [prop IN allProps WHERE prop.category = "Genetics" | { name: prop.name, description: prop.description }] AS genetics
  `;

export const GET_DISEASES_QUERY = `MATCH (d:Disease) RETURN d { .* } AS diseases;`;

export const GET_GENES_QUERY = `MATCH (g:Gene)
    WHERE g.ID IN $geneIDs OR g.Gene_name IN $geneIDs
    RETURN { Input: g.Gene_name, Gene_name: g.Gene_name, Description: g.Description, hgnc_gene_id: g.hgnc_gene_id, ID: g.ID, Aliases: g.Aliases } AS genes
    UNION ALL
    MATCH (a:GeneAlias)-[:ALIAS_OF]->(g:Gene)
    WHERE a.Gene_name IN $geneIDs
    RETURN { Input: a.Gene_name, Gene_name: g.Gene_name, Description: g.Description, hgnc_gene_id: g.hgnc_gene_id, ID: g.ID, Aliases: g.Aliases } AS genes`;

function formatInteractionTypes(interactionTypes: string[]): string {
  return interactionTypes.map((type) => `${type}`).join('|');
}

export function GENE_INTERACTIONS_QUERY(order: number, interactionTypes: string[], graphExists = true): string {
  const relTypes = formatInteractionTypes(interactionTypes);
  switch (order) {
    case 0:
      return `MATCH (g1:Gene) WHERE g1.ID IN $geneIDs
        OPTIONAL MATCH (g1:Gene)-[r:${relTypes}]->(g2:Gene)
        WHERE r.score >= $minScore AND g2.ID IN $geneIDs
        WITH [conn IN COLLECT({gene1: g1.ID, gene2: g2.ID, score: r.score, interactionType: type(r)}) WHERE conn.gene2 IS NOT NULL] AS links, apoc.coll.toSet(COLLECT(g1 { .ID, .Gene_name, .Description})) AS genes
        ${graphExists ? '' : ",gds.graph.project($graphName,g1,g2,{ relationshipProperties: r { .score }, relationshipType: type(r) }, { undirectedRelationshipTypes: ['*'] }) AS graph"}
        RETURN genes, links
        `;
    case 1:
      return `MATCH (g1:Gene) WHERE g1.ID IN $geneIDs
        OPTIONAL MATCH (g1)-[r:${relTypes}]-(g2:Gene)
        WHERE r.score >= $minScore
        WITH apoc.coll.toSet(COLLECT(g1 { .ID, .Gene_name, .Description}) + [gene IN COLLECT(g2 { .ID, .Gene_name, .Description}) WHERE gene.ID IS NOT NULL]) AS _genes, [conn IN COLLECT({gene1: g1.ID, gene2: g2.ID, score: r.score, interactionType: type(r)}) WHERE conn.gene2 IS NOT NULL] AS _links
        ${graphExists ? '' : ",gds.graph.project($graphName,g1,g2,{ relationshipProperties: r { .score }, relationshipType: type(r) }, { undirectedRelationshipTypes: ['*'] }) AS graph"}
        RETURN _genes[0..${process.env.NODES_LIMIT || 5000}] AS genes, _links[0..${process.env.EDGES_LIMIT || 10000}] AS links
        `;
    default:
      return '';
  }
}

export function FIRST_ORDER_GENES_QUERY(interactionTypes: string[]): string {
  const relTypes = formatInteractionTypes(interactionTypes);
  return `MATCH (g1:Gene) WHERE g1.ID IN $geneIDs
    OPTIONAL MATCH (g1)-[r:${relTypes}]-(g2:Gene)
    WHERE r.score >= $minScore
    WITH apoc.coll.toSet(COLLECT(g1.ID) + [geneID IN COLLECT(g2.ID) WHERE geneID IS NOT NULL]) AS _geneIDs
    RETURN _geneIDs[0..${process.env.NODES_LIMIT || 5000}] AS geneIDs`;
}

export const GRAPH_DROP_QUERY = 'CALL gds.graph.drop($graphName)';
export function LEIDEN_QUERY(minCommunitySize: number, weighted = true): string {
  return `CALL gds.leiden.stream($graphName, { ${weighted ? 'relationshipWeightProperty: "score",' : ''} gamma: $resolution, minCommunitySize: ${minCommunitySize}, logProgress: false }) YIELD nodeId, communityId RETURN gds.util.asNode(nodeId).ID AS ID, communityId`;
}

export function RENEW_QUERY(order: number, interactionTypes: string[]) {
  const relTypes = formatInteractionTypes(interactionTypes);
  switch (order) {
    case 0:
      return `MATCH (g1:Gene) WHERE g1.ID IN $geneIDs
        OPTIONAL MATCH (g1:Gene)-[r:${relTypes}]->(g2:Gene)
        WHERE r.score >= $minScore AND elementId(g1) < elementId(g2) AND g2.ID IN $geneIDs
        WITH gds.graph.project($graphName,g1,g2,{ relationshipProperties: r { .score }, relationshipType: type(r) }, { undirectedRelationshipTypes: ['*'] }) AS graph
        FINISH
        `;
    case 1:
      return `MATCH (g1:Gene) WHERE g1.ID IN $geneIDs
        OPTIONAL MATCH (g1)-[r:${relTypes}]-(g2:Gene)
        WHERE r.score >= $minScore
        WITH gds.graph.project($graphName,g1,g2,{ relationshipProperties: r { .score }, relationshipType: type(r) }, { undirectedRelationshipTypes: ['*'] }) AS graph
        FINISH
        `;
    default:
      return '';
  }
}
