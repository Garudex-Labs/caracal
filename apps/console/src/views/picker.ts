// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Reusable list-backed picker helpers for Console form fields.

import type { App } from '../screen.ts'
import type { Field } from './form.ts'
import { ListView, type Column } from './list.ts'

export function pickFromList<T>(
  title: string,
  load: () => Promise<T[]>,
  columns: Column<T>[],
  value: (row: T) => string,
  label: (row: T) => string,
  merge?: (current: string, picked: string) => string,
): Field['pick'] {
  return (app: App, setValue: (value: string) => void, currentValue: string) => {
    app.push(new ListView<T>({
      title,
      columns,
      load,
      onEnter: (pickerApp, row) => {
        const picked = value(row)
        setValue(merge ? merge(currentValue, picked) : picked)
        pickerApp.pop()
        pickerApp.setStatus(`selected ${label(row)}`)
      },
    }))
  }
}

export function appendCsv(current: string, picked: string): string {
  const values = current.split(',').map((value) => value.trim()).filter((value) => value.length > 0)
  return values.includes(picked) ? values.join(',') : [...values, picked].join(',')
}
