import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { fetchWorkItems, fetchKpis, fetchFilters, fetchCharts, updateWorkItem, fetchNextPriority, generateApfDoc, generateSpecDoc, getDocDownloadUrl, downloadDocument, fetchDocStatus, fetchDocVersions, fetchSyncLast, cancelSync, API_BASE } from '../services/api';
import { getAccessToken } from '../auth/authFetch';
import { useCurrentUser } from '../auth/RoleContext';
import PatiChat from '../components/PatiChat';
import PatiSprite from '../components/PatiSprite';
import DocHistoryDrawer from '../components/DocHistoryDrawer';
import type { WorkItem, Kpis, FilterOptions } from '../types';
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
  BarElement,
  CategoryScale,
  LinearScale,
} from 'chart.js';
import { Doughnut, Bar } from 'react-chartjs-2';

ChartJS.register(ArcElement, Tooltip, Legend, BarElement, CategoryScale, LinearScale);

/* Custom plugin to draw value labels on top of bars */
const barValueLabels = {
  id: 'barValueLabels',
  afterDatasetsDraw(chart: any) {
    const { ctx } = chart;
    chart.data.datasets.forEach((dataset: any, dsIndex: number) => {
      const meta = chart.getDatasetMeta(dsIndex);
      meta.data.forEach((bar: any, index: number) => {
        const value = dataset.data[index];
        if (value == null) return;
        ctx.save();
        ctx.font = 'bold 11px "DM Sans", sans-serif';
        ctx.fillStyle = '#1A3470';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(value, bar.x, bar.y - 4);
        ctx.restore();
      });
    });
  },
};

/* ─── KPI accent colors (left bar) ─── */
const KPI_COLORS = ['#6366f1', '#16a34a', '#2563eb', '#d97706', '#dc2626'];

/* ─── Category badge → CSS class ─── */
function catBadgeClass(cat: string | null) {
  if (!cat) return '';
  const map: Record<string, string> = {
    Produto: 'badge-produto',
    Hibrido: 'badge-hibrido',
    Cliente: 'badge-cliente',
    'Info Insuficiente': 'badge-info',
  };
  return map[cat] || 'badge-info';
}

/* Priority é exclusivamente numérica e manual (ver services/workitem.ts) — sem badges de cor */

/* ─── Display labels for classification values ─── */
const displayLabels: Record<string, string> = {
  // Tipo
  RegraNegocio: 'Regra de Negócio',
  WorkflowAprovacao: 'Workflow Aprovação',
  Integracao: 'Integração',
  Relatorio: 'Relatório',
  UX: 'UX',
  // Categoria
  Hibrido: 'Híbrido',
  Produto: 'Roadmap',
  Cliente: 'Customização',
  'Info Insuficiente': 'Indefinido',
  // Prioridade
  Obrigatoria: 'Obrigatória',
  Media: 'Média',
  'Nao priorizar': 'Não Priorizar',
  // Impacto
  Medio: 'Médio',
};
function fmt(value: string | null | undefined): string {
  if (!value) return '—';
  return displayLabels[value] || value;
}

/* ─── Module-level caches: survive tab switches ─── */
// Items cache keyed by dimension filters only (search/page are client-side)
interface ItemsCache {
  key: string; ts: number;
  items: WorkItem[]; // full dataset for current dimension filters
  docStatus: Record<number, { apf: boolean; apfExcel: boolean; spec: boolean; specDocx: boolean }>;
}
// KPI/Chart cache (only reacts to dimension filters, NOT search/page)
interface KpiChartCache {
  key: string; ts: number;
  kpis: any; chartData: any;
}
let _itemsCache: ItemsCache | null = null;
let _kpiChartCache: KpiChartCache | null = null;
const DASH_CACHE_TTL = 30_000; // 30 s
const PAGE_SIZE = 50;

/* ─── sessionStorage helpers: survive F5 ─── */
const SS_KEY = 'painelbacklog_items_v1';
function readSSCache(): ItemsCache | null {
  try { const r = sessionStorage.getItem(SS_KEY); return r ? (JSON.parse(r) as ItemsCache) : null; }
  catch { return null; }
}
function writeSSCache(c: ItemsCache) {
  try { sessionStorage.setItem(SS_KEY, JSON.stringify(c)); } catch {}
}

