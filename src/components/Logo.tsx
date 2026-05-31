import clsx from 'clsx'

export function Logo({ className }: { className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center justify-center rounded-lg bg-zinc-900 px-2 py-1 text-sm font-bold text-white dark:bg-emerald-500',
        className,
      )}
    >
      ZB
    </span>
  )
}
