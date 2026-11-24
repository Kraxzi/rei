import { startRegistration } from '@simplewebauthn/browser';
import { useEffect, useState } from 'react';
import { api, type User } from '../api';
import { ErrorBox, Page } from '../ui';

interface Passkey { id: string; name: string | null; created_at: string; last_used_at: string | null }
interface InviteRow { role: string; note: string | null; expires_at: string; used_at: string | null; used_by_name: string | null; created_at: string }

const date = (s: string | null) => (s ? new Date(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');

export function More({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [keys, setKeys] = useState<Passkey[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [newCode, setNewCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canInvite = user.role === 'owner' || user.role === 'admin';

  const load = () => {
    api<Passkey[]>('/auth/passkeys').then(setKeys, (e: Error) => setError(e.message));
    if (canInvite) api<InviteRow[]>('/auth/invites').then(setInvites, () => undefined);
  };
  useEffect(load, [canInvite]);

  async function addDevice() {
    setBusy(true); setError(null);
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>('/auth/passkeys/options', { method: 'POST' });
      const response = await startRegistration({ optionsJSON: options });
      await api('/auth/register/verify', { method: 'POST', body: { challengeId, response, name: navigator.userAgent.includes('Android') ? 'Android' : 'Устройство' } });
      load();
    } catch (e) {
      setError((e as Error).name === 'InvalidStateError' ? 'Это устройство уже добавлено.' : `Не добавлено: ${(e as Error).message}`);
    } finally { setBusy(false); }
  }

  async function removeKey(id: string) {
    if (!confirm('Убрать этот ключ входа? С этого устройства больше не получится войти.')) return;
    try { await api(`/auth/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' }); load(); } catch (e) { setError((e as Error).message === 'cannot remove the last passkey' ? 'Нельзя убрать последний ключ — иначе войти будет нечем.' : (e as Error).message); }
  }

  async function createInvite() {
    setError(null);
    try {
      setNewCode(await api<{ code: string; expiresAt: string }>('/auth/invites', { method: 'POST', body: { role: 'user', note: note || undefined } }));
      setNote('');
      load();
    } catch (e) { setError((e as Error).message); }
  }

  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    onLogout();
    location.hash = '/';
  }

  return (
    <Page title="Ещё">
      <ErrorBox error={error} />

      <ul className="list">
        <li><a href="#/sources"><div><div className="title">Источники</div><div className="sub">Найденные агентства, проверка и подключение</div></div></a></li>
      </ul>

      <h2>Устройства для входа</h2>
      <ul className="list">
        {keys.map((k) => (
          <li key={k.id}>
            <div>
              <div>
                <div className="title">{k.name ?? 'Ключ входа'}</div>
                <div className="sub">Добавлен {date(k.created_at)}{k.last_used_at ? `, последний вход ${date(k.last_used_at)}` : ''}</div>
              </div>
              <button className="btn danger small" onClick={() => removeKey(k.id)} disabled={keys.length <= 1}>Убрать</button>
            </div>
          </li>
        ))}
      </ul>
      <button className="btn quiet block" onClick={addDevice} disabled={busy}>{busy ? 'Ждём подтверждения…' : 'Добавить это устройство'}</button>

      {canInvite && (
        <>
          <h2>Пригласить человека</h2>
          <p className="muted">Код действует 7 дней и подходит один раз. Отправьте его вместе со ссылкой на приложение.</p>
          {newCode && (
            <div className="group">
              <div className="code-box num">{newCode.code}</div>
              <p className="muted">Действует до {date(newCode.expiresAt)}. Больше этот код нигде не показывается.</p>
              {'share' in navigator && (
                <p><button className="btn quiet block" onClick={() => navigator.share({ text: `Приглашение в REI: ${location.origin}\nКод: ${newCode.code}` }).catch(() => undefined)}>Отправить</button></p>
              )}
            </div>
          )}
          <label className="field">
            <span>Для кого (необязательно)</span>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например, Костя" />
          </label>
          <button className="btn block" onClick={createInvite}>Создать приглашение</button>
          {invites.length > 0 && (
            <ul className="list" style={{ marginTop: 16 }}>
              {invites.map((i) => (
                <li key={i.created_at}>
                  <div>
                    <div>
                      <div className="title">{i.note ?? 'Приглашение'}</div>
                      <div className="sub">{i.used_at ? `Использовано: ${i.used_by_name}` : `Действует до ${date(i.expires_at)}`}</div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <h2>Аккаунт</h2>
      <p className="muted">{user.displayName}, {user.role === 'owner' ? 'владелец' : user.role === 'admin' ? 'администратор' : 'пользователь'}.</p>
      <button className="btn danger block" onClick={logout}>Выйти</button>
    </Page>
  );
}
