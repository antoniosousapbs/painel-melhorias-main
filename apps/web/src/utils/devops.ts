/** Monta a URL do work item no Azure DevOps a partir do AreaPath real do chamado — o projeto
 * (segmento antes da primeira barra invertida, ex.: "SRM.wbc7srm\Suporte" -> "SRM.wbc7srm") pode
 * variar (SRM.wbc7srm, Public.Wbc7, UFO.ETRM), nunca deve ser fixo pra todos os chamados. */
export function getDevOpsWorkItemUrl(id: number, devOpsAreaPath?: string | null): string {
  const project = devOpsAreaPath?.split('\\')[0]?.trim() || 'SRM.wbc7srm';
  return `https://dev.azure.com/pbs-devops/${project}/_workitems/edit/${id}`;
}
