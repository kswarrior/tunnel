import type { ReactNode } from 'react'

type PageHeaderProps = {
  title: string
  action?: ReactNode
}

export function PageHeader({ title, action }: PageHeaderProps) {
  return (
    <header className="page-header">
      <h1 className="page-title">{title}</h1>
      {action ? <div className="page-action">{action}</div> : null}
    </header>
  )
}
