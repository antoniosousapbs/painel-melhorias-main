/**
 * Guarda de regressão para o TEMPLATE (não a geração) — detecta se sobrou (ou voltou a
 * sobrar, após uma edição manual no Word) algum texto ESTÁTICO específico do caso de
 * exemplo original de referência (Modelo_EN_v2 - Laone Revisor.docx, "Motor Inteligente de
 * Aprovação de Contratos"). Complementa o verify-spec-docx.ts (que valida a GERAÇÃO com
 * dados sintéticos, mas não pega texto estático do template que nunca foi tagueado —
 * foi exatamente esse tipo de lacuna que passou despercebido até um usuário notar o
 * título da capa estático num documento gerado de verdade).
 *
 * Rode após qualquer edição manual do template (ex.: retoque visual no Word):
 *   npx tsx src/db/verify-template-generic.ts
 */
import JSZip from 'jszip';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, '../../templates', 'Modelo_Especificacao_Negocio.docx');

// Termos que só existem porque vieram do caso de exemplo original — se aparecerem como
// texto ESTÁTICO (fora de qualquer tag {...}) em qualquer parte do pacote, é sinal de que
// uma seção ficou esquecida sem tag (ex.: título decorativo da capa, frase de introdução
// de alguma seção). Lista não é exaustiva por natureza — ver seção "Como manter" abaixo.
const BANNED_STATIC_TERMS = [
  'Motor Inteligente', 'Motor de Aprovação', 'Aprovação de Contratos', 'Smart Approval',
  'GlobalTech', 'DocuSign', 'Alçada Financeira', 'Workflow de Aprovação',
  'Contrato de serviços no valor de', 'capítulo 17',
];

const FILES_TO_CHECK = [
  'word/document.xml',
  'word/header1.xml', 'word/header2.xml',
  'word/footer1.xml', 'word/footer2.xml', 'word/footer3.xml',
];

async function main() {
  const buf = readFileSync(TEMPLATE_PATH);
  const zip = await JSZip.loadAsync(buf);

  const problems: string[] = [];

  for (const path of FILES_TO_CHECK) {
    const file = zip.file(path);
    if (!file) continue;
    const xml = await file.async('string');
    const texts = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).filter(t => t.trim());
    for (const term of BANNED_STATIC_TERMS) {
      const hits = texts.filter(t => t.includes(term));
      if (hits.length > 0) {
        problems.push(`[${path}] termo específico do exemplo original ainda estático: "${term}" em ${JSON.stringify(hits)}`);
      }
    }
  }

  // Sanity extra: a capa DEVE conter as tags dinâmicas (nunca texto fixo no lugar delas).
  // Word costuma quebrar uma tag em vários <w:t> (runs separados) após qualquer edição manual
  // (ex.: "{demanda_titulo}" vira "{" + "demanda_" + "titulo" + "}" em runs distintos) — o
  // docxtemplater concatena todo o texto antes de procurar tags, então isso NÃO quebra a
  // geração real (ver verify-spec-docx.ts), mas quebraria uma checagem ingênua de substring
  // na string XML crua. Por isso concatenamos só o conteúdo de <w:t> (ignorando a estrutura
  // de runs/parágrafos) antes de checar, do mesmo jeito que o docxtemplater enxerga o texto.
  const documentXml = await zip.file('word/document.xml')!.async('string');
  const flattenedText = [...documentXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join('');
  for (const requiredTag of ['{demanda_titulo}', '{produto}', '{cliente}', '{autor}', '{versaoAtual}', '{dataAtual}', '{status}']) {
    if (!flattenedText.includes(requiredTag)) {
      problems.push(`Tag obrigatória da capa ausente: ${requiredTag}`);
    }
  }

  if (problems.length > 0) {
    console.error('❌ Template tem texto estático específico do exemplo original (ou perdeu uma tag da capa):\n');
    problems.forEach(p => console.error('  - ' + p));
    console.error('\nCorrija tagueando ou generalizando o texto encontrado, e rode este script de novo.');
    process.exit(1);
  }

  console.log('✅ Nenhum texto estático específico do exemplo original encontrado. Tags da capa OK.');
}

main().catch(err => {
  console.error('❌ Guarda de regressão do template FALHOU:', err.message);
  process.exit(1);
});
