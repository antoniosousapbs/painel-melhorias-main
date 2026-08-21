/**
 * Guarda de regressão do template Word de Especificação de Negócio
 * (templates/Modelo_Especificacao_Negocio.docx).
 *
 * Roda a geração do .docx com dados 100% SINTÉTICOS (nenhum WorkItemId real é
 * tocado, nenhuma chamada de LLM é feita) e valida que:
 *
 *   1. O documento gerado é um .docx válido (abre sem erro no docxtemplater/JSZip).
 *   2. Não sobra nenhuma tag `{...}` sem substituir no XML final.
 *   3. O loop de Requisitos Funcionais (tabela única, whole-table loop) repete
 *      corretamente para múltiplos itens — cada requisito gera sua própria tabela
 *      com os dados corretos (regressão do bug de "13 tabelas separadas").
 *   4. Todos os demais loops (versionamento, stakeholders, escopo, regras, riscos,
 *      glossário etc.) também renderizam sem lançar exceção.
 *
 * Rode após qualquer alteração em generateSpecDocx()/mapEstruturadaParaTags() ou no
 * arquivo do template:
 *   npx tsx src/db/verify-spec-docx.ts
 */
import JSZip from 'jszip';
import { generateSpecDocx } from '../services/spec-docx-generator.js';
import type { SpecEstruturada } from '../services/spec-structuring.js';

const FAKE_SPEC: SpecEstruturada = {
  demanda: { workItemId: 999999, titulo: 'Verificação sintética de template — não é um chamado real', cliente: 'Cliente Teste Guarda', modulo: 'Módulo Teste Guarda' },
  objetivo: 'Validar que o template Word gera corretamente todos os loops e tags a partir de dados sintéticos.',
  resumoResultadoEsperado: 'Documento .docx sem tags residuais e com tabelas de requisitos repetidas corretamente.',
  usuariosImpactados: 'Analistas de negócio e equipe de desenvolvimento.',
  contextoNegocio: { intro: 'Contexto de negócio sintético para fins de verificação.', comoFuncionaHoje: ['Hoje o processo é manual.', 'Não há rastreabilidade automática.'] },
  problemaAtual: [{ problema: 'Falta de padronização', descricao: 'Cada analista documenta de um jeito.' }],
  beneficiosEsperados: [{ beneficio: 'Padronização', impacto: 'Reduz retrabalho.' }],
  stakeholders: [{ perfil: 'Analista de Negócio', papel: 'Levantar requisitos' }, { perfil: 'Desenvolvedor', papel: 'Implementar' }],
  escopo: {
    incluido: [{ item: 'Geração automática de especificação', justificativa: 'Núcleo da demanda solicitada.' }],
    excluido: [{ item: 'Geração automática de código', justificativa: 'Fora do pedido original — só documentação.' }],
  },
  premissas: ['O chamado possui descrição mínima.'],
  restricoes: ['Não altera o fluxo de APF existente.'],
  processoAtual: {
    fluxoResumido: ['Analista recebe o chamado.', 'Analista escreve a especificação manualmente.'],
    gargalosRiscos: [{ item: 'Inconsistência', descricao: 'Documentos com estrutura diferente entre analistas.' }],
  },
  processoFuturo: { intro: 'Processo futuro sintético.', fluxo: ['PATi estrutura a demanda.', 'PATi gera o documento Word.'] },
  comparativoProcessos: [{ processo: 'Documentação', situacaoAtual: 'Manual', novaSituacao: 'Assistida por IA' }],
  requisitosFuncionais: [
    {
      id: 'F-001', titulo: 'Requisito de Teste Um', prioridade: 'Must Have',
      descricao: 'Descrição sintética do requisito um.', regraPrincipal: 'Regra principal um.', beneficio: 'Benefício um.',
      origem: 'CONFIRMADO', regrasRelacionadas: ['RN-001'],
      criteriosAceite: [{ dado: 'um contexto', quando: 'uma ação ocorre', entao: 'um resultado esperado acontece' }],
    },
    {
      id: 'F-002', titulo: 'Requisito de Teste Dois', prioridade: 'Should Have',
      descricao: 'Descrição sintética do requisito dois.', regraPrincipal: 'Regra principal dois.', beneficio: 'Benefício dois.',
      origem: 'INFERIDO', regrasRelacionadas: [],
      criteriosAceite: [],
    },
  ],
  regrasNegocio: [{ id: 'RN-001', nome: 'Regra Sintética', descricao: 'Descrição da regra sintética.', impacto: 'Médio' }],
  matrizRiscos: [{ risco: 'Atraso', probabilidade: 'Baixa', impacto: 'Médio', mitigacao: 'Planejamento antecipado', responsavel: 'PM' }],
  glossario: [{ termo: 'APF', definicao: 'Análise de Pontos de Função' }],
  pendencias: [{ descricao: 'Confirmar SLA com o cliente.', criticidade: 'media' }],
  versionamento: [{ versao: '1.0', data: new Date().toLocaleDateString('pt-BR'), autor: 'Guarda de Regressão', descricao: 'Geração sintética de verificação.' }],
  historicoAlteracoes: [{ area: 'Verificação', alteracao: 'Documento gerado pelo script de guarda de regressão.' }],
};

