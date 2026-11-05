import { useEffect, useId, useState } from 'react'
import { api } from './api.ts'
import Sheet from './Sheet.tsx'
import { t, formatDate } from './i18n.ts'
import { useDialog } from './dialog.tsx'

export type MealieStatus = { connected: boolean; url: string | null; groupSlug: string | null; lastSyncedAt: string | null; lastError: string | null }
export default function MealieSheet({ from, to, onClose, onSynced }: { from: string; to: string; onClose: () => void; onSynced: () => void }) {
  const id = useId(), dialog = useDialog()
  const [status, setStatus] = useState<MealieStatus | null>(null)
  const [url, setUrl] = useState(''), [groupSlug, setGroupSlug] = useState('home'), [token, setToken] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const load = async () => { const value = await api.getMealie(); setStatus(value); setUrl(value.url ?? ''); setGroupSlug(value.groupSlug ?? 'home') }
  useEffect(() => { let canceled = false; api.getMealie().then(value => { if (!canceled) { setStatus(value); setUrl(value.url ?? ''); setGroupSlug(value.groupSlug ?? 'home') } }).catch(e => { if (!canceled) setError(e.message) }); return () => { canceled = true } }, [])
  const act = async (work: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await work() } catch (e) { setError(e instanceof Error ? e.message : t('Could not connect Mealie.')) } finally { setBusy(false) } }
  const disconnect = async () => {
    if (!await dialog.confirm({ title: t('Disconnect Mealie?'), body: t('Imported meals stay in Kinwall. Future changes in Mealie will no longer update them.'), confirmLabel: t('Disconnect') })) return
    await act(async () => { await api.disconnectMealie(); setToken(''); await load(); onSynced() })
  }
  return <Sheet title={t('Mealie connection')} onClose={onClose} dismissable={!busy} dirty={!!token}>
    <p className="field-hint">{t('Bring planned meals into Kinwall, or choose a Mealie recipe when planning a meal. Ingredients and instructions stay in Mealie.')}</p>
    <p className="field-hint">{t('Mealie controls meal names, dates and slots. Kinwall keeps your notes, cook and cooked status. Changes here are never sent to Mealie.')}</p>
    {error && <p role="alert" className="field-error">{error}</p>}
    {!status && !error && <p role="status">{t('Loading…')}</p>}
    {!status && error && <button className="btn btn-secondary" onClick={() => void act(load)} disabled={busy}>{t('Retry')}</button>}
    {status && <>
      <form onSubmit={e => { e.preventDefault(); void act(async () => { await api.saveMealie({ url, groupSlug, ...(token && { token }) }); setToken(''); await load(); setMessage(t('Mealie connection saved. Sync your meals next.')) }) }}>
        <div className="field"><label htmlFor={`${id}-url`}>{t('Mealie address')}</label><input id={`${id}-url`} type="url" required maxLength={2000} value={url} disabled={busy || status.connected} onChange={e => setUrl(e.target.value)} placeholder={t('https://mealie.example')} /></div>
        <div className="field"><label htmlFor={`${id}-group`}>{t('Mealie group URL name')}</label><input id={`${id}-group`} required maxLength={100} pattern="[a-zA-Z0-9_-]+" value={groupSlug} disabled={busy || status.connected} onChange={e => setGroupSlug(e.target.value)} /><p className="field-hint">{t('The part after /g/ in a Mealie recipe link, for example home in /g/home/r/pasta. The API token chooses the household.')}</p></div>
        <div className="field"><label htmlFor={`${id}-token`}>{status.connected ? t('New API token (optional)') : t('Mealie API token')}</label><input id={`${id}-token`} type="password" autoComplete="new-password" required={!status.connected} maxLength={4096} value={token} disabled={busy} onChange={e => setToken(e.target.value)} /><p className="field-hint">{t('Create an API token in your Mealie profile. Kinwall stores it encrypted and never shows it again.')}</p></div>
        <button className="btn btn-primary" type="submit" disabled={busy}>{t('Save connection')}</button>
      </form>
      {status.connected && <section>
        <p className="field-hint">{t('Automatic sync checks the past 7 days and next 35 days about every 15 minutes. Sync now refreshes the dates currently shown in Meals.')}</p>
        {status.lastSyncedAt && <p>{t('Last Mealie sync: {time}', { time: formatDate(new Date(status.lastSyncedAt), { dateStyle: 'short', timeStyle: 'short' }) })}</p>}
        {status.lastError && <p role="status" className="field-error">{status.lastError}</p>}
        <button className="btn btn-secondary" disabled={busy} onClick={() => void act(async () => { const result = await api.syncMealie(from, to); await load(); onSynced(); setMessage(t('Mealie synced: {updated} added or updated, {removed} removed.', { updated: result.imported, removed: result.removed })) })}>{busy ? t('Syncing…') : t('Sync now')}</button>
        <div className="sheet-danger-zone"><button className="link-btn link-danger" disabled={busy} onClick={() => void disconnect()}>{t('Disconnect Mealie')}</button></div>
      </section>}
    </>}
    {message && <p role="status">{message}</p>}
  </Sheet>
}
