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

const FAKE_APF: ApfResult = {
  elementos: [
    { processo: LONG_TEXT, tipo: 'EE', operacao: 'I', td: 5, arTr: 1, complexidade: 'Media', pf: 4, justificativa: LONG_TEXT },
    { processo: 'Processo curto', tipo: 'SE', operacao: 'A', td: 3, arTr: 1, complexidade: 'Baixa', pf: 4, justificativa: 'Curta' },
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
  const buf = await generateApfExcel(FAKE_WI, FAKE_APF, FAKE_PARAMS as any);
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

  console.log('\n🎉 Todas as verificações passaram — template Excel sem regressão.');
  process.exit(0);
}

main().catch(e => { console.error('❌ Erro inesperado:', e); process.exit(1); });
