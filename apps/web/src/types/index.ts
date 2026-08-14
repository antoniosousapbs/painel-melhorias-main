export interface WorkItem {
  Id: number;
  Title: string;
  DevOpsState: string | null;
  DevOpsAreaPath: string | null;
  DevOpsTags: string | null;
  ClienteNome: string | null;
  CreatedDate: string | null;
  ChangedDate: string | null;
  Categoria: string | null;
  Tipo: string | null;
  Modulo: string | null;
  Prioridade: number | null;
  EsforcoAPF: number | null;
  ImpactoOperacao: string | null;
  ClassificacaoOrigem: string | null;
  ClassificacaoConfianca: number | null;
  ClassificacaoRevisada: boolean;
  AssignedTo: string | null;
  ApfDispensado: boolean;
  ApfDispensadoMotivo: string | null;
  ApfDispensadoPor: string | null;
  ApfDispensadoEm: string | null;
}

export interface Kpis {
  total: number;
  produto: number;
  hibrido: number;
  cliente: number;
  infoInsuficiente: number;
  pctProduto: string;
  pctHibrido: string;
  pctCliente: string;
  totalAPF: number;
  revisados: number;
  classificados: number;
  comApf: number;
  semApf: number;
}

export interface FilterOptions {
  categorias: string[];
  modulos: string[];
  prioridades: string[];
  estados: string[];
  clientes: string[];
  caseTypes: string[];
  responsaveis: string[];
}
