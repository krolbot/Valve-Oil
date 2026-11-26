import { useState, type ReactNode } from 'react'
import { CircleCheck, CircleX, Download, ExternalLink, LoaderCircle, Paperclip } from 'lucide-react'
import { Dialog } from '../ui'
import { downloadSupportBundle, openSupportIssue, type ValveOilState } from '../../state/valve-oil'
import { t } from '../../i18n'
import { tr } from '../../i18n/rich'

function Step({ n, icon, children }: { n: number; icon?: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="grid h-6 w-6 flex-none place-items-center rounded-full bg-[var(--hover)] text-[12.5px] font-semibold">{icon ?? n}</span>
      <div className="min-w-0 flex-1 pt-0.5">{children}</div>
    </li>
  )
}

/**
 * Report a problem: downloads the support bundle, then says to attach it before the issue opens. Reports kept coming
 * in without it when the issue opened first and the download landed behind it.
 */
export function ReportRow({ s }: { s: ValveOilState }) {
  const [open, setOpen] = useState(false)

  const start = () => {
    setOpen(true)
    void downloadSupportBundle()
  }

  const name = s.supportBundleName
  const saved = !s.supportPending && !s.supportError && name !== ''

  return (
    <>
      <div className="sep my-2" />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-1">
        <div className="min-w-[180px] flex-1">
          <div className="font-medium">{t('updates.card.report')}</div>
          <div className="text-[12.5px] text-ink-3">{t('updates.card.report_sub')}</div>
        </div>
        <button className="btn btn-sm ml-auto" onClick={start}>
          <ExternalLink size={13} />
          {t('updates.card.open_issue')}
        </button>
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('updates.report.title')}
        footer={
          <>
            <button className="btn" disabled={s.supportPending} onClick={() => void downloadSupportBundle()}>
              <Download size={14} />
              {s.supportError ? t('updates.report.retry') : t('updates.report.again')}
            </button>
            <button
              className="btn btn-primary"
              disabled={s.supportPending}
              onClick={() => {
                openSupportIssue()
                setOpen(false)
              }}
            >
              <ExternalLink size={14} />
              {t('updates.report.open')}
            </button>
          </>
        }
      >
        <div className="grid gap-4">
          <div className="tone-warn flex items-start gap-2.5 rounded-lg px-3 py-2.5">
            <Paperclip size={16} className="mt-0.5 flex-none" />
            <span className="font-medium text-ink">{t('updates.report.needed')}</span>
          </div>
          <ol className="m-0 grid list-none gap-3.5 p-0">
            <Step
              n={1}
              icon={
                s.supportPending ? <LoaderCircle size={14} className="spin" /> : s.supportError ? <CircleX size={15} className="text-bad" /> : saved ? <CircleCheck size={15} className="text-good" /> : undefined
              }
            >
              {s.supportPending
                ? t('updates.report.downloading')
                : s.supportError
                  ? t('updates.card.support_error', { error: s.supportError })
                  : tr('updates.report.saved', { name: <code className="break-all">{name}</code> })}
            </Step>
            <Step n={2}>{t('updates.report.open_step')}</Step>
            <Step n={3}>
              <span className="font-semibold">{tr('updates.report.attach', {}, { b: (c) => <b>{c}</b> })}</span>
              <span className="mt-0.5 block text-[12.5px] text-ink-3">{t('updates.report.reminder')}</span>
            </Step>
          </ol>
        </div>
      </Dialog>
    </>
  )
}
