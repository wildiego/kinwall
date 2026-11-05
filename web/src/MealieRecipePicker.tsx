import { useEffect, useId, useState } from 'react'
import { api } from './api.ts'
import { t } from './i18n.ts'

export type MealieRecipe = { id: string; name: string; sourceUrl: string }
export default function MealieRecipePicker({ onPick }: { onPick: (recipe: MealieRecipe) => void }) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<{ items: MealieRecipe[]; totalPages: number } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let canceled = false
    api.mealieRecipes(search, page).then(value => { if (!canceled) { setResult(value); setBusy(false) } }).catch(e => { if (!canceled) { setError(e.message); setBusy(false) } })
    return () => { canceled = true }
  }, [search, page, retry])
  const load = (nextPage: number) => { setBusy(true); setResult(null); setError(''); setPage(nextPage) }
  return <div>
    <div className="field"><label htmlFor={id}>{t('Search Mealie recipes')}</label><input id={id} type="search" maxLength={200} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); load(1); setSearch(query.trim()); setRetry(n => n + 1) } }} /></div>
    <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { load(1); setSearch(query.trim()); setRetry(n => n + 1) }}>{t('Search')}</button>
    <p className="field-hint">{t('Choose a recipe to plan it in Kinwall. Open its link in Mealie for ingredients and instructions.')}</p>
    {busy && <p role="status">{t('Loading…')}</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" className="btn btn-secondary" onClick={() => { load(page); setRetry(n => n + 1) }}>{t('Try again')}</button></div>}
    {result && <>
      {result.items.length ? <div className="sheet-links">{result.items.map(r => <button key={r.id} type="button" className="sheet-link" onClick={() => onPick(r)}><span>{r.name}</span></button>)}</div> : <p role="status">{t('No Mealie recipes found.')}</p>}
      <div className="meal-actions">
        <button type="button" className="btn btn-secondary" disabled={page <= 1} onClick={() => load(page - 1)}>{t('Previous')}</button>
        <span>{t('Page {page} of {total}', { page, total: Math.max(1, result.totalPages) })}</span>
        <button type="button" className="btn btn-secondary" disabled={page >= result.totalPages} onClick={() => load(page + 1)}>{t('Next')}</button>
      </div>
    </>}
  </div>
}
