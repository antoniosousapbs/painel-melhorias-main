import { useEffect, useState } from 'react';
import { authFetch } from '../auth/authFetch';
import { API_BASE } from '../services/api';
import { getImagePath } from '../utils/imagePath';

// Cache em memória do processo (sobrevive entre re-renders/instâncias, some ao recarregar
// a página) — evita repetir a mesma chamada ao backend pra cada linha da tabela de Auditoria.
const photoCache = new Map<string, string | null>();

function initials(name: string) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

/** É a identidade "PATi" (a assistente de fato) — não "admin", que é só um rótulo genérico
 * legado sem usuário real associado e não deve ser atribuído visualmente à PATi. */
function isPatiIdentity(nome: string | null): boolean {
  return (nome || '').trim().toLowerCase() === 'pati';
}

interface Props {
  nome: string | null;
  email?: string | null;
  size?: number;
}

/**
 * Avatar de usuário reusado na Auditoria e no histórico de documentos: mostra o mascote
 * OFICIAL da PATi (mesmo sprite usado no chat, `/pati/amigavel.png`, recortado via CSS pra
 * preencher o círculo sem sobras de fundo) apenas para a identidade real "PATi"; para
 * qualquer outro nome (inclusive "admin", rótulo genérico legado sem usuário associado)
 * busca a foto real via proxy no backend (`/api/user-photo`, Graph app-only) e cai pras
 * iniciais coloridas se a foto não existir.
 */
export default function UserAvatar({ nome, email, size = 24 }: Props) {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const isPati = isPatiIdentity(nome);

  useEffect(() => {
    if (isPati || !email) return;
    const cached = photoCache.get(email);
    if (cached !== undefined) { setPhotoUrl(cached); return; }

    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(`${API_BASE}/user-photo?email=${encodeURIComponent(email)}`);
        if (res.ok) {
          const blob = await res.blob();
          const objectUrl = URL.createObjectURL(blob);
          photoCache.set(email, objectUrl);
          if (!cancelled) setPhotoUrl(objectUrl);
        } else {
          photoCache.set(email, null);
        }
      } catch {
        // Backend indisponível, foto ainda não configurada (sem AAD_CLIENT_SECRET) etc.
        photoCache.set(email, null);
      }
    })();
    return () => { cancelled = true; };
  }, [email, isPati]);

  const sizeCls = { width: size, height: size };

  if (isPati) {
    return (
      <div
        className="rounded-full shrink-0 bg-[#0D1117]"
        style={{
          ...sizeCls,
          backgroundImage: `url(${getImagePath('pati/amigavel.png')})`,
          backgroundRepeat: 'no-repeat',
          // Recorte calculado a partir do bounding box real do sprite pra centralizar o
          // rosto (capacete/olhos/sorriso) e cortar as antenas — sem isso, o círculo mostra
          // o sprite inteiro (bem menor que o quadro) sobrando fundo escuro ao redor.
          backgroundSize: '155%',
          backgroundPosition: '50% 60%',
        }}
        role="img"
        aria-label="PATi"
      />
    );
  }

  if (photoUrl) {
    return <img src={photoUrl} alt={nome || ''} className="rounded-full object-cover shrink-0" style={sizeCls} />;
  }

  return (
    <div
      className="rounded-full bg-[#e0e7ff] text-[#3730a3] font-bold flex items-center justify-center shrink-0"
      style={{ ...sizeCls, fontSize: Math.max(9, Math.round(size * 0.42)) }}
    >
      {initials(nome || '?')}
    </div>
  );
}