export default function Dashboard() {
  const { user } = useCurrentUser();

  // ── Cache warm-check (stale-while-revalidate) ───────────────────────────
  // Priority: 1) module cache (same session, fresh)  2) sessionStorage (survives F5)
  const _defaultKey = JSON.stringify({ selCategoria: [] as string[], selStatus: [], selCaseType: [], selClientes: [], selModulo: '', selProjeto: [] as string[], selResponsavel: [] as string[] });
  const _memWarm = !!(_itemsCache && _itemsCache.key === _defaultKey && Date.now() - _itemsCache.ts < DASH_CACHE_TTL);
  const _ssCache  = _memWarm ? null : readSSCache();
  const _ssWarm   = !!(_ssCache && _ssCache.key === _defaultKey);
  const _initItems     = _memWarm ? _itemsCache!.items     : _ssWarm ? _ssCache!.items     : [];
  const _initDocStatus = _memWarm ? _itemsCache!.docStatus : _ssWarm ? _ssCache!.docStatus : {};

  // ALL items from the server (for current dimension filters)
  const [allItems, setAllItems] = useState<WorkItem[]>(_initItems);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [filters, setFilters] = useState<FilterOptions | null>(null);
  const [page, setPage] = useState(1);
  // loading=true only when no items at all; stale data → shows thin bar only
  const [loading, setLoading] = useState(!_memWarm && !_ssWarm);

  // Filter state
  const [search, setSearch] = useState('');
  const [selCategoria, setSelCategoria] = useState<string[]>([]);
  const [selCaseType, setSelCaseType] = useState<string[]>([]);
  const [selStatus, setSelStatus] = useState<string[]>([]);
  const [selClientes, setSelClientes] = useState<string[]>([]);
  const [selModulo, setSelModulo] = useState('');
  const [selProjeto, setSelProjeto] = useState<string[]>([]);
  const [selResponsavel, setSelResponsavel] = useState<string[]>([]);
  const [semApfOnly, setSemApfOnly] = useState(false);
  const [comApfOnly, setComApfOnly] = useState(false);
  const [selMonth, setSelMonth] = useState('');
  const [chartData, setChartData] = useState<any>(null);

  // Sincronização DevOps — disponível para todos os papéis
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{
    phase: 'fetching' | 'processing' | 'pati' | 'done' | 'error' | 'cancelled';
    current: number;
    total: number;
    message: string;
  } | null>(null);
  const syncEventSourceRef = useRef<EventSource | null>(null);

  // Modal / drawer state
  const [selectedItem, setSelectedItem] = useState<WorkItem | null>(null);
  const [auditItem, setAuditItem] = useState<{ id: number; title: string } | null>(null);

  // Document status for all items
  const [docStatus, setDocStatus] = useState<Record<number, { apf: boolean; apfExcel: boolean; spec: boolean; specDocx: boolean }>>(_initDocStatus);

  // ── Client-side search + pagination (ZERO network calls) ──────────────
  const filteredItems = useMemo(() => {
    let result = semApfOnly
      ? allItems.filter(i => !(i.EsforcoAPF != null && i.EsforcoAPF > 0))
      : comApfOnly
        ? allItems.filter(i => i.EsforcoAPF != null && i.EsforcoAPF > 0)
        : allItems;
    if (selMonth) {
      result = result.filter(i => i.CreatedDate && i.CreatedDate.slice(0, 7) === selMonth);
    }
    if (!search.trim()) return result;
    const q = search.trim().toLowerCase();
    if (/^\d+$/.test(q)) {
      return result.filter(i => String(i.Id).startsWith(q));
    }
    return result.filter(i =>
      i.Title?.toLowerCase().includes(q) || String(i.Id).includes(q)
    );
  }, [allItems, search, semApfOnly, comApfOnly, selMonth]);

  const total = filteredItems.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const items = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredItems.slice(start, start + PAGE_SIZE);
  }, [filteredItems, page]);

  // Reset to page 1 when search changes
  useEffect(() => { setPage(1); }, [search]);

  // ── Load all items from server (only when dimension filters change) ────
  const loadItems = useCallback(async () => {
    const key = JSON.stringify({ selCategoria, selStatus, selCaseType, selClientes, selModulo, selProjeto, selResponsavel });

    if (_itemsCache && _itemsCache.key === key && Date.now() - _itemsCache.ts < DASH_CACHE_TTL) {
      setAllItems(_itemsCache.items);
      setDocStatus(_itemsCache.docStatus);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const itemsData = await fetchWorkItems({
        page: 1,
        size: 1000, // fetch all items — search is client-side
        categoria: selCategoria.join(','),
        status: selStatus.join(','),
        caseType: selCaseType.join(','),
        cliente: selClientes.join(','),
        modulo: selModulo,
        projeto: selProjeto.join(','),
        responsavel: selResponsavel.join(','),
      });

      setAllItems(itemsData.items);
      setLoading(false);

      // Fetch doc status for all items in background
      const ids = (itemsData.items as WorkItem[]).map(i => i.Id);
      fetchDocStatus(ids).then(ds => {
        setDocStatus(ds as Record<number, { apf: boolean; apfExcel: boolean; spec: boolean; specDocx: boolean }>);
        const nc: ItemsCache = { key, ts: Date.now(), items: itemsData.items, docStatus: ds as any };
        _itemsCache = nc; writeSSCache(nc);
      }).catch(() => {
        const nc: ItemsCache = { key, ts: Date.now(), items: itemsData.items, docStatus: {} };
        _itemsCache = nc; writeSSCache(nc);
      });
    } catch (err) {
      console.error(err);
      setLoading(false);
    }
  }, [selCategoria, selStatus, selCaseType, selClientes, selModulo, selProjeto, selResponsavel]);

  // Load KPIs + Charts: reacts only to dimension filters (NOT search/page)
  const loadKpisAndCharts = useCallback(async () => {
    const apf: 'com' | 'sem' | undefined = comApfOnly ? 'com' : semApfOnly ? 'sem' : undefined;
    const key = JSON.stringify({ selClientes, selCategoria, selStatus, selCaseType, selModulo, selProjeto, selResponsavel, apf });

    if (_kpiChartCache && _kpiChartCache.key === key && Date.now() - _kpiChartCache.ts < DASH_CACHE_TTL) {
      setKpis(_kpiChartCache.kpis);
      setChartData(_kpiChartCache.chartData);
      return;
    }

    try {
      const cf = {
        cliente: selClientes.join(',') || undefined,
        categoria: selCategoria.join(',') || undefined,
        status: selStatus.join(',') || undefined,
        caseType: selCaseType.join(',') || undefined,
        modulo: selModulo || undefined,
        projeto: selProjeto.join(',') || undefined,
        responsavel: selResponsavel.join(',') || undefined,
        apf,
      };
      const [kpisData, chartsData] = await Promise.all([
        fetchKpis(cf),
        fetchCharts(cf),
      ]);
      setKpis(kpisData);
      setChartData(chartsData);
      _kpiChartCache = { key, ts: Date.now(), kpis: kpisData, chartData: chartsData };
    } catch (err) {
      console.error(err);
    }
  }, [selClientes, selCategoria, selStatus, selCaseType, selModulo, selProjeto, selResponsavel, comApfOnly, semApfOnly]);

  // chartFilters used for PatiChat prop
  const chartFilters = useMemo(() => ({
    cliente: selClientes.join(',') || undefined,
    categoria: selCategoria.join(',') || undefined,
    status: selStatus.join(',') || undefined,
    caseType: selCaseType.join(',') || undefined,
    modulo: selModulo || undefined,
    projeto: selProjeto.join(',') || undefined,
    responsavel: selResponsavel.join(',') || undefined,
    apf: comApfOnly ? 'com' : semApfOnly ? 'sem' : undefined,
  }), [selClientes, selCategoria, selStatus, selCaseType, selModulo, selProjeto, selResponsavel, comApfOnly, semApfOnly]);

  useEffect(() => {
    fetchFilters().then(setFilters).catch(console.error);
  }, []);

  // Operador: pré-seleciona o próprio nome no filtro "Responsável" na primeira carga
  // (mesma normalização "Primeiro + Último nome" usada no sync do DevOps), sem
  // sobrescrever se o usuário depois limpar o filtro manualmente.
  const appliedOperatorDefaultRef = useRef(false);
  useEffect(() => {
    if (appliedOperatorDefaultRef.current) return;
    if (!user || user.role !== 'Operador' || !user.nome || !filters?.responsaveis?.length) return;
    const parts = user.nome.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return;
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    const normalized = parts.length > 1 ? `${cap(parts[0])} ${cap(parts[parts.length - 1])}` : cap(parts[0]);
    appliedOperatorDefaultRef.current = true;
    if (filters.responsaveis.includes(normalized)) {
      setSelResponsavel([normalized]);
    }
  }, [user, filters]);

  useEffect(() => { loadItems(); }, [loadItems]);
  useEffect(() => { loadKpisAndCharts(); }, [loadKpisAndCharts]);

  // ── Sincronização DevOps ────────────────────────────────────────────────
  // Ao montar, verifica se já existe uma sync em andamento (disparada por outro
  // usuário ou pelo cron automático) para refletir o estado do botão corretamente.
  useEffect(() => {
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    fetchSyncLast().then(s => {
      if (cancelled || !s.isSyncing) return;
      setSyncing(true);
      setSyncProgress({ phase: 'processing', current: 0, total: 0, message: 'Sincronização em andamento...' });
      poll = setInterval(async () => {
        const status = await fetchSyncLast().catch(() => null);
        if (status && !status.isSyncing) {
          setSyncing(false);
          setSyncProgress(null);
          if (poll) clearInterval(poll);
          loadItems();
          loadKpisAndCharts();
          fetchFilters().then(setFilters).catch(console.error);
        }
      }, 5000);
    }).catch(() => {});
    return () => { cancelled = true; if (poll) clearInterval(poll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    setSyncProgress({ phase: 'fetching', current: 0, total: 0, message: 'Consultando Azure DevOps...' });

    // EventSource não suporta header Authorization — token vai via query string
    const token = await getAccessToken();
    const es = new EventSource(`${API_BASE}/sync/stream?token=${encodeURIComponent(token || '')}`);
    syncEventSourceRef.current = es;
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'start') {
        setSyncProgress({ phase: 'processing', current: 0, total: data.total, message: `Iniciando ${data.total} chamados...` });
      } else if (data.type === 'progress') {
        setSyncProgress({ phase: 'processing', current: data.current, total: data.total, message: `#${data.id} — ${data.title}` });
      } else if (data.type === 'pati') {
        setSyncProgress({ phase: 'pati', current: data.current, total: data.total, message: 'Buscando comentários [PATI]...' });
      } else if (data.type === 'done') {
        const msg = `Sync concluído: ${data.total} itens (${data.created} novos, ${data.updated} atualizados${data.canceled > 0 ? `, ${data.canceled} cancelados removidos` : ''})`;
        setSyncProgress({ phase: 'done', current: data.total, total: data.total, message: msg });
        setSyncing(false);
        es.close();
        window.dispatchEvent(new CustomEvent('painelbacklog:sync-done'));
        loadItems();
        loadKpisAndCharts();
        fetchFilters().then(setFilters).catch(console.error);
      } else if (data.type === 'cancelled') {
        setSyncProgress({ phase: 'cancelled', current: 0, total: 0, message: 'Sincronização cancelada.' });
        setSyncing(false);
        es.close();
        loadItems();
        loadKpisAndCharts();
        fetchFilters().then(setFilters).catch(console.error);
      } else if (data.type === 'error') {
        setSyncProgress({ phase: 'error', current: 0, total: 0, message: data.message });
        setSyncing(false);
        es.close();
      }
    };
    es.onerror = () => {
      setSyncProgress(prev => prev?.phase === 'done' ? prev : null);
      setSyncing(false);
      es.close();
    };
  };

  const handleCancelSync = async () => {
    try {
      await cancelSync();
      setSyncProgress(prev => prev ? { ...prev, message: 'Cancelando...' } : prev);
    } catch { /* ignore */ }
  };

  const resetPage = () => setPage(1);

  const invalidateAndReload = useCallback(() => {
    _itemsCache = null;
    _kpiChartCache = null;
    loadItems();
    loadKpisAndCharts();
  }, [loadItems, loadKpisAndCharts]);





  const handleModalSave = async (id: number, data: Record<string, any>) => {
    const result = await updateWorkItem(id, data);
    _itemsCache = null;
    _kpiChartCache = null;
    await Promise.all([loadItems(), loadKpisAndCharts()]);
    setSelectedItem(result);
  };



  /* ─── KPIs data ─── */
  const _total    = kpis?.total    || 1;
  const _comApf   = kpis?.comApf   ?? 0;
  const _totalAPF = kpis?.totalAPF ?? 0;

  const anyServerFilterActive = selCategoria.length > 0 || selStatus.length > 0 || selCaseType.length > 0 || selClientes.length > 0 || !!selModulo || selProjeto.length > 0 || selResponsavel.length > 0;
  const anyFilterActive = anyServerFilterActive || comApfOnly || semApfOnly || !!selMonth;

  const resetAllFilters = () => {
    setSelCategoria([]);
    setSelStatus([]);
    setSelCaseType([]);
    setSelClientes([]);
    setSelModulo('');
    setSelProjeto([]);
    setSelResponsavel([]);
    setSemApfOnly(false);
    setComApfOnly(false);
    setSelMonth('');
    setSearch('');
    resetPage();
  };

  const kpiItems = kpis
    ? [
        {
          label:    'Total de Chamados',
          value:    String(kpis.total),
          sub:      `${((kpis.classificados / _total) * 100).toFixed(0)}% classificados`,
          color:    '#6366f1',
          bgIcon:   '#6366f115',
          active:   false,
          onClick:  undefined as (() => void) | undefined,
          icon: (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 2 7 12 12 22 7"/>
              <polyline points="2 17 12 22 22 17"/>
              <polyline points="2 12 12 17 22 12"/>
            </svg>
          ),
        },
        {
          label:    'Estimados',
          value:    String(_comApf),
          sub:      comApfOnly ? '× filtrando' : `${((_comApf / _total) * 100).toFixed(1)}% do total`,
          color:    '#16a34a',
          bgIcon:   '#16a34a15',
          active:   comApfOnly,
          onClick:  () => { setComApfOnly(v => !v); setSemApfOnly(false); resetPage(); },
          icon: (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          ),
        },
        {
          label:    'Sem Estimativa',
          value:    String(kpis.semApf ?? 0),
          sub:      semApfOnly ? '× filtrando' : 'clique para filtrar',
          color:    '#dc2626',
          bgIcon:   '#dc262615',
          active:   semApfOnly,
          onClick:  () => { setSemApfOnly(v => !v); setComApfOnly(false); resetPage(); },
          icon: (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          ),
        },
        {
          label:    'Horas Totais',
          value:    `${Number(_totalAPF).toLocaleString('pt-BR')}h`,
          sub:      _comApf > 0 ? `média ${(_totalAPF / _comApf).toFixed(1)}h por chamado` : '—',
          color:    '#2563eb',
          bgIcon:   '#2563eb15',
          active:   false,
          onClick:  undefined as (() => void) | undefined,
          icon: (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
          ),
        },
      ]
    : [];

  return (
    <div>
      {/* ─── KPI Cards ─── */}
      <div className="grid grid-cols-4 gap-3 mb-6 max-[1200px]:grid-cols-2 max-[760px]:grid-cols-2">
        {kpiItems.map((kpi, i) => (
          <div
            key={i}
            onClick={kpi.onClick}
            style={kpi.active ? { borderColor: kpi.color + 'aa', boxShadow: `0 0 0 3px ${kpi.color}22` } : {}}
            className={`relative bg-surface border rounded-[10px] px-5 py-5 shadow-sm animate-fade-up overflow-hidden transition-all ${
              kpi.onClick ? 'cursor-pointer hover:brightness-[.97]' : ''
            } ${
              kpi.active ? '' : 'border-border'
            }`}
          >
            {/* Left accent bar */}
            <div
              className="absolute left-0 top-[10%] bottom-[10%] w-[3px] rounded-r-sm"
              style={{ background: kpi.color }}
            />
            {/* Icon top-right */}
            <div
              className="absolute top-4 right-4 w-9 h-9 rounded-lg flex items-center justify-center"
              style={{ background: kpi.bgIcon }}
            >
              {kpi.icon}
            </div>
            <div className="text-[11px] font-medium tracking-[.05em] uppercase text-txt-3 mb-1 pr-10">
              {kpi.label}
            </div>
            <div className="text-[28px] font-semibold tracking-tight tabular-nums text-txt leading-none mb-1">
              {kpi.value}
            </div>
            <div className="text-[11px] text-txt-3">
              {kpi.sub}
            </div>
          </div>
        ))}
      </div>

      {/* ─── Charts Grid ─── */}
      {chartData && (
        <ChartsGrid
          data={chartData}
          total={kpis?.total || 1}
          singleClient={selClientes.length === 1 ? selClientes[0] : null}
          activeCategory={selCategoria}
          activeStatuses={selStatus}
          activeClients={selClientes}
          activeMonth={selMonth}
          activeModulo={selModulo}
          onCategoryClick={cat => { setSelCategoria(v => v.includes(cat) ? v.filter(x => x !== cat) : [...v, cat]); resetPage(); }}
          onStatusClick={st => { setSelStatus(v => v.includes(st) ? v.filter(x => x !== st) : [...v, st]); resetPage(); }}
          onClientClick={cl => { setSelClientes(v => v.includes(cl) ? [] : [cl]); resetPage(); }}
          onMonthClick={m => { setSelMonth(v => v === m ? '' : m); resetPage(); }}
          onModuloClick={m => { setSelModulo(v => v === m ? '' : m); resetPage(); }}
        />
      )}

      {/* ─── Toolbar / Filters ─── */}
      <div className="relative bg-surface border border-border rounded-[10px] p-[14px_16px] shadow-sm mb-3">
        <div className="flex flex-wrap gap-2 items-center">
        {/* Search */}
        <input
          type="text"
          placeholder="Buscar por ID, título..."
          className="h-9 w-[150px] border border-border rounded-sm px-3 text-[13px] bg-bg focus-ring transition-[border-color,box-shadow] duration-150"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
        />

        {/* Cliente — multi-select */}
        <MultiSelect
          label="Cliente"
          options={filters?.clientes || []}
          selected={selClientes}
          onChange={v => { setSelClientes(v); resetPage(); }}
        />

        {/* Categoria — multi-select */}
        <MultiSelect label="Categoria" options={filters?.categorias || []} selected={selCategoria} onChange={v => { setSelCategoria(v); resetPage(); }} displayFn={fmt} />

        {/* Status — multi-select */}
        <MultiSelect
          label="Status"
          options={filters?.estados || []}
          selected={selStatus}
          onChange={v => { setSelStatus(v); resetPage(); }}
          displayFn={v => STATUS_LABELS[v] || v}
        />

        {/* Projeto — multi-select, visível só quando o usuário tem mais de 1 projeto associado */}
        {user && user.projects.length > 1 && (
          <MultiSelect
            label="Projeto"
            options={user.projects}
            selected={selProjeto}
            onChange={v => { setSelProjeto(v); resetPage(); }}
          />
        )}

        {/* Responsável — multi-select */}
        <MultiSelect
          label="Responsável"
          options={filters?.responsaveis || []}
          selected={selResponsavel}
          onChange={v => { setSelResponsavel(v); resetPage(); }}
        />

        {/* Limpar filtros */}
        {anyFilterActive && (
          <button
            onClick={resetAllFilters}
            className="h-9 px-3 text-[12px] font-medium rounded-sm border border-[#6366f1]/60 text-[#4f46e5] bg-[#6366f108] hover:bg-[#6366f115] transition-colors shrink-0"
          >
            × Limpar
          </button>
        )}

        {/* Sincronizar — flui na mesma linha, logo após os filtros (sem empurrar pro canto) */}
        <div className="flex items-center gap-2">
          {syncProgress && (syncProgress.phase === 'processing' || syncProgress.phase === 'pati' || syncProgress.phase === 'fetching') && (
            <span className="hidden lg:inline text-[11px] text-txt-3 truncate max-w-[200px]" title={syncProgress.message}>
              {syncProgress.message}
            </span>
          )}
          <button
            onClick={handleSync}
            disabled={syncing}
            title="Sincronizar work items do Azure DevOps (também roda automaticamente a cada 2h)"
            className="h-9 px-3 flex items-center gap-1.5 rounded-sm border border-[#bfdbfe] bg-[#eff6ff] text-[#1d4ed8] hover:bg-[#dbeafe] transition-colors duration-150 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer shrink-0"
          >
            {syncing ? (
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round"/>
              </svg>
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M4 4v5h.582M20 20v-5h-.581M4.582 9a8 8 0 0115.356 2M19.419 15a8 8 0 01-15.356-2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            <span className="text-[13px] font-medium">{syncing ? 'Sincronizando...' : 'Sincronizar'}</span>
          </button>
          {syncing && (
            <button
              onClick={handleCancelSync}
              title="Cancelar sincronização em andamento"
              className="h-9 px-3 flex items-center rounded-sm border border-border text-txt-2 hover:bg-surface-2 hover:text-[#b91c1c] transition-colors duration-150 cursor-pointer shrink-0 text-[13px] font-medium"
            >
              Cancelar
            </button>
          )}
        </div>
        </div>

        {/* Barra de progresso fina da sincronização, colada na base da toolbar */}
        {syncProgress && (
          <div className="absolute left-0 right-0 bottom-0 h-[3px] rounded-b-[10px] overflow-hidden bg-surface-2">
            <div
              className={`h-full transition-all duration-300 ${
                syncProgress.phase === 'error' || syncProgress.phase === 'cancelled' ? 'bg-[#ef4444]' :
                syncProgress.phase === 'done' ? 'bg-[#22c55e]' : 'bg-[#3b82f6]'
              }`}
              style={{
                width: syncProgress.phase === 'fetching' ? '5%' :
                       syncProgress.phase === 'done' ? '100%' :
                       syncProgress.phase === 'pati' ? '95%' :
                       syncProgress.total > 0
                         ? `${Math.max(5, Math.round((syncProgress.current / syncProgress.total) * 90))}%`
                         : '5%',
              }}
            />
          </div>
        )}
      </div>


      {/* ─── Data Table ─── */}
      <div className="bg-surface border border-border rounded-[10px] shadow-sm overflow-hidden">
        {/* Thin progress bar shown while refreshing with existing items */}
        <div className={`h-[2px] transition-opacity duration-150 ${loading && items.length > 0 ? 'opacity-100 bg-accent animate-pulse' : 'opacity-0'}`} />
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="bg-surface-2 border-b border-border sticky top-0 z-[2]">
              <tr>
                {['ID', 'Título', 'Categoria', 'Módulo', 'Responsável', 'Tipo', 'Prioridade', 'Esforço', 'Impacto', 'Docs', 'DevOps'].map((h, i) => (
                  <th
                    key={h}
                    className={`text-left px-[10px] py-[11px] text-[11px] font-semibold uppercase tracking-[.05em] text-txt-3 whitespace-nowrap ${
                      i === 4 || i === 5 || i === 10 ? 'max-[760px]:hidden' : ''
                    }`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={loading && items.length > 0 ? 'opacity-50 pointer-events-none' : ''}>
              {loading && items.length === 0 ? (
                <tr>
                  <td colSpan={11} className="text-center py-12 text-txt-3">Carregando...</td>
                </tr>
              ) : !loading && items.length === 0 ? (
                <tr>
                  <td colSpan={11} className="text-center py-12 text-txt-3">Nenhum chamado encontrado</td>
                </tr>
              ) : (
                items.map(item => (
                  <tr
                    key={item.Id}
                    className="border-b border-border last:border-0 hover:bg-[#f5f7ff] transition-colors duration-100 cursor-pointer"
                    onClick={() => setSelectedItem(item)}
                  >
                    <td className="px-[10px] py-[10px] font-mono text-[12px] text-txt-3 whitespace-nowrap">
                      {item.Id}
                    </td>
                    <td className="px-[10px] py-[10px] max-w-[240px] truncate" title={item.Title}>
                      {item.Title}
                    </td>
                    <td className="px-[10px] py-[10px]">
                      {item.Categoria ? (
                        <span className={`inline-block text-[11px] font-semibold tracking-[.02em] px-2 py-0.5 rounded-full ${catBadgeClass(item.Categoria)}`}>
                          {fmt(item.Categoria)}
                        </span>
                      ) : (
                        <span className="text-txt-3">—</span>
                      )}
                    </td>
                    <td className="px-[10px] py-[10px]">{item.Modulo || '—'}</td>
                    <td className="px-[10px] py-[10px] max-[760px]:hidden">{item.AssignedTo || '—'}</td>
                    <td className="px-[10px] py-[10px] max-[760px]:hidden">{fmt(item.Tipo)}</td>
                    <td className="px-[10px] py-[10px] font-mono text-[12px]">
                      {item.Prioridade != null ? item.Prioridade : '—'}
                    </td>
                    <td className="px-[10px] py-[10px] font-mono text-[12px]">
                      {item.EsforcoAPF != null && item.EsforcoAPF > 0 ? (
                        <span className="inline-flex items-center gap-1">
                          {item.EsforcoAPF}h
                          {item.ApfDispensado && (
                            <span title={item.ApfDispensadoMotivo || 'Estimativa manual'} className="text-[10px] font-medium uppercase leading-none px-1.5 py-[3px] rounded bg-[#f4f4f5] text-[#71717a] whitespace-nowrap">
                              manual
                            </span>
                          )}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-[10px] py-[10px]">{fmt(item.ImpactoOperacao)}</td>
                    <td className="px-[10px] py-[10px]">
                      <div className="flex gap-1">
                        {docStatus[item.Id]?.spec && (
                          <button onClick={e => { e.stopPropagation(); downloadDocument(getDocDownloadUrl(item.Id, 'SPEC'), `spec-${item.Id}.pdf`).catch(err => alert(err.message)); }} title="Baixar Especificação"
                            className="inline-flex items-center justify-center w-7 h-7 rounded bg-[#f0f6ff] border border-[#dbeafe] hover:bg-[#dbeafe] transition-colors cursor-pointer">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#033AF0" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                          </button>
                        )}
                        {docStatus[item.Id]?.specDocx && (
                          <button onClick={e => { e.stopPropagation(); downloadDocument(getDocDownloadUrl(item.Id, 'SPEC_DOCX'), `spec-${item.Id}.docx`).catch(err => alert(err.message)); }} title="Baixar Especificação de Negócio (Word)"
                            className="inline-flex items-center justify-center w-7 h-7 rounded bg-[#eef2ff] border border-[#c7d2fe] hover:bg-[#c7d2fe] transition-colors cursor-pointer">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2b579a" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><text x="7" y="18" fontSize="7" fontWeight="bold" stroke="none" fill="#2b579a">W</text></svg>
                          </button>
                        )}
                        {docStatus[item.Id]?.apf && (
                          <button onClick={e => { e.stopPropagation(); downloadDocument(getDocDownloadUrl(item.Id, 'APF'), `apf-${item.Id}.pdf`).catch(err => alert(err.message)); }} title="Baixar APF (PDF)"
                            className="inline-flex items-center justify-center w-7 h-7 rounded bg-[#fff7ed] border border-[#fed7aa] hover:bg-[#fed7aa] transition-colors cursor-pointer">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#E8661B" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9,15 12,18 15,15"/></svg>
                          </button>
                        )}
                        {docStatus[item.Id]?.apfExcel && (
                          <button onClick={e => { e.stopPropagation(); downloadDocument(getDocDownloadUrl(item.Id, 'APF_EXCEL'), `apf-${item.Id}.xlsx`).catch(err => alert(err.message)); }} title="Baixar APF (Excel)"
                            className="inline-flex items-center justify-center w-7 h-7 rounded bg-[#ecfdf5] border border-[#a7f3d0] hover:bg-[#a7f3d0] transition-colors cursor-pointer">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><path d="M8 13l2.5 3L8 19M16 13l-2.5 3L16 19"/></svg>
                          </button>
                        )}
                        {!docStatus[item.Id]?.spec && !docStatus[item.Id]?.specDocx && !docStatus[item.Id]?.apf && !docStatus[item.Id]?.apfExcel && (
                          <span className="text-txt-3 text-[11px]">—</span>
                        )}
                        <button
                          onClick={e => { e.stopPropagation(); setAuditItem({ id: item.Id, title: item.Title }); }}
                          title="Ver histórico de documentos"
                          className="inline-flex items-center justify-center w-7 h-7 rounded bg-[#f5f3ff] border border-[#ddd6fe] hover:bg-[#ddd6fe] transition-colors ml-1"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2">
                            <circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/>
                          </svg>
                        </button>
                      </div>
                    </td>
                    <td className="px-[10px] py-[10px] max-[760px]:hidden">
                      <a
                        href={`https://dev.azure.com/pbs-devops/SRM.wbc7srm/_workitems/edit/${item.Id}`}
                        target="_blank"
                        rel="noopener"
                        onClick={e => e.stopPropagation()}
                        className="inline-flex items-center whitespace-nowrap h-6 px-2 text-[11px] font-medium text-accent bg-[#f0f6ff] border border-[#dbeafe] rounded-sm hover:bg-[#dbeafe] hover:border-[#93c5fd] transition-[background,border-color] duration-[120ms]"
                      >
                        Abrir ↗
                      </a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-surface-2 text-[12px] text-txt-3">
          <span>
            Exibindo {items.length} de {total} chamados. Página {page} de {totalPages}.
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="h-9 px-3 border border-border rounded-sm bg-surface text-[13px] font-medium text-txt-2 hover:bg-[#f4f8ff] hover:border-[#bfd2ff] disabled:opacity-40 transition-colors duration-150"
            >
              ← Anterior
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="h-9 px-3 border border-border rounded-sm bg-surface text-[13px] font-medium text-txt-2 hover:bg-[#f4f8ff] hover:border-[#bfd2ff] disabled:opacity-40 transition-colors duration-150"
            >
              Próxima →
            </button>
          </div>
        </div>
      </div>

      {/* Modal */}
      {selectedItem && (
        <WorkItemModal
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
          onSave={handleModalSave}
        />
      )}

      {/* PATi Chat Agent */}
      <PatiChat filters={chartFilters} onClassifyDone={invalidateAndReload} />

      {/* Document history drawer */}
      {auditItem && (
        <DocHistoryDrawer
          workItemId={auditItem.id}
          title={auditItem.title}
          onClose={() => setAuditItem(null)}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   WorkItem Modal (edit inline)
   ═══════════════════════════════════════════ */
function WorkItemModal({ item, onClose, onSave }: {
  item: WorkItem;
  onClose: () => void;
  onSave: (id: number, data: Record<string, any>) => Promise<void>;
}) {
  const [categoria, setCategoria] = useState(item.Categoria || '');
  const [tipo, setTipo] = useState(item.Tipo || '');
  const [prioridade, setPrioridade] = useState<string>(item.Prioridade != null ? String(item.Prioridade) : '');
  const [nextPrio, setNextPrio] = useState<number | null>(null);
  const [esforco, setEsforco] = useState(item.EsforcoAPF ?? '');
  const [impacto, setImpacto] = useState(item.ImpactoOperacao || '');
  const [apfDispensado, setApfDispensado] = useState(item.ApfDispensado || false);
  const [apfDispensadoMotivo, setApfDispensadoMotivo] = useState(item.ApfDispensadoMotivo || '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Document generation
  const [generating, setGenerating] = useState<'apf' | 'spec' | null>(null);
  const [genError, setGenError] = useState('');
  const [genSuccess, setGenSuccess] = useState('');

  useEffect(() => {
    setCategoria(item.Categoria || '');
    setTipo(item.Tipo || '');
    setPrioridade(item.Prioridade != null ? String(item.Prioridade) : '');
    setEsforco(item.EsforcoAPF ?? '');
    setImpacto(item.ImpactoOperacao || '');
    setApfDispensado(item.ApfDispensado || false);
    setApfDispensadoMotivo(item.ApfDispensadoMotivo || '');
    // Fetch next available priority for this client
    if (item.ClienteNome) {
      fetchNextPriority(item.ClienteNome).then(n => setNextPrio(n)).catch(() => setNextPrio(0));
    }
  }, [item]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    if (apfDispensado && !apfDispensadoMotivo.trim()) {
      setSaveError('Informe o motivo para dispensar este chamado de APF');
      setSaving(false);
      return;
    }
    if (apfDispensado && !(Number(esforco) > 0)) {
      setSaveError('Informe o esforço estimado (em horas, maior que zero) para dispensar este chamado de APF');
      setSaving(false);
      return;
    }
    try {
      await onSave(item.Id, {
        categoria: categoria || null,
        tipo: tipo || null,
        prioridade: prioridade === '' ? null : Number(prioridade),
        esforcoAPF: esforco === '' ? null : Number(esforco),
        impactoOperacao: impacto || null,
        apfDispensado,
        apfDispensadoMotivo: apfDispensado ? apfDispensadoMotivo.trim() : null,
      });
    } catch (err: any) {
      setSaveError(err.message || 'Erro ao salvar');
    }
    setSaving(false);
  };

  const handleGenerateApf = async () => {
    setGenerating('apf'); setGenError(''); setGenSuccess('');
    try {
      const result = await generateApfDoc(item.Id);
      setGenSuccess(`APF gerado: ${result.totalHoras}h (${result.elementos} elementos, ${result.totalPFA} PFA)`);
      setEsforco(String(result.totalHoras));
    } catch (err: any) {
      setGenError(err.message);
    }
    setGenerating(null);
  };

  const handleGenerateSpec = async () => {
    setGenerating('spec'); setGenError(''); setGenSuccess('');
    try {
      await generateSpecDoc(item.Id);
      setGenSuccess('Especificação de negócio gerada com sucesso!');
    } catch (err: any) {
      setGenError(err.message);
    }
    setGenerating(null);
  };


  const inputCls = 'h-9 w-full px-3 border border-border rounded-sm bg-bg text-[13px] focus-ring transition-[border-color,box-shadow] duration-150';
  const labelCls = 'text-[11px] font-semibold uppercase tracking-[.05em] text-txt-3 mb-1';

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-[640px] max-h-[90vh] overflow-auto animate-in"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <span className="text-[12px] font-mono text-txt-3 mr-2">#{item.Id}</span>
            <span className="text-[15px] font-semibold text-txt">{item.Title}</span>
          </div>
          <button onClick={onClose} className="text-txt-3 hover:text-txt text-[18px] leading-none px-1">✕</button>
        </div>

        {/* Info */}
        <div className="px-6 py-4 grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] border-b border-border bg-surface-2">
          <div><span className="text-txt-3">Cliente:</span> <span className="font-medium">{item.ClienteNome || '—'}</span></div>
          <div><span className="text-txt-3">Módulo:</span> <span className="font-medium">{item.Modulo || '—'}</span></div>
          <div><span className="text-txt-3">Responsável:</span> <span className="font-medium">{item.AssignedTo || '—'}</span></div>
          <div><span className="text-txt-3">DevOps:</span> <span className="font-medium">{item.DevOpsState || '—'}</span></div>
          <div><span className="text-txt-3">Origem:</span> <span className="font-medium">{item.ClassificacaoOrigem || '—'}</span></div>
        </div>

        {/* Editable fields */}
        <div className="px-6 py-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className={labelCls}>Categoria</div>
              <select className={inputCls} value={categoria} onChange={e => setCategoria(e.target.value)}>
                <option value="">—</option>
                <option value="Produto">Roadmap</option>
                <option value="Hibrido">Hibrido</option>
                <option value="Cliente">Customização</option>
                <option value="Info Insuficiente">Indefinido</option>
              </select>
            </div>
            <div>
              <div className={labelCls}>Tipo</div>
              <select className={inputCls} value={tipo} onChange={e => setTipo(e.target.value)}>
                <option value="">—</option>
                <option value="UX">UX</option>
                <option value="RegraNegocio">Regra de Negócio</option>
                <option value="Relatorio">Relatório</option>
                <option value="Integracao">Integração</option>
                <option value="WorkflowAprovacao">Workflow Aprovação</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className={labelCls}>Prioridade {nextPrio != null && <span className="text-txt-3 normal-case font-normal">(próximo: {nextPrio})</span>}</div>
              <input
                className={inputCls}
                type="number"
                step="1"
                min="0"
                inputMode="numeric"
                placeholder="Número (manual)"
                value={prioridade}
                onChange={e => setPrioridade(e.target.value.replace(/[^0-9]/g, ''))}
              />
            </div>
            <div>
              <div className={labelCls}>Esforço {apfDispensado && <span className="text-danger normal-case font-normal">(obrigatório)</span>}</div>
              <div className="relative">
                <input
                  className={`${inputCls} pr-8`}
                  type="number"
                  min="0"
                  value={esforco}
                  onChange={e => setEsforco(e.target.value)}
                  placeholder="0"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-txt-3">h</span>
              </div>
            </div>
            <div>
              <div className={labelCls}>Impacto Operação</div>
              <select className={inputCls} value={impacto} onChange={e => setImpacto(e.target.value)}>
                <option value="">—</option>
                <option value="Alto">Alto</option>
                <option value="Médio">Médio</option>
                <option value="Baixo">Baixo</option>
              </select>
            </div>
          </div>

          {/* Dispensa de APF — chamados que não requerem contagem de pontos de função */}
          <div className="pt-2 border-t border-border">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={apfDispensado}
                onChange={e => setApfDispensado(e.target.checked)}
                className="w-4 h-4 accent-accent cursor-pointer"
              />
              <span className="text-[13px] font-medium text-txt">Este chamado não requer APF</span>
            </label>
            {apfDispensado && (
              <input
                className={`${inputCls} mt-2`}
                type="text"
                placeholder="Motivo (obrigatório) — ex: correção simples, não gera pontos de função"
                value={apfDispensadoMotivo}
                onChange={e => setApfDispensadoMotivo(e.target.value)}
              />
            )}
          </div>
        </div>



        {/* Actions */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-surface-2">
          {saveError ? (
            <span className="text-[12px] text-danger">{saveError}</span>
          ) : <span />}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="h-9 px-4 border border-border rounded-sm bg-surface text-[13px] font-medium text-txt-2 hover:bg-[#f4f8ff] transition-colors duration-150"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="h-9 px-5 rounded-sm bg-accent text-white text-[13px] font-semibold shadow-sm hover:bg-[#0044cc] disabled:opacity-50 transition-colors duration-150"
            >
              {saving ? 'Salvando...' : 'Salvar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   Charts Grid — Premium Doughnuts
   ═══════════════════════════════════════════ */
/* ══════════════════════════════════════════════
   Paleta oficial fixa — 12 cores na ordem exata
   ══════════════════════════════════════════════ */
const PALETTE = [
  '#0E2354', '#1A3470', '#264A8E', '#3562AA',
  '#4E7CC4', '#6E98D8', '#90B4E8', '#B4CFF2',
  '#A9C6F5', '#C7DBFA',
];
const ACCENT_ORANGE = '#E8661B';

/** Distribui as cores da paleta fixa por posição */
function chartColors(count: number): string[] {
  if (count <= 0) return [];
  if (count <= PALETTE.length) {
    // Distribui uniformemente pela paleta
    const result: string[] = [];
    for (let i = 0; i < count; i++) {
      const idx = Math.round((i / (count - 1 || 1)) * (PALETTE.length - 1));
      result.push(PALETTE[idx]);
    }
    return result;
  }
  // Mais fatias que cores: cicla a paleta
  return Array.from({ length: count }, (_, i) => PALETTE[i % PALETTE.length]);
}

/** Semântico para Status — usa posição na paleta */
function statusColors(labels: string[]): string[] {
  return chartColors(labels.length);
}

const STATUS_LABELS: Record<string, string> = {
  'New - In analysis': 'Aguardando atendimento',
  'Active - In progress': 'Em análise',
  'Active - Under development': 'Em desenvolvimento',
  'Active - Awaiting release package': 'Aguardando pacote',
  'Active - Sales analysis': 'Análise comercial',
  'Active - Package available': 'Pacote disponível',
  'Active - Spec in progress': 'Em especificação',
  'Blocked - Pending customer': 'Pendente cliente',
  'Blocked - Suspended': 'Suspenso',
  'Resolved - Awaiting acceptance - hml': 'Em homologação',
  'Resolved - Awaiting acceptance - prd': 'Em produção',
  'Resolved - Awaiting deployment - hml': 'Aguardando pub. HML',
  'Resolved - Awaiting deployment - prd': 'Aguardando pub. PRD',
  'Resolved - Temporary solution applied': 'Solução contorno',
  'Closed - Function Point Analysis sent': 'APF enviada',
  'Closed - No customer response': 'Cliente não retornou',
  'Closed - Resolved': 'Resolvido',
  'Closed - In analysis activate': 'Reabertura em análise',
  'Canceled': 'Cancelado',
};

const CASETYPE_LABELS: Record<string, string> = {
  Request: 'Solicitação',
  Question: 'Dúvida',
  Problem: 'Falha',
  'Feature Request': 'Melhoria',
  'Infrastructure - Customer': 'Infra - Cliente',
};

/* ── Tooltip HTML externo (evita bug de renderização do tooltip nativo do Chart.js
   em canvas, onde cornerRadius/borderWidth às vezes não fecham um dos lados) ── */
function externalTooltipHandler(context: any) {
  const { chart, tooltip } = context;
  let tooltipEl = document.getElementById('chartjs-tooltip-ext') as HTMLDivElement | null;
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'chartjs-tooltip-ext';
    tooltipEl.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'background:#1e293b',
      `border:1px solid ${ACCENT_ORANGE}`,
      'border-radius:8px',
      'padding:8px 10px',
      'font-family:"DM Sans",sans-serif',
      'font-size:11px',
      'color:#fff',
      'z-index:9999',
      'box-shadow:0 4px 14px rgba(0,0,0,0.28)',
      'transition:opacity .1s ease',
      'white-space:nowrap',
      'opacity:0',
    ].join(';');
    document.body.appendChild(tooltipEl);
  }

  if (!tooltip || tooltip.opacity === 0) {
    tooltipEl.style.opacity = '0';
    return;
  }

  const titleLines: string[] = tooltip.title || [];
  const bodyLines: string[][] = tooltip.body.map((b: any) => b.lines);

  let html = '';
  titleLines.forEach((t: string) => {
    html += `<div style="font-weight:600;font-size:12px;margin-bottom:4px;">${t}</div>`;
  });
  tooltip.dataPoints.forEach((_dp: any, i: number) => {
    const colors = tooltip.labelColors[i];
    html += `<div style="display:flex;align-items:center;gap:6px;">`
      + `<span style="width:9px;height:9px;flex-shrink:0;border-radius:2px;background:${colors.backgroundColor};border:1px solid rgba(255,255,255,.4);"></span>`
      + `<span>${bodyLines[i]}</span>`
      + `</div>`;
  });
  tooltipEl.innerHTML = html;

  const rect = chart.canvas.getBoundingClientRect();
  tooltipEl.style.opacity = '1';
  tooltipEl.style.left = `${rect.left + tooltip.caretX}px`;
  tooltipEl.style.top = `${rect.top + tooltip.caretY}px`;
  tooltipEl.style.transform = 'translate(-50%, -115%)';
}

/* ── Shared doughnut options (no legend, no datalabels on slices) ── */
function doughnutOpts(): any {
  return {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '68%',
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: false,
        external: externalTooltipHandler,
        callbacks: {
          label: (ctx: any) => {
            const sum = ctx.dataset.data.reduce((a: number, b: number) => a + b, 0);
            const pct = ((ctx.raw / sum) * 100).toFixed(1);
            return `  ${ctx.raw} chamados (${pct}%)`;
          },
          labelColor: (ctx: any) => {
            const meta = ctx.chart.getDatasetMeta(ctx.datasetIndex);
            const style = meta.controller.getStyle(ctx.dataIndex, true);
            return {
              backgroundColor: style.backgroundColor,
              borderColor: 'rgba(0,0,0,0.25)',
              borderWidth: 1,
              borderRadius: 0,
            };
          },
        },
      },
      datalabels: { display: false },
    },
  };
}

/* Center text plugin for doughnut */
const centerTextPlugin = {
  id: 'centerText',
  beforeDraw(chart: any) {
    const { ctx, width, height } = chart;
    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data.length) return;
    const sum = chart.data.datasets[0].data.reduce((a: number, b: number) => a + b, 0);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = width / 2;
    const cy = height / 2;
    ctx.font = '600 22px "DM Sans", sans-serif';
    ctx.fillStyle = '#0f1117';
    ctx.fillText(sum.toLocaleString('pt-BR'), cx, cy - 8);
    ctx.font = '500 11px "DM Sans", sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('chamados', cx, cy + 12);
    ctx.restore();
  },
};

function ChartsGrid({
  data, total, singleClient,
  activeCategory, activeStatuses, activeClients, activeMonth, activeModulo,
  onCategoryClick, onStatusClick, onClientClick, onMonthClick, onModuloClick,
}: {
  data: any; total: number; singleClient: string | null;
  activeCategory: string[]; activeStatuses: string[]; activeClients: string[]; activeMonth: string; activeModulo: string;
  onCategoryClick: (cat: string) => void;
  onStatusClick: (st: string) => void;
  onClientClick: (cl: string) => void;
  onMonthClick: (m: string) => void;
  onModuloClick: (m: string) => void;
}) {
  /* ── Expandir listas sob demanda (top 7 por padrão em todos os 4 cards) ── */
  const [expandCategoria, setExpandCategoria] = useState(false);
  const [expandStatus, setExpandStatus] = useState(false);
  const [expandCliente, setExpandCliente] = useState(false);
  const [expandModulo, setExpandModulo] = useState(false);
  const TOP_N = 7;

  /* ── 1. Categoria ── */
  const catLabels = data.categoria.map((d: any) => d.label);
  const catValues = data.categoria.map((d: any) => d.value);
  const catRawColors = chartColors(catLabels.length);
  // Sem dimming — cores plenas sempre; seleção indicada apenas na legenda
  const catData = {
    labels: catLabels.map((l: string) => fmt(l)),
    datasets: [{ data: catValues, backgroundColor: catRawColors, borderWidth: 2, borderColor: '#ffffff', hoverBorderColor: ACCENT_ORANGE, hoverBorderWidth: 2, hoverOffset: 6 }],
  };

  /* ── 2. Case Status ── */
  const csLabels = (data.caseStatus || []).map((d: any) => d.label);
  const csValues = (data.caseStatus || []).map((d: any) => d.value);
  const csRawColors = chartColors(csLabels.length);
  const csHasActive = activeStatuses.length > 0;
  // Sem dimming — cores plenas sempre
  const csData = {
    labels: csLabels.map((l: string) => STATUS_LABELS[l] || l),
    datasets: [{ data: csValues, backgroundColor: csRawColors, borderWidth: 2, borderColor: '#ffffff', hoverBorderColor: ACCENT_ORANGE, hoverBorderWidth: 2, hoverOffset: 6 }],
  };

  /* ── 3. Cliente Ranking (funnel) ── */
  const crData = (data.clienteRanking || []);
  const crLabels = crData.map((d: any) => d.label);
  const crValues = crData.map((d: any) => d.value);
  const crMax = crValues[0] || 1;
  const crRawColors = chartColors(crLabels.length);
  const crHasActive = activeClients.length > 0;

  /* ── 3b. Módulo Ranking ── */
  const modData = (data.moduloRanking || []);
  const modLabels = modData.map((d: any) => d.label);
  const modValues = modData.map((d: any) => d.value);
  const modMax = modValues[0] || 1;
  const modRawColors = chartColors(modLabels.length);

  /* ── 4. Timeline (bar chart por mês) ── */
  const tlData = (data.timeline || []);
  const tlRawLabels = tlData.map((d: any) => d.label as string); // yyyy-MM
  const tlLabels = tlData.map((d: any) => {
    const [y, m] = (d.label || '').split('-');
    const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    return months[parseInt(m, 10) - 1] + '/' + (y?.slice(2) || '');
  });
  const tlValues = tlData.map((d: any) => d.value);
  const tlBarColors = chartColors(tlLabels.length);
  const tlActiveIdx = activeMonth ? tlRawLabels.indexOf(activeMonth) : -1;
  const tlBgColors = tlBarColors.map((c: string, i: number) => (tlActiveIdx === -1 || i === tlActiveIdx ? c : c + '55'));

  const timelineBarData = {
    labels: tlLabels,
    datasets: [{
      data: tlValues,
      backgroundColor: tlBgColors,
      borderColor: tlRawLabels.map((_: string, i: number) => (i === tlActiveIdx ? ACCENT_ORANGE : 'transparent')),
      borderWidth: 2,
      borderRadius: 4,
      maxBarThickness: 28,
    }],
  };

  const timelineBarOpts: any = {
    responsive: true,
    maintainAspectRatio: false,
    layout: { padding: { top: 24 } },
    onClick: (_e: any, elements: any[]) => { if (elements.length > 0) onMonthClick(tlRawLabels[elements[0].index]); },
    onHover: (e: any, elements: any[]) => { e.native.target.style.cursor = elements.length > 0 ? 'pointer' : 'default'; },
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: false,
        external: externalTooltipHandler,
        callbacks: {
          label: (ctx: any) => `  ${ctx.raw} chamados`,
          labelColor: (ctx: any) => ({
            backgroundColor: tlBarColors[ctx.dataIndex],
            borderColor: 'rgba(0,0,0,0.25)',
            borderWidth: 1,
            borderRadius: 0,
          }),
        },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { font: { family: '"DM Sans", sans-serif', size: 10 }, color: '#94a3b8' } },
      y: { beginAtZero: true, grid: { color: '#f0f2f5' }, ticks: { display: false } },
    },
  };

  /* ── Donut click via Chart.js options (more reliable than React prop on canvas) ── */
  const catOpts = {
    ...doughnutOpts(),
    onClick: (_e: any, elements: any[]) => { if (elements.length > 0) onCategoryClick(catLabels[elements[0].index]); },
  };
  const csOpts = {
    ...doughnutOpts(),
    onClick: (_e: any, elements: any[]) => { if (elements.length > 0) onStatusClick(csLabels[elements[0].index]); },
  };

  const donutCharts = [
    {
      title: 'Distribuição por Categoria',
      chartData: catData,
      opts: catOpts,
      rawLabels: catLabels,
      rawColors: catRawColors,
      values: catValues,
      isActive: (i: number) => activeCategory.includes(catLabels[i]),
      onLegendClick: onCategoryClick,
      expand: expandCategoria,
      setExpand: setExpandCategoria,
    },
    {
      title: 'Status Ecossistema',
      chartData: csData,
      opts: csOpts,
      rawLabels: csLabels,
      rawColors: csRawColors,
      values: csValues,
      isActive: (i: number) => activeStatuses.includes(csLabels[i]),
      onLegendClick: onStatusClick,
      expand: expandStatus,
      setExpand: setExpandStatus,
    },
  ];

  return (
    <div className="grid grid-cols-4 gap-3 mb-6 max-[1400px]:grid-cols-2 max-[640px]:grid-cols-1">
      {donutCharts.map((c) => {
        const sum = c.values.reduce((a: number, b: number) => a + b, 0) || 1;
        const total = c.chartData.labels.length;
        const visibleLabels = c.expand ? c.chartData.labels : c.chartData.labels.slice(0, TOP_N);
        return (
          <div key={c.title} className="bg-surface border border-border rounded-xl shadow-sm p-4 transition-shadow hover:shadow-md flex flex-col">
            <h3 className="text-[11px] font-semibold tracking-[.08em] uppercase text-txt-3 mb-2">{c.title}</h3>
            <div className="flex items-start gap-3">
              {/* Doughnut — clíques via options, sempre com todas as fatias */}
              <div className="w-[104px] h-[104px] flex-shrink-0 mt-1 cursor-pointer" title="Clique para filtrar">
                <Doughnut data={c.chartData} options={c.opts} />
              </div>
              {/* Legend — top 7 por padrão, com 'Ver todos' quando houver mais */}
              <div className="flex-1 min-w-0">
                <div className={`overflow-y-auto pr-1 ${c.expand ? 'max-h-[400px]' : ''}`}>
                  {visibleLabels.map((label: string, i: number) => {
                    const pct = ((c.values[i] / sum) * 100).toFixed(0);
                    const active = c.isActive(i);
                    return (
                      <div
                        key={label}
                        onClick={() => c.onLegendClick(c.rawLabels[i])}
                        title="Clique para filtrar"
                        style={{ borderLeft: `3px solid ${c.rawColors[i]}` }}
                        className={`flex items-center gap-1.5 py-[3px] pl-[6px] pr-[4px] mb-[1px] rounded-r-md text-[11px] leading-tight cursor-pointer transition-all ${
                          active ? 'bg-[#e8f0ff]' : 'hover:bg-surface-2'
                        }`}
                      >
                        <span className={`flex-1 min-w-0 truncate ${active ? 'text-[#0b3ea8] font-semibold' : 'text-txt-2'}`}>{label}</span>
                        <span className={`font-semibold tabular-nums w-[26px] text-right ${active ? 'text-[#0b3ea8]' : 'text-txt'}`}>{c.values[i]}</span>
                        <span className="text-txt-3 tabular-nums w-[28px] text-right">{pct}%</span>
                      </div>
                    );
                  })}
                </div>
                {total > TOP_N && (
                  <button
                    onClick={() => c.setExpand((v: boolean) => !v)}
                    className="mt-1 text-[11px] font-medium text-[#1d4ed8] hover:underline cursor-pointer"
                  >
                    {c.expand ? 'Ver menos' : `Ver todos (${total})`}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* ── 3rd card: Client Funnel OR Timeline ── */}
      <div className="bg-surface border border-border rounded-xl shadow-sm p-4 transition-shadow hover:shadow-md flex flex-col">
        {singleClient ? (
          <>
            <h3 className="text-[11px] font-semibold tracking-[.08em] uppercase text-txt-3 mb-2">
              Timeline – {singleClient}
            </h3>
            <div className="flex-1 min-w-0 relative" style={{ height: 240 }}>
              {tlData.length > 0 ? (
                <Bar key={singleClient} data={timelineBarData} options={timelineBarOpts} plugins={[barValueLabels]} />
              ) : (
                <div className="flex items-center justify-center h-full text-txt-3 text-[13px]">Sem dados de abertura</div>
              )}
            </div>
          </>
        ) : (
          <>
            <h3 className="text-[11px] font-semibold tracking-[.08em] uppercase text-txt-3 mb-2">Melhorias por Cliente</h3>
            <div className={`flex-1 min-w-0 overflow-y-auto pr-1 space-y-[4px] ${expandCliente ? 'max-h-[420px]' : ''}`}>
              {(expandCliente ? crLabels : crLabels.slice(0, TOP_N)).map((label: string, i: number) => {
                const pct = ((crValues[i] / crMax) * 100);
                const active = activeClients.includes(label);
                return (
                  <div
                    key={label}
                    onClick={() => onClientClick(label)}
                    title="Clique para filtrar por cliente"
                    className={`flex items-center gap-1.5 text-[11px] leading-tight cursor-pointer rounded-md px-[5px] py-[2px] transition-all ${
                      active ? 'bg-[#e8f0ff] ring-1 ring-[#c7d9ff]' : 'hover:bg-surface-2'
                    }`}
                  >
                    <span className={`w-[74px] min-w-[74px] truncate text-right uppercase text-[10px] font-medium tracking-wide ${active ? 'text-[#0b3ea8]' : 'text-txt-2'}`} title={label}>{label}</span>
                    <div className="flex-1 h-[13px] bg-[#f0f2f5] rounded-sm overflow-hidden">
                      <div
                        className="h-full rounded-sm transition-all duration-300"
                        style={{ width: `${Math.max(pct, 3)}%`, background: active ? '#1d4ed8' : crRawColors[i] }}
                      />
                    </div>
                    <span className={`font-semibold tabular-nums w-[24px] text-right ${active ? 'text-[#0b3ea8]' : 'text-txt'}`}>{crValues[i]}</span>
                  </div>
                );
              })}
            </div>
            {crLabels.length > TOP_N && (
              <button
                onClick={() => setExpandCliente(v => !v)}
                className="mt-1.5 text-[11px] font-medium text-[#1d4ed8] hover:underline cursor-pointer self-start"
              >
                {expandCliente ? 'Ver menos' : `Ver todos (${crLabels.length})`}
              </button>
            )}
          </>
        )}
      </div>

      {/* ── 4th card: Distribuição por Módulo ── */}
      <div className="bg-surface border border-border rounded-xl shadow-sm p-4 transition-shadow hover:shadow-md flex flex-col">
        <h3 className="text-[11px] font-semibold tracking-[.08em] uppercase text-txt-3 mb-2">Distribuição por Módulo</h3>
        <div className={`flex-1 min-w-0 overflow-y-auto pr-1 space-y-[4px] ${expandModulo ? 'max-h-[420px]' : ''}`}>
          {modLabels.length === 0 && (
            <div className="flex items-center justify-center h-full text-txt-3 text-[13px]">Sem dados de módulo</div>
          )}
          {(expandModulo ? modLabels : modLabels.slice(0, TOP_N)).map((label: string, i: number) => {
            const pct = ((modValues[i] / modMax) * 100);
            const active = activeModulo === label;
            return (
              <div
                key={label}
                onClick={() => onModuloClick(label)}
                title="Clique para filtrar por módulo"
                className={`flex items-center gap-1.5 text-[11px] leading-tight cursor-pointer rounded-md px-[5px] py-[2px] transition-all ${
                  active ? 'bg-[#e8f0ff] ring-1 ring-[#c7d9ff]' : 'hover:bg-surface-2'
                }`}
              >
                <span className={`w-[74px] min-w-[74px] truncate text-right uppercase text-[10px] font-medium tracking-wide ${active ? 'text-[#0b3ea8]' : 'text-txt-2'}`} title={label}>{label}</span>
                <div className="flex-1 h-[13px] bg-[#f0f2f5] rounded-sm overflow-hidden">
                  <div
                    className="h-full rounded-sm transition-all duration-300"
                    style={{ width: `${Math.max(pct, 3)}%`, background: active ? '#1d4ed8' : modRawColors[i] }}
                  />
                </div>
                <span className={`font-semibold tabular-nums w-[24px] text-right ${active ? 'text-[#0b3ea8]' : 'text-txt'}`}>{modValues[i]}</span>
              </div>
            );
          })}
        </div>
        {modLabels.length > TOP_N && (
          <button
            onClick={() => setExpandModulo(v => !v)}
            className="mt-1.5 text-[11px] font-medium text-[#1d4ed8] hover:underline cursor-pointer self-start"
          >
            {expandModulo ? 'Ver menos' : `Ver todos (${modLabels.length})`}
          </button>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   Multi-select dropdown (prototype style)
   ═══════════════════════════════════════════ */
function MultiSelect({ label, options, selected, onChange, displayFn }: {
  label: string; options: string[]; selected: string[]; onChange: (v: string[]) => void; displayFn?: (v: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const display = displayFn || ((v: string) => v);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  const filtered = query
    ? options.filter(o => display(o).toLowerCase().includes(query.toLowerCase()))
    : options;

  const allSelected = selected.length === 0;

  const toggle = (val: string) => {
    if (selected.includes(val)) onChange(selected.filter(s => s !== val));
    else onChange([...selected, val]);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="h-9 min-w-[130px] flex items-center justify-between gap-2 px-3 border border-border rounded-sm bg-bg text-[13px] focus-ring transition-[border-color,box-shadow] duration-150"
        aria-expanded={open}
      >
        <span className={selected.length > 0 ? 'text-txt' : 'text-txt-3'}>
          {selected.length > 0 ? `${label} (${selected.length})` : label}
        </span>
        <svg className="w-3 h-3 text-txt-3" fill="none" stroke="currentColor" viewBox="0 0 12 12">
          <path d="M3 5l3 3 3-3" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-[calc(100%+6px)] left-0 w-[280px] max-h-[280px] overflow-auto bg-surface border border-border rounded-sm shadow p-1.5 z-10">
          <input
            autoFocus
            placeholder="Buscar cliente..."
            className="w-full h-[30px] mb-1.5 px-2 border border-border rounded-sm text-[12px] focus-ring"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {/* Todos */}
          <label className="flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer hover:bg-[#f4f8ff] border-b border-border mb-1 pb-2 font-semibold text-[13px]">
            <input
              type="checkbox"
              className="w-[14px] h-[14px]"
              checked={allSelected}
              onChange={() => onChange([])}
            />
            Todos
          </label>
          {filtered.map(opt => (
            <label
              key={opt}
              className="flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer hover:bg-[#f4f8ff] text-[13px]"
            >
              <input
                type="checkbox"
                className="w-[14px] h-[14px]"
                checked={selected.includes(opt)}
                onChange={() => toggle(opt)}
              />
              {display(opt)}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
