import { useEffect, useState } from 'react';
import { fetchDocVersions, downloadDocument, getAuditoriaPdfUrl, API_BASE } from '../services/api';
import UserAvatar from './UserAvatar';

interface DocVersion {
  Id: number;
  WorkItemId: number;
  WorkItemTitle: string;
  Tipo: string;
  Versao: number;
  TotalPF: number | null;
  TotalHoras: number | null;
  GeradoPorNome: string | null;
  GeradoPorEmail: string | null;
  CriadoEm: string;
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
    + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

interface Props {
  workItemId: number;
  title: string;
  onClose: () => void;
}

export default function DocHistoryDrawer({ workItemId, title, onClose }: Props) {
  const [versions, setVersions] = useState<DocVersion[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDocVersions(workItemId)
      .then(setVersions)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [workItemId]);

  // Close on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  const apf = versions.filter(v => v.Tipo === 'APF');
  const spec = versions.filter(v => v.Tipo === 'SPEC');
  const specDocx = versions.filter(v => v.Tipo === 'SPEC_DOCX');

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* backdrop */}
      <div className="flex-1 bg-black/30" onClick={onClose} />

      {/* panel */}
      <div className="w-[460px] h-full bg-white shadow-2xl flex flex-col overflow-hidden">
        {/* header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-border bg-surface">
          <div>
            <p className="text-[10px] font-semibold text-txt-3 uppercase tracking-wide mb-0.5">Histórico de documentos</p>
            <p className="text-[13px] font-semibold text-txt leading-snug">
              <span className="font-mono text-txt-3 mr-1">#{workItemId}</span>{title}
            </p>
          </div>
          <button
            onClick={onClose}
            className="mt-0.5 w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-2 text-txt-3 hover:text-txt text-lg font-medium shrink-0"
          >
            ×
          </button>
        </div>

        {/* content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <p className="text-[13px] text-txt-3 animate-pulse">Carregando versões…</p>
          )}

          {!loading && apf.length === 0 && spec.length === 0 && specDocx.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
              </svg>
              <p className="text-[13px] text-txt-3">Nenhum documento gerado ainda.</p>
              <p className="text-[12px] text-txt-3/70">Peça à PATi para gerar APF ou Especificação.</p>
            </div>
          )}

          {[
            { label: 'APF', icon: '🟠', items: apf },
            { label: 'SPEC', icon: '🔵', items: spec },
            { label: 'ESPECIFICAÇÃO (Word)', icon: '📘', items: specDocx },
          ].map(({ label, icon, items }) =>
            items.length > 0 ? (
              <div key={label} className="mb-5">
                <p className="text-[11px] font-semibold text-txt-2 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                  <span>{icon}</span>{label} · {items.length} {items.length !== 1 ? 'versões' : 'versão'}
                  {label === 'APF' && (
                    <button
                      onClick={e => { e.stopPropagation(); downloadDocument(getAuditoriaPdfUrl(workItemId), `auditoria-apf-${workItemId}.pdf`).catch(err => alert(err.message)); }}
                      title="Baixar Auditoria da Comunicação (PDF) — trilha completa, sempre atualizada"
                      className="ml-auto flex items-center gap-1 text-[10px] normal-case font-medium text-[#b45309] hover:text-[#92400e] cursor-pointer"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                      Auditoria (PDF)
                    </button>
                  )}
                </p>
                <div className="space-y-2">
                  {items.map((v, i) => (
                    <div
                      key={v.Id}
                      className={`border border-border rounded-lg p-3 transition-colors ${i === 0 ? 'bg-[#f0f6ff] border-[#bfdbfe]' : 'bg-surface hover:bg-surface-2'}`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex items-center justify-center h-5 px-2 rounded text-[10px] font-bold tracking-wide ${i === 0 ? 'bg-[#1d4ed8] text-white' : 'bg-[#e0e7ff] text-[#3730a3]'}`}>
                            v{v.Versao}
                          </span>
                          {i === 0 && <span className="text-[10px] text-[#1d4ed8] font-bold">ATUAL</span>}
                          {v.TotalPF != null && (
                            <span className="text-[12px] font-semibold text-[#1d4ed8]">{v.TotalPF} PF</span>
                          )}
                          {v.TotalHoras != null && (
                            <span className="text-[11px] text-txt-3">· {v.TotalHoras}h</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {/* Download links — APF só existe em Excel hoje (PDF removido: a
                              memória de cálculo e a trilha de auditoria que antes só existiam
                              no PDF agora vêm em abas dedicadas do próprio Excel). */}
                          {v.Tipo === 'APF' ? (
                            <button
                              onClick={e => { e.stopPropagation(); downloadDocument(`${API_BASE}/documents/${workItemId}/versions/${v.Id}/download`, `apf-${workItemId}-v${v.Versao}.xlsx`).catch(err => alert(err.message)); }}
                              title={`Baixar APF v${v.Versao} (Excel)`}
                              className="flex items-center gap-1 text-[11px] text-[#16a34a] hover:text-[#166534] font-medium cursor-pointer"
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                              </svg>
                              XLSX
                            </button>
                          ) : (
                            <button
                              onClick={e => { e.stopPropagation(); const ext = v.Tipo === 'SPEC_DOCX' ? 'docx' : 'pdf'; downloadDocument(`${API_BASE}/documents/${workItemId}/versions/${v.Id}/download`, `${v.Tipo.toLowerCase()}-${workItemId}-v${v.Versao}.${ext}`).catch(err => alert(err.message)); }}
                              title={`Baixar ${v.Tipo} v${v.Versao} (${v.Tipo === 'SPEC_DOCX' ? 'Word' : 'PDF'})`}
                              className="flex items-center gap-1 text-[11px] text-[#1d4ed8] hover:text-[#1e40af] font-medium cursor-pointer"
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                              </svg>
                              {v.Tipo === 'SPEC_DOCX' ? 'DOCX' : 'PDF'}
                            </button>
                          )}
                          <span className="text-[11px] text-txt-3 shrink-0">{fmtDate(v.CriadoEm)}</span>
                        </div>
                      </div>

                      {v.GeradoPorNome ? (
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <UserAvatar nome={v.GeradoPorNome} email={v.GeradoPorEmail} size={20} />
                          <span className="text-[12px] text-txt-2">{v.GeradoPorNome}</span>
                          {v.GeradoPorEmail && (
                            <span className="text-[11px] text-txt-3 truncate">({v.GeradoPorEmail})</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-[11px] text-txt-3 italic mt-1 block">gerado sem usuário identificado</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : null
          )}
        </div>

        {/* footer total */}
        {versions.length > 0 && (
          <div className="px-5 py-3 border-t border-border bg-surface-2 text-[11px] text-txt-3">
            {versions.length} versão{versions.length !== 1 ? 'ões' : ''} registrada{versions.length !== 1 ? 's' : ''} no total
          </div>
        )}
      </div>
    </div>
  );
}
