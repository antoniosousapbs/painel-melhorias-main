import { getPool } from './connection.js';

const newTemplate = `Voce e um analista de produto senior. Classifique o chamado de melhoria de software abaixo com base no titulo e na descricao consolidada.

1. Categoria (uma de: Produto | Hibrido | Cliente | Info Insuficiente)
   - Produto: melhoria generica que beneficia qualquer cliente da plataforma
   - Hibrido: parte produto, parte customizacao especifica de cliente
   - Cliente: 100% especifico de um cliente, sem valor de produto generico
   - Info Insuficiente: dados insuficientes para decidir

2. Tipo (um de: UX | RegraNegocio | Relatorio | Integracao | WorkflowAprovacao)

3. Modulo (um de: Cotacao | Pedidos | Fornecedores | Contratos | Aprovacao | Geral | Fiscal)

4. Prioridade sugerida (uma de: Obrigatoria | Alta | Media | Nao priorizar)

5. Impacto na operacao (um de: Alto | Medio | Baixo)

Regras de analise:
- Use a descricao como fonte PRINCIPAL de contexto. O titulo sozinho e superficial.
- Se a descricao menciona regras de negocio especificas de um cliente, classifique como Cliente ou Hibrido.
- Se a descricao descreve fluxos genericos do sistema, classifique como Produto.
- Se a descricao esta vazia ou muito vaga, marque confianca baixa (< 0.5).
- A confianca deve refletir a qualidade da informacao disponivel (0.0 a 1.0).

IMPORTANTE: O campo {{DESCRICAO}} contem o contexto consolidado composto por:
  - Descricao original do chamado
  - Comentarios [PATI] do DevOps (refinamentos e detalhamentos pre-registrados)
Use TODAS as informacoes disponiveis para classificar com precisao. Nao baseie a classificacao apenas no titulo.

Retorne APENAS um JSON valido: {"categoria":"...","tipo":"...","modulo":"...","prioridade":"...","impacto":"...","confianca":0.0}

Titulo: {{TITULO}}
Descricao: {{DESCRICAO}}`;

async function main() {
  const pool = await getPool();
  await pool.request()
    .input('template', newTemplate)
    .query(`UPDATE PromptTemplates SET Template = @template, AtualizadoEm = GETDATE() WHERE Nome = 'classificacao_padrao'`);
  console.log('✅ Prompt template updated');
  await pool.close();
}

main().catch(err => { console.error(err); process.exit(1); });
