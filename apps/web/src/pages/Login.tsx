import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useState } from 'react';
import { api, ApiError, type Me } from '../api';
import { ErrorBox } from '../ui';

const ERRORS: Record<string, string> = {
  'invalid code': 'Код не подошёл. Проверьте его и попробуйте ещё раз.',
  'invalid or expired invite': 'Приглашение не найдено или уже использовано. Попросите новое.',
  'bootstrap is not configured': 'Первый вход ещё не настроен: в секретах сервера нет кода BOOTSTRAP_CODE.',
  'unknown passkey': 'Этот ключ входа не зарегистрирован. Войдите по приглашению.',
};

function explain(e: unknown): string {
  if (e instanceof ApiError) return ERRORS[e.message] ?? `Ошибка сервера: ${e.message}`;
  if (e instanceof Error && e.name === 'NotAllowedError') return 'Вход отменён. Нажмите кнопку ещё раз и приложите палец.';
  return e instanceof Error ? e.message : String(e);
}

export function Login({ me, onDone }: { me: Me; onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>(me.needsBootstrap ? 'register' : 'login');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = browserSupportsWebAuthn();

  async function login() {
    setBusy(true); setError(null);
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('/auth/login/options', { method: 'POST' });
      const response = await startAuthentication({ optionsJSON: options });
      await api('/auth/login/verify', { method: 'POST', body: { challengeId, response } });
      onDone();
    } catch (e) { setError(explain(e)); } finally { setBusy(false); }
  }

  async function register() {
    setBusy(true); setError(null);
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>('/auth/register/options', {
        method: 'POST', body: { code, displayName: name },
      });
      const response = await startRegistration({ optionsJSON: options });
      await api('/auth/register/verify', { method: 'POST', body: { challengeId, response, name: 'Этот телефон' } });
      onDone();
    } catch (e) { setError(explain(e)); } finally { setBusy(false); }
  }

  return (
    <div className="gate">
      <div className="gate-inner">
        <img className="roof" src="/icon-192.png" alt="" />
        {!supported && <p className="error">Этот браузер не умеет входить по отпечатку. Откройте приложение в Chrome на Android.</p>}
        {mode === 'login' ? (
          <>
            <h1>Доходная недвижимость</h1>
            <p>Вход по отпечатку пальца или блокировке экрана — без паролей.</p>
            <ErrorBox error={error} />
            <button className="btn block" disabled={busy || !supported} onClick={login}>
              {busy ? 'Ждём подтверждения…' : 'Войти'}
            </button>
            <p style={{ marginTop: 20 }}>
              <button className="link" onClick={() => { setMode('register'); setError(null); }}>У меня есть приглашение</button>
            </p>
          </>
        ) : (
          <>
            <h1>{me.needsBootstrap ? 'Первый вход' : 'Вход по приглашению'}</h1>
            <p>
              {me.needsBootstrap
                ? 'Введите код первого входа. Телефон сохранит ключ, и дальше вход будет по отпечатку.'
                : 'Введите код из приглашения. Телефон сохранит ключ, и дальше вход будет по отпечатку.'}
            </p>
            <ErrorBox error={error} />
            <label className="field">
              <span>Как вас называть</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </label>
            <label className="field">
              <span>{me.needsBootstrap ? 'Код первого входа' : 'Код приглашения'}</span>
              <input className="input num" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoComplete="one-time-code" />
            </label>
            <button className="btn block" disabled={busy || !supported || !code.trim() || !name.trim()} onClick={register}>
              {busy ? 'Ждём подтверждения…' : 'Создать вход по отпечатку'}
            </button>
            {!me.needsBootstrap && (
              <p style={{ marginTop: 20 }}>
                <button className="link" onClick={() => { setMode('login'); setError(null); }}>У меня уже есть вход</button>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
