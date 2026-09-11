import { useEffect, useState, useCallback } from 'react';
import { fetchWorkItems, fetchFilters } from '../services/api';
import MultiSelect from '../components/MultiSelect';
import DocHistoryDrawer from '../components/DocHistoryDrawer';
import { STATUS_LABELS } from './Dashboard';
import { getDevOpsWorkItemUrl } from '../utils/devops';
import type { FilterOptions } from '../types';

interface HistoricoItem {
  Id: number;
  Title: string;
  ClienteNome: string | null;
  Categoria: string | null;
  Modulo: string | null;
  AssignedTo: string | null;
  SupportCaseStatus: string | null;
  EsforcoAPF: number | null;
  ChangedDate: string | null;
  DevOpsAreaPath: string | null;
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

const PAGE_SIZE = 50;

/** Histórico de chamados de melhoria já ENCERRADOS (DevOpsState='Closed') que tiveram
 * alguma interação (APF/Especificação gerada) — visível para todos os perfis (Admin e
 * Operador), sem restrição de RequireRole. Se um chamado for REABERTO no DevOps, o sync
 * atualiza DevOpsState automaticamente e ele some daqui sozinho (esta tela filtra
 * estritamente DevOpsState='Closed') e volta a aparecer no Dashboard principal. */
export default function Historico() {
  const [items, setItems] = useState<HistoricoItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const [docDrawer, setDocDrawer] = useState<{ id: number; title: string } | null>(null);

  // Mesmos filtros da página principal (Dashboard), escopados só ao conjunto do Histórico
  const [search, setSearch] = useState('');
  const [selClientes, setSelClientes] = useState<string[]>([]);
  const [selCategoria, setSelCategoria] = useState<string[]>([]);
  const [selStatus, setSelStatus] = useState<string[]>([]);
  const [selResponsavel, setSelResponsavel] = useState<string[]>([]);

  useEffect(() => { fetchFilters({ encerrados: true }).then(setFilterOptions).catch(console.error); }, []);

  const load = useCallback(async (p = 1) => {
    setLoading(true);
    try {
      const data = await fetchWorkItems({
        page: p,
        size: PAGE_SIZE,
        encerrados: 'true',
        search,
        cliente: selClientes.join(','),
        categoria: selCategoria.join(','),
        status: selStatus.join(','),
        responsavel: selResponsavel.join(','),
      });
      setItems(data.items);
      setTotal(data.total);
      setPage(p);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [search, selClientes, selCategoria, selStatus, selResponsavel]);

  useEffect(() => { load(1); }, [load]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const anyFilterActive = !!(search || selClientes.length || selCategoria.length || selStatus.length || selResponsavel.length);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-[18px] font-semibold text-txt">Histórico de Chamados Encerrados</h2>
          <p className="text-[13px] text-txt-3 mt-0.5">Chamados de melhoria já finalizados com APF/Especificação gerada em algum momento</p>
        </div>
        <span className="text-[13px] text-txt-3">{total} registro{total !== 1 ? 's' : ''}</span>
      </div>

      {/* Filters — mesmos filtros da página principal, escopados aos chamados encerrados */}
      <div className="bg-surface border border-border rounded-[10px] p-4 flex flex-wrap gap-2 items-center">
        <input
          type="text"
          placeholder="Buscar por ID, título..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="h-9 w-[160px] border border-border rounded-sm px-3 text-[13px] bg-bg focus-ring"
        />
        <MultiSelect label="Cliente" options={filterOptions?.clientes || []} selected={selClientes} onChange={setSelClientes} />
        <MultiSelect label="Categoria" options={filterOptions?.categorias || []} selected={selCategoria} onChange={setSelCategoria} />
        <MultiSelect label="Status" options={filterOptions?.estados || []} selected={selStatus} onChange={setSelStatus} displayFn={v => STATUS_LABELS[v] || v} />
        <MultiSelect label="Responsável" options={filterOptions?.responsaveis || []} selected={selResponsavel} onChange={setSelResponsavel} />
        {anyFilterActive && (
          <button
            onClick={() => { setSearch(''); setSelClientes([]); setSelCategoria([]); setSelStatus([]); setSelResponsavel([]); }}
            className="h-9 px-3 text-[12px] font-medium rounded-sm border border-[#6366f1]/60 text-[#4f46e5] bg-[#6366f108] hover:bg-[#6366f115] transition-colors"
          >
            × Limpar
          </button>
        )}
      </div>

      {/* Table — layout compacto: Categoria/Módulo/Responsável ficam numa 2ª linha discreta
          dentro da própria célula do chamado, em vez de colunas separadas (evita quebra). */}
      <div className="bg-surface border border-border rounded-[10px] shadow-sm overflow-x-auto">
        <table className="w-full text-[13px] table-fixed">
          <thead>
            <tr className="border-b border-border bg-surface-2">
              <th className="text-left px-4 py-3 font-semibold text-txt-2">Chamado</th>
              <th className="text-left px-4 py-3 font-semibold text-txt-2 w-36">Cliente</th>
              <th className="text-left px-4 py-3 font-semibold text-txt-2 w-40">Status</th>
              <th className="text-right px-4 py-3 font-semibold text-txt-2 w-24">Esforço APF</th>
              <th className="text-left px-4 py-3 font-semibold text-txt-2 w-28">Encerrado em</th>
              <th className="text-center px-4 py-3 font-semibold text-txt-2 w-32 whitespace-nowrap">Documentos</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-txt-3 animate-pulse">Carregando…</td></tr>
            )}
            {!loading && items.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-txt-3">Nenhum chamado encerrado com documentos gerados encontrado.</td></tr>
            )}
            {!loading && items.map((item, i) => (
              <tr
                key={item.Id}
                className={`border-b border-border transition-colors hover:bg-surface-2 ${i % 2 === 0 ? '' : 'bg-[#fafafa]'}`}
              >
                <td className="px-4 py-2.5 max-w-[360px]">
                  <a
                    href={getDevOpsWorkItemUrl(item.Id, item.DevOpsAreaPath)}
                    target="_blank"
                    rel="noopener"
                    title="Abrir chamado no DevOps"
                    className="text-[#1d4ed8] hover:underline font-medium"
                  >
                    #{item.Id}
                  </a>
                  <span className="text-txt ml-2 truncate inline-block align-middle max-w-[260px]" title={item.Title}>{item.Title}</span>
                  <div className="text-[11px] text-txt-3 truncate mt-0.5">
                    {[item.Categoria, item.Modulo, item.AssignedTo].filter(Boolean).join(' · ') || '—'}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-txt truncate" title={item.ClienteNome || ''}>{item.ClienteNome || '—'}</td>
                <td className="px-4 py-2.5 text-txt-2 truncate" title={item.SupportCaseStatus || ''}>
                  {item.SupportCaseStatus ? (STATUS_LABELS[item.SupportCaseStatus] || item.SupportCaseStatus) : '—'}
                </td>
                <td className="px-4 py-2.5 text-right text-txt">{item.EsforcoAPF ?? '—'}</td>
                <td className="px-4 py-2.5 text-txt-3 whitespace-nowrap">{fmtDate(item.ChangedDate)}</td>
                <td className="px-4 py-2.5 text-center whitespace-nowrap">
                  <button
                    onClick={() => setDocDrawer({ id: item.Id, title: item.Title })}
                    className="text-[12px] text-[#6366f1] hover:underline font-medium"
                  >
                    ver / baixar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-txt-3">Página {page} de {totalPages}</span>
          <div className="flex gap-2">
            <button
              onClick={() => load(page - 1)}
              disabled={page <= 1 || loading}
              className="h-8 px-3 rounded-md text-[12px] border border-border bg-white text-txt disabled:opacity-40 hover:bg-surface-2 transition-colors"
            >
              Anterior
            </button>
            <button
              onClick={() => load(page + 1)}
              disabled={page >= totalPages || loading}
              className="h-8 px-3 rounded-md text-[12px] border border-border bg-white text-txt disabled:opacity-40 hover:bg-surface-2 transition-colors"
            >
              Próxima
            </button>
          </div>
        </div>
      )}

      {/* Document history drawer — mesmo componente usado no Dashboard */}
      {docDrawer && (
        <DocHistoryDrawer
          workItemId={docDrawer.id}
          title={docDrawer.title}
          onClose={() => setDocDrawer(null)}
        />
      )}
    </div>
  );
}


