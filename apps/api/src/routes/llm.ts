import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { getProviders, addProvider, updateProvider, deleteProvider, testProvider, getUsoConfig, setUsoConfig, type LlmFinalidade } from '../services/llm.js';

const router = Router();

// GET /api/llm-current/:finalidade — label pública (não-sensível) do provider atual de uma
// finalidade, usada só para exibir na UI (ex: legenda do chat da PATi). Disponível para
// qualquer usuário autenticado com acesso ao sistema — não exige papel Admin, e nunca
// retorna URL/chave.
router.get('/llm-current/:finalidade', async (req, res) => {
  try {
    const finalidade = req.params.finalidade as LlmFinalidade;
    const uso = await getUsoConfig();
    const cfg = uso.find(u => u.Finalidade === finalidade);
    res.json({ nome: cfg?.ProviderNome || null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Tudo a partir daqui é restrito a Admin — envolve chaves de API de provedores de LLM.
router.use(requireRole('Admin'));

// GET /api/llm-providers
router.get('/llm-providers', async (_req, res) => {
  try {
    const providers = await getProviders();
    res.json(providers);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/llm-providers
router.post('/llm-providers', async (req, res) => {
  try {
    const { nome, kind, apiUrl, apiKey, modelName, apiVersion, ativo } = req.body;
    if (!nome || !kind || !apiUrl || !apiKey || !modelName) {
      return res.status(400).json({ error: 'nome, kind, apiUrl, apiKey e modelName são obrigatórios' });
    }
    await addProvider({ nome, kind, apiUrl, apiKey, modelName, apiVersion, ativo });
    res.json(await getProviders());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/llm-providers/:id
router.put('/llm-providers/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    await updateProvider(id, req.body);
    res.json(await getProviders());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/llm-providers/:id
router.delete('/llm-providers/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });
    await deleteProvider(id);
    res.json(await getProviders());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/llm-providers/test — testa um provider já salvo (id) ou dados avulsos (kind/apiUrl/apiKey/modelName)
router.post('/llm-providers/test', async (req, res) => {
  try {
    const result = await testProvider(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/llm-uso — atribuição de provider (+fallback) por finalidade
router.get('/llm-uso', async (_req, res) => {
  try {
    res.json(await getUsoConfig());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/llm-uso/:finalidade — { providerId, fallbackProviderId }
router.put('/llm-uso/:finalidade', async (req, res) => {
  try {
    const finalidade = req.params.finalidade as LlmFinalidade;
    const { providerId, fallbackProviderId } = req.body;
    await setUsoConfig(finalidade, providerId ?? null, fallbackProviderId ?? null);
    res.json(await getUsoConfig());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
