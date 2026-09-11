/**
 * Guarda de regressão do template Excel de APF (Modelo APF.xlsx).
 *
 * Roda a geração do Excel com dados 100% SINTÉTICOS (nenhum WorkItemId real é
 * tocado) e valida as correções que já foram feitas e que NÃO PODEM voltar a
 * quebrar silenciosamente:
 *
 *   1. Logo do template é byte-a-byte idêntico ao arquivo oficial armazenado em
 *      templates/assets/logo-paradigma-original.png (não pode virar azul sólido,
 *      esticar, ou trocar de arquivo).
 *   2. Campo "Projeto"/"Aplicação" (sheet2 B7, sheet1 G6/G7) reflete os dados do
 *      chamado passado como argumento — não pode ficar fixo/hardcoded.
 *   3. Altura da linha (sheet2) escala com o tamanho do texto do elemento — uma
 *      justificativa longa não pode ficar com a linha na altura mínima (15).
 *
 * Rode após qualquer alteração em generateApfExcel() ou no arquivo do template:
 *   npx tsx src/db/verify-excel-template.ts
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';
import { generateApfExcel, type ApfResult } from '../services/document-generator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FAKE_WI = {
  Id: 999999,
  Title: 'Verificação sintética de template — não é um chamado real',
  ClienteNome: 'Cliente Teste Guarda',
  Modulo: 'Módulo Teste Guarda',
  DevOpsAreaPath: 'Improvements\\ModuloTesteGuarda',
};

const LONG_TEXT =
  'Justificativa propositalmente longa para validar que a linha da planilha expande ' +
  'corretamente quando o texto quebra em múltiplas linhas dentro da célula, cobrindo ' +
  'o cenário que antes ficava com o conteúdo cortado visualmente até redimensionamento manual.';

const JUSTIFICATIVA_NEGOCIO = 'Permite que o time comercial acompanhe pedidos em andamento sem depender de outra equipe para consultar o status.';
const FAKE_APF: ApfResult = {
  elementos: [
    { processo: LONG_TEXT, tipo: 'EE', operacao: 'I', td: 5, arTr: 1, complexidade: 'Media', pf: 4, justificativa: LONG_TEXT, justificativaNegocio: JUSTIFICATIVA_NEGOCIO },
    { processo: 'Processo curto', tipo: 'SE', operacao: 'A', td: 3, arTr: 1, complexidade: 'Baixa', pf: 4, justificativa: 'Curta', justificativaNegocio: 'Complemento de negócio curto.' },
  ],
  totalPF: 8,
  totalPFA: 8,
  totalHoras: 40,
  horasDetalhamento: { gestao: 4, analiseNegocio: 8, analiseTestes: 8, codificacao: 12, execucaoTestes: 4, homologacao: 4 },
};

const FAKE_PARAMS = {
  Produtividade: 10,
  DeflatorInclusao: 1,
  DeflatorAlteracao: 0.6,
  DeflatorExclusao: 0.4,
  CicloGestao: 10,
  CicloAnaliseNegocio: 15,
  CicloAnaliseTestes: 15,
  CicloCodificacao: 40,
  CicloExecucaoTestes: 10,
  CicloHomologacao: 10,
};

function fail(msg: string): never {
  console.error(`❌ FALHOU: ${msg}`);
  process.exit(1);
}

async function main() {
  console.log('🔎 Gerando Excel com dados sintéticos (nenhum WorkItemId real é usado)...');
  const FAKE_SINTESE = {
    oQueFoiPedido: 'O analista solicitou permitir consultar pedidos por ID e aprovar automaticamente pedidos de baixo valor.',
    oQueFoiEntendido: 'Entendido que a consulta deve retornar os dados essenciais do pedido e que a aprovação automática se aplica somente a pedidos abaixo de um valor configurável.',
    oQueFoiProjetado: 'Extensão da tela de consulta existente mais uma nova regra de negócio de aprovação automática integrada ao fluxo atual.',
    motivoContagem: 'Contado como uma Consulta Externa de alteração e uma Entrada Externa de inclusão, sem novos ALIs pois reaproveita a estrutura de dados já existente.',
  };
  const buf = await generateApfExcel(FAKE_WI, FAKE_APF, FAKE_PARAMS as any, FAKE_SINTESE);
  const zip = await JSZip.loadAsync(buf);

  // ── 1. Logo idêntico ao asset oficial ──
  const logoAssetPath = resolve(__dirname, '../../templates/assets/logo-paradigma-original.png');
  const officialLogo = readFileSync(logoAssetPath);
  const embeddedLogo = await zip.file('xl/media/image1.png')!.async('nodebuffer');
  if (!officialLogo.equals(embeddedLogo)) {
    fail(`Logo embutido no Excel gerado difere byte-a-byte do asset oficial (${logoAssetPath}).`);
  }
  console.log('✅ Logo idêntico ao asset oficial.');

  // ── 2. Projeto/Aplicação/Cliente refletem os dados sintéticos passados ──
  const sheet1 = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  const sheet2 = await zip.file('xl/worksheets/sheet2.xml')!.async('string');
  const sharedStrings = await zip.file('xl/sharedStrings.xml')!.async('string');

  function sharedStringValues(): string[] {
    return [...sharedStrings.matchAll(/<si>(?:<t[^>]*>([^<]*)<\/t>|<r>.*?<\/r>)<\/si>/gs)].map(m => m[1] ?? '');
  }
  const strings = sharedStringValues();
  const fullXml = sheet1 + sheet2 + sharedStrings;

  if (!fullXml.includes(FAKE_WI.ClienteNome)) fail('Nome do cliente sintético não apareceu no Excel gerado (campo pode estar hardcoded).');
  if (!fullXml.includes(FAKE_WI.Modulo)) fail('Módulo/Aplicação sintético não apareceu no Excel gerado (campo pode estar hardcoded).');
  if (!fullXml.includes(String(FAKE_WI.Id))) fail('Id do chamado sintético não apareceu no Excel gerado (Projeto pode estar hardcoded).');
  console.log('✅ Projeto/Aplicação/Cliente refletem os dados dinâmicos passados (não hardcoded).');
  void strings;

  // ── 3. Altura de linha escala com texto longo ──
  const row11Match = sheet2.match(/<row r="11"[^>]*\sht="([\d.]+)"/);
  const row12Match = sheet2.match(/<row r="12"[^>]*\sht="([\d.]+)"/);
  const ht11 = row11Match ? parseFloat(row11Match[1]) : 15;
  const ht12 = row12Match ? parseFloat(row12Match[1]) : 15;
  if (!(ht11 > ht12)) fail(`Linha com texto longo (ht=${ht11}) não ficou maior que a linha com texto curto (ht=${ht12}).`);
  if (!(ht11 > 15)) fail(`Linha com texto longo (ht=${ht11}) não escalou acima da altura mínima padrão (15).`);
  console.log(`✅ Altura de linha escala com o texto (linha longa=${ht11}, linha curta=${ht12}).`);

  // ── 4. Colunas de valores (D..Q) ficam alinhadas ao meio (vertical=center) nas linhas 11-20 ──
  const styles = await zip.file('xl/styles.xml')!.async('string');
  const cellXfsBody = styles.match(/<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/)![1];
  const xfs = cellXfsBody.split(/(?=<xf )/).filter(s => s.trim().length > 0);
  const colunasAlinhadas = ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'];
  for (const col of colunasAlinhadas) {
    for (const row of [11, 15, 20]) {
      const m = sheet2.match(new RegExp(`<c r="${col}${row}" s="(\\d+)"`));
      if (!m) fail(`Célula ${col}${row} não encontrada no sheet2 gerado.`);
      const xf = xfs[parseInt(m![1])];
      if (!xf || !/vertical="center"/.test(xf)) fail(`Coluna ${col} linha ${row} não está com vertical="center" (estilo s="${m![1]}").`);
    }
  }
  console.log('✅ Colunas de valores (D..Q) alinhadas ao meio (vertical=center) nas linhas 11-20.');

  // ── 5. Nova aba "Memória de Cálculo" existe e tem conteúdo (resumo executivo + elementos + ciclo) ──
  const sheet5 = await zip.file('xl/worksheets/sheet5.xml')?.async('string');
  if (!sheet5) fail('xl/worksheets/sheet5.xml (Memória de Cálculo) não foi criado no Excel gerado.');
  if (!sheet5!.includes('RESUMO EXECUTIVO DA ANÁLISE')) fail('Seção de resumo executivo não apareceu na aba Memória de Cálculo.');
  for (const rotulo of ['O QUE FOI SOLICITADO', 'O QUE FOI ENTENDIDO', 'SOLUÇÃO PROJETADA', 'RACIONAL DA CONTAGEM']) {
    if (!sheet5!.includes(rotulo)) fail(`Rótulo "${rotulo}" não apareceu no resumo executivo da Memória de Cálculo.`);
  }
  if (!sheet5!.includes(FAKE_SINTESE.oQueFoiPedido)) fail('Texto da síntese (oQueFoiPedido) não apareceu na aba Memória de Cálculo.');
  if (sheet5!.includes('PATi:') || sheet5!.includes('Analista:')) fail('Transcript cru de entrevista (formato de diálogo) vazou pra dentro da aba Memória de Cálculo.');
  if (!sheet5!.includes(LONG_TEXT)) fail('Nome do processo elementar (texto longo) não apareceu na aba Memória de Cálculo.');
  if (sheet5!.includes('Justificativa completa')) fail('Coluna "Justificativa completa" ainda aparece na tabela de elementos — deveria ter sido removida (racional já fica no Resumo Executivo).');
  if (!sheet5!.includes('SUBTOTAL POR TIPO DE FUNÇÃO')) fail('Seção de subtotal por tipo de função não apareceu na aba Memória de Cálculo.');
  if (!sheet5!.includes('MATRIZ DE COMPLEXIDADE IFPUG')) fail('Seção de matriz de complexidade IFPUG (referência) não apareceu na aba Memória de Cálculo.');
  if (!sheet5!.includes('LEGENDA DE SIGLAS')) fail('Seção de legenda de siglas não apareceu na aba Memória de Cálculo.');
  if (sheet5!.includes('DISTRIBUIÇÃO DE HORAS POR CICLO PRODUTIVO')) fail('Seção redundante "Distribuição de Horas por Ciclo Produtivo" voltou a aparecer — já existe na aba Contagem, deveria ter sido removida da Memória de Cálculo.');
  console.log('✅ Aba "Memória de Cálculo" criada com resumo executivo estruturado (sem transcript cru) e conteúdo esperado.');

  // ── 5a⁰. Relação de elementos SEM os dados técnicos redundantes (já na aba Funções), COM
  // justificativa de negócio por item ──
  if (sheet5!.includes('DETALHAMENTO POR ELEMENTO FUNCIONAL')) fail('Seção antiga "Detalhamento por Elemento Funcional" (com colunas técnicas redundantes) ainda aparece — deveria ter virado "Relação de Elementos Funcionais".');
  if (!sheet5!.includes('RELAÇÃO DE ELEMENTOS FUNCIONAIS')) fail('Seção "Relação de Elementos Funcionais" não apareceu na aba Memória de Cálculo.');
  if (!sheet5!.includes('Justificativa de Negócio')) fail('Cabeçalho "Justificativa de Negócio" não apareceu na tabela de elementos.');
  if (!sheet5!.includes(JUSTIFICATIVA_NEGOCIO)) fail('Texto da justificativa de negócio do elemento não apareceu na aba Memória de Cálculo.');
  console.log('✅ Relação de elementos simplificada (sem colunas técnicas redundantes) com justificativa de negócio por item.');

  // ── 5a. Logo da Paradigma embutido na aba nova (mesma imagem oficial, partes próprias) ──
  const drawing5 = await zip.file('xl/drawings/drawing5.xml')?.async('string');
  if (!drawing5) fail('xl/drawings/drawing5.xml (logo da Memória de Cálculo) não foi criado.');
  const sheet5Rels = await zip.file('xl/worksheets/_rels/sheet5.xml.rels')?.async('string');
  if (!sheet5Rels || !sheet5Rels.includes('drawing5.xml')) fail('sheet5.xml.rels não referencia drawing5.xml — o logo não ficaria visível.');
  if (!sheet5!.includes('<drawing r:id=')) fail('sheet5.xml não tem a tag <drawing> — o Excel não vai carregar a imagem.');
  const drawing5Rels = await zip.file('xl/drawings/_rels/drawing5.xml.rels')?.async('string');
  if (!drawing5Rels || !drawing5Rels.includes('../media/image1.png')) fail('drawing5.xml.rels não aponta pra image1.png (mesma logo das outras abas).');
  console.log('✅ Logo da Paradigma embutido na aba "Memória de Cálculo".');

  // ── 5a¹. Logo é o PRIMEIRO elemento do cabeçalho (ancorada na coluna B, linhas 2-3 — igual às
  // outras abas), não sobrepondo o título ──
  if (!/<xdr:from><xdr:col>1<\/xdr:col>.*?<xdr:row>1<\/xdr:row>/.test(drawing5!)) fail('Logo não está ancorada na coluna B / linha 2 — deveria ser o primeiro elemento do cabeçalho, igual às outras abas.');
  console.log('✅ Logo posicionada como primeiro elemento do cabeçalho (coluna B, linhas 2-3).');

  // ── 5a². Gridlines padrão desabilitadas (aspecto de "página em branco", não de planilha) ──
  if (!sheet5!.includes('showGridLines="0"')) fail('Aba Memória de Cálculo ainda mostra as gridlines padrão do Excel — deveria parecer uma página em branco.');
  console.log('✅ Gridlines padrão desabilitadas (aspecto de página em branco).');

  // ── 5b. Aba nova tem estilo aplicado (título mesclado a partir da coluna C — B fica livre pra
  // logo — células com s="") ──
  if (!/<c r="C2" s="\d+"/.test(sheet5!)) fail('Célula de título (C2) da aba Memória de Cálculo não tem estilo aplicado.');
  if (!sheet5!.includes('<mergeCell ref="C2:')) fail('Título não está mesclado a partir da coluna C (deveria deixar a coluna B livre pra logo).');
  console.log('✅ Aba nova com estilo aplicado (título mesclado a partir de C, logo livre em B).');

  // ── 5b¹. Layout lado a lado (chip na coluna C + card mesclado D:última) no Resumo Executivo ──
  if (!/<mergeCell ref="D\d+:[A-Z]+\d+"\/>/.test(sheet5!)) fail('Nenhuma célula mesclada D:última coluna encontrada — o layout lado a lado (chip+card) do Resumo Executivo pode não ter sido aplicado.');
  console.log('✅ Layout lado a lado (chip + card) aplicado no Resumo Executivo.');

  // ── 5c. "Auditoria da Comunicação" NÃO é mais uma aba do Excel (virou PDF à parte) ──
  const sheet6Removed = await zip.file('xl/worksheets/sheet6.xml');
  if (sheet6Removed) fail('xl/worksheets/sheet6.xml (antiga aba de Auditoria) ainda existe — deveria ter sido removida (Auditoria virou PDF).');
  console.log('✅ Aba "Auditoria da Comunicação" não existe mais no Excel (migrada pro PDF).');

  // ── 6. Wiring da nova aba no workbook (senão o Excel não reconhece a sheet nova) ──
  const contentTypes = await zip.file('[Content_Types].xml')!.async('string');
  const wbRels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  const workbook = await zip.file('xl/workbook.xml')!.async('string');
  if (!contentTypes.includes('/xl/worksheets/sheet5.xml')) fail('[Content_Types].xml não registra a nova aba sheet5.xml.');
  if (!contentTypes.includes('/xl/drawings/drawing5.xml')) fail('[Content_Types].xml não registra drawing5.xml (logo da Memória de Cálculo).');
  if (contentTypes.includes('/xl/worksheets/sheet6.xml')) fail('[Content_Types].xml ainda registra sheet6.xml (deveria ter sido removido junto com a Auditoria).');
  if (!wbRels.includes('worksheets/sheet5.xml')) fail('workbook.xml.rels não registra a nova aba sheet5.xml.');
  if (wbRels.includes('worksheets/sheet6.xml')) fail('workbook.xml.rels ainda registra sheet6.xml (deveria ter sido removido).');
  if (!workbook.includes('Memória de Cálculo')) fail('workbook.xml não lista a nova aba "Memória de Cálculo".');
  if (workbook.includes('Auditoria da Comunicação')) fail('workbook.xml ainda lista "Auditoria da Comunicação" (deveria ter sido removida do Excel).');
  console.log('✅ Nova aba corretamente registrada em workbook.xml/rels/[Content_Types].xml, sem resquício da antiga Auditoria.');

  // ── 7. Aba "TFS" (vazia, órfã, pedido do usuário) foi removida do pacote e de todo o wiring ──
  const sheet4Removed = await zip.file('xl/worksheets/sheet4.xml');
  if (sheet4Removed) fail('xl/worksheets/sheet4.xml (aba TFS) ainda existe no Excel gerado — deveria ter sido removida.');
  if (workbook.includes('name="TFS"')) fail('workbook.xml ainda lista a aba "TFS" — deveria ter sido removida.');
  if (contentTypes.includes('/xl/worksheets/sheet4.xml')) fail('[Content_Types].xml ainda registra sheet4.xml (TFS) — deveria ter sido removido.');
  if (wbRels.includes('worksheets/sheet4.xml')) fail('workbook.xml.rels ainda registra sheet4.xml (TFS) — deveria ter sido removido.');
  console.log('✅ Aba "TFS" (vazia, órfã) removida do pacote e de todo o wiring.');

  console.log('\n🎉 Todas as verificações passaram — template Excel sem regressão.');
  process.exit(0);
}

main().catch(e => { console.error('❌ Erro inesperado:', e); process.exit(1); });