async function main() {
  console.log('🔎 Gerando .docx sintético a partir do template...');
  const buffer = await generateSpecDocx(FAKE_SPEC, { produto: FAKE_SPEC.demanda.modulo, status: 'Rascunho' });

  if (!buffer || buffer.length === 0) throw new Error('Buffer gerado está vazio.');
  console.log(`✅ Buffer gerado: ${buffer.length} bytes`);

  // Reabre o .docx gerado e inspeciona o XML final
  const zip = await JSZip.loadAsync(buffer);
  const documentXmlFile = zip.file('word/document.xml');
  if (!documentXmlFile) throw new Error('word/document.xml não encontrado no .docx gerado — arquivo corrompido.');
  const documentXml = await documentXmlFile.async('string');

  // 1) Nenhuma tag {...} residual (docxtemplater usa chaves simples {tag})
  const leftoverTags = documentXml.match(/\{[a-zA-Z_][\w.]*\}/g);
  if (leftoverTags) {
    throw new Error(`Tags residuais encontradas no documento gerado: ${[...new Set(leftoverTags)].join(', ')}`);
  }
  console.log('✅ Nenhuma tag {...} residual encontrada.');

  // 2) O conteúdo dos dois requisitos sintéticos deve aparecer distintamente no XML
  //    (valida que o whole-table loop de Requisitos Funcionais repete corretamente).
  for (const req of FAKE_SPEC.requisitosFuncionais) {
    if (!documentXml.includes(req.id)) throw new Error(`ID do requisito "${req.id}" não encontrado no documento gerado.`);
    if (!documentXml.includes(req.titulo)) throw new Error(`Título do requisito "${req.titulo}" não encontrado no documento gerado.`);
  }
  console.log(`✅ Loop de Requisitos Funcionais renderizou corretamente ${FAKE_SPEC.requisitosFuncionais.length} itens distintos.`);

  // 3) Sanity check de outros loops/textos simples
  const mustContain = [
    FAKE_SPEC.demanda.titulo,
    FAKE_SPEC.objetivo,
    FAKE_SPEC.regrasNegocio[0].nome,
    FAKE_SPEC.glossario[0].termo,
  ];
  for (const text of mustContain) {
    if (!documentXml.includes(text)) throw new Error(`Texto esperado não encontrado no documento gerado: "${text}"`);
  }
  console.log('✅ Textos simples e demais seções renderizaram corretamente.');

  console.log('\n🎉 Guarda de regressão do template de Especificação (Word) passou sem erros.');
}

main().catch(err => {
  console.error('❌ Guarda de regressão FALHOU:', err.message);
  process.exit(1);
});
