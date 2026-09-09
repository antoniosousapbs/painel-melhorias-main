import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SpecEstruturada } from './spec-structuring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Uma lista com marcador vira 1 tag só com quebras de linha reais (linebreaks:true no
 * Docxtemplater) — ver limitação de v1 documentada em /memories/repo (1 bullet com quebras
 * internas, não 1 bullet por item; suficiente pro template atual). */
function bulletize(items: string[]): string {
  return items.map(i => `• ${i}`).join('\n');
}

function numerarLista(items: string[]): { numero: number; item: string }[] {
  return items.map((item, i) => ({ numero: i + 1, item }));
}

/** Escopo carrega item + justificativa (ver EscopoItem) — achata em uma única string pra
 * reusar a mesma tabela "# | Item" do template, sem precisar de uma coluna extra. */
function escopoParaTexto(items: { item: string; justificativa: string }[]): string[] {
  return items.map(i => i.justificativa ? `${i.item} — ${i.justificativa}` : i.item);
}

function formatCriterios(criterios: { dado: string; quando: string; entao: string }[]): string {
  if (!criterios.length) return '';
  const bullets = criterios
    .map(c => `• Dado que ${c.dado}, quando ${c.quando}, então ${c.entao}.`)
    .join('\n');
  return `\n\nCritérios de aceite:\n${bullets}`;
}

/** Prefixa a descrição com o parâmetro de entrada do requisito (mesma coluna "Descrição" do
 * template, sem precisar de uma tag/coluna nova). */
function formatEntrada(entrada: string): string {
  return entrada ? `Entrada: ${entrada}\n\n` : '';
}

/** Evita repetir o mesmo ID de regra 2x seguidas quando a LLM já cita o ID dentro do próprio
 * texto de "regraPrincipal" (ex.: "Aplicar RN-001" + regrasRelacionadas=["RN-001"] geraria
 * "Aplicar RN-001 (Regras relacionadas: RN-001)" — só acrescenta os IDs ainda não citados). */
function formatRegraPrincipal(regraPrincipal: string, regrasRelacionadas: string[]): string {
  const idsNovos = regrasRelacionadas.filter(id => !regraPrincipal.includes(id));
  if (!idsNovos.length) return regraPrincipal;
  return `${regraPrincipal} (Regras relacionadas: ${idsNovos.join(', ')})`;
}

/**
 * Converte o modelo interno (SpecEstruturada) no formato "achatado" esperado pelas tags do
 * template `Modelo_Especificacao_Negocio.docx` (ver nomes das tags documentados em
 * /memories/repo — não são os mesmos nomes de campo do modelo interno de propósito, pra
 * manter o modelo interno livre pra evoluir sem depender da estrutura exata do template).
 */
export function mapEstruturadaParaTags(spec: SpecEstruturada, extras: { produto?: string; status?: string }): Record<string, unknown> {
  const versaoAtual = spec.versionamento[spec.versionamento.length - 1];
  return {
    demanda_titulo: `#${spec.demanda.workItemId} - ${spec.demanda.titulo}`,
    produto: extras.produto || spec.demanda.modulo || 'N/A',
    cliente: spec.demanda.cliente || 'N/A',
    autor: versaoAtual?.autor || 'Equipe Paradigma',
    versaoAtual: versaoAtual?.versao || '1.0',
    dataAtual: versaoAtual?.data || new Date().toLocaleDateString('pt-BR'),
    status: extras.status || 'Elaborado com base nas informações coletadas junto ao cliente',

    versionamento: spec.versionamento,
    historicoAlteracoes: spec.historicoAlteracoes,
    resumoResultadoEsperado: spec.resumoResultadoEsperado,
    usuariosImpactados: spec.usuariosImpactados,
    objetivo: spec.objetivo,
    contextoNegocioIntro: spec.contextoNegocio.intro,
    comoFuncionaHoje: bulletize(spec.contextoNegocio.comoFuncionaHoje),
    problemaAtual: spec.problemaAtual,
    beneficiosEsperados: spec.beneficiosEsperados,
    stakeholders: spec.stakeholders,
    escopoIncluido: numerarLista(escopoParaTexto(spec.escopo.incluido)),
    escopoExcluido: numerarLista(escopoParaTexto(spec.escopo.excluido)),
    premissasLista: numerarLista(spec.premissas),
    restricoesLista: numerarLista(spec.restricoes),
    fluxoResumidoAtual: bulletize(spec.processoAtual.fluxoResumido),
    gargalosRiscos: spec.processoAtual.gargalosRiscos,
    processoFuturoIntro: spec.processoFuturo.intro,
    fluxoProcessoFuturo: bulletize(spec.processoFuturo.fluxo),
    comparativoProcessos: spec.comparativoProcessos,
    requisitosFuncionais: spec.requisitosFuncionais.map(r => ({
      id: r.id,
      titulo: r.titulo,
      prioridade: r.prioridade,
      descricao: formatEntrada(r.entrada) + r.descricao + formatCriterios(r.criteriosAceite),
      regraPrincipal: formatRegraPrincipal(r.regraPrincipal, r.regrasRelacionadas),
      beneficio: r.beneficio,
    })),
    regrasNegocio: spec.regrasNegocio,
    matrizRiscos: spec.matrizRiscos,
    glossario: spec.glossario,
  };
}

/**
 * Etapa 6 do pipeline (Geração do documento) — SEM LLM, só mapeamento de dados + preenchimento
 * do template via docxtemplater. Template oficial: templates/Modelo_Especificacao_Negocio.docx
 * (tagueado a partir do modelo de referência fornecido pelo usuário — ver /memories/repo).
 */
export async function generateSpecDocx(spec: SpecEstruturada, extras: { produto?: string; status?: string } = {}): Promise<Buffer> {
  const templatePath = resolve(__dirname, '../../templates', 'Modelo_Especificacao_Negocio.docx');
  const templateBuf = readFileSync(templatePath);
  const zip = new PizZip(templateBuf);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

  const data = mapEstruturadaParaTags(spec, extras);
  doc.render(data);

  return doc.getZip().generate({ type: 'nodebuffer' });
}
